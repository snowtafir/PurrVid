// ============================================================================
// bilibili-engine.js — B站下载引擎（可读源码 · MAIN world · 根目录）
// ----------------------------------------------------------------------------
//
// 角色：B站页面的解析/下载引擎;非 B站页面委托 universal-panel.js（见 main）。
// 为什么在根目录：共享 ffmpeg 客户端用 import.meta.url 相对解析 vendor/ffmpeg/*，
//   引擎须与 lib/、vendor/ 等资源同在根目录。
//
// 模块划分：
//   1. 常量与状态        2. 通用工具          3. 页面/清晰度探测
//   4. 视频信息获取      5. playurl 解析      6. 下载执行（含共享 ffmpeg）
//   7. 番剧 XHR 钩子     8. 面板样式与模板    9. 面板渲染与交互
//   10. 业务流程与入口
//
// 跨文件契约（勿改）：
//   - import { initUniversalPanel } from "./universal-panel.js"
//   - 面板宿主 id "purrvid-host"（与 content/loader.js 全屏 CSS 共享）
//   - localStorage：purrvid_show / purrvid_download_mode /
//     purrvid_pos / bilibili_player_settings
//   - 资产：lib/paw.js、vendor/ffmpeg/*（均须在 web_accessible_resources）
// ============================================================================

import { initUniversalPanel } from "./universal-panel.js";
import { PAW_URL } from "./lib/paw.js";
import { LOG_CSS, createLogConsole } from "./lib/log-console.js";
import { attachDelayedHover, createPositionController, panelOpenStartFrame } from "./lib/panel-position.js";

// ---- 1. 常量与状态 -----------------------------------------------------------
const HOST_ID = "purrvid-host";
const PLAYURL_API = "//api.bilibili.com/x/player/wbi/playurl";
const FETCH_OPTIONS = { credentials: "include" };

const CODE = {
  OK: 0,
  FAILED_TO_FETCH: -1,
  INVALID_RESPONSE: -2,
  VIP_ONLY: -10403,
  UNKNOWN: -99999
};

// 清晰度 id → 描述（解析时会被接口返回的 accept_description 等覆盖更新）。
const QUALITY_LABELS = {
  16: "360P 流畅", 32: "480P 标清", 64: "720P 准高清", 80: "1080P 高清",
  112: "1080P 高码率", 120: "4K 超高清", 125: "HDR 真彩"
};

// 下载链接产生的 blob: URL（页面卸载时统一回收）。
const downloadBlobUrls = new Set();
// 番剧流程状态。
const bangumiState = { videoInfo: null, interval: 0 };
// 面板 ↔ relay 消息源（与 universal-panel / panel-relay 约定一致）。
const RELAY_SOURCE = "purrvid-panel";
// 悬浮按钮常驻开关（由 popup 经 relay 下发）与面板展开控制器。
let floatingEnabled = true;
let panelOpen = null;

// ---- 2. 通用工具 -------------------------------------------------------------
const debug = () => {};   // 预留调试日志开关（默认静默）

const isBilibili = () => location.hostname === "www.bilibili.com" || location.hostname === "bilibili.com";
const isVideoPage = () => /\/video\/(av|bv)[0-9a-zA-Z]+/i.test(window.location.pathname);
const isBangumiPage = () => /\/bangumi\/play\/\S+/i.test(window.location.pathname);

const isAdvancedMode = () => localStorage.purrvid_download_mode !== "normal";
// 默认收起（仅悬浮按钮），不主动展开打扰用户；仅当用户曾手动展开（purrvid_show==="show"）时才展开。
const isHidden = () => localStorage.purrvid_show !== "show";

function formatSize(bytes) {
  if (!bytes) return "未知大小";
  const GB = 1024 * 1024 * 1024, MB = 1024 * 1024, KB = 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)}MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(2)}KB`;
  return bytes + "B";
}

// 由码率与时长估算字节数（DASH 响应不带 size 时的兜底）。
function estimateSize(bandwidth, durationMs) {
  return bandwidth > 0 && durationMs > 0 ? Math.round(bandwidth * durationMs / 1000 / 8) : 0;
}

// HEAD 探测真实 Content-Length（CORS 安全列表头，可直接读）；失败/超时返回 0。
async function headSize(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await window.fetch(url, { method: "HEAD", signal: controller.signal });
    const length = parseInt(response.headers.get("content-length"), 10);
    return response.ok && length > 0 ? length : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// 面板尺寸文案：估算值加「约」前缀，精确值直接展示。
function sizeText(item) {
  if (!item || !item.size) return "未知大小";
  return (item.sizeEstimated ? "约 " : "") + formatSize(item.size);
}

// 轮询等待选择器出现（最多 100 次 × 300ms），超时返回 null。
function waitForSelector(selector) {
  return new Promise(resolve => {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const el = document.querySelector(selector);
      if (el || tries > 100) {
        clearInterval(timer);
        resolve(el);
      }
    }, 300);
  });
}

// 等待播放器清晰度控件就绪后执行回调。
async function whenQualityReady(callback) {
  const el = await waitForSelector("#bilibili-player .squirtle-quality-wrap, #bilibili-player .bpx-player-ctrl-quality");
  if (el) callback();
}

// 注册面板宿主自定义元素（基于 div）。
function defineHostElement(win) {
  win.customElements.define(HOST_ID, class extends HTMLDivElement {
    constructor() { super(); }
  }, { extends: "div" });
}

// 日志控制台实例（面板创建时由共享模块 lib/log-console.js 初始化）。
let logConsole = null;

// 只清空日志正文，保留标题栏。
function clearLogs() {
  if (logConsole) logConsole.clear();
}

// 解析日志：纯文本行（textContent 渲染，避免注入）。
function log(...args) {
  debug("[PurrVid]", ...args);
  if (!logConsole) return;
  const text = args.map(item => {
    if (item.message) return item.message;
    if (typeof item == "object") { try { return JSON.stringify(item); } catch { return item; } }
    return item;
  }).join(" ");
  logConsole.line(text);
}

// 标识行：av / bvid / cid 等以等宽芯片展示。
function logId(pairs) {
  if (logConsole) logConsole.id(pairs);
}

// 小标题（如「下载链接」）。
function logHeading(text) {
  if (logConsole) logConsole.heading(text);
}

// 分组标题：音频 / 视频 / 分段，带彩色圆点。
function logSection(title, kind) {
  if (logConsole) logConsole.section(title, kind);
}

// 链接行：标签 + 主机名 + 复制按钮 + 等宽可换行 URL。
function logLink(label, url) {
  if (logConsole && url) logConsole.link(label, url);
}

function trackBlobUrl(url) {
  downloadBlobUrls.add(url);
}

// ---- 3. 页面/清晰度探测 ------------------------------------------------------
// 从播放器当前选中的清晰度读取 qn。
async function readPlayerQuality() {
  const active = await waitForSelector(".squirtle-quality-select-list li.active, .bpx-player-ctrl-quality-menu .bpx-state-active");
  if (!active) return null;
  let quality = +active.dataset.value;
  if (quality === 0) {
    const first = active.parentElement.querySelector("li:first-child");
    if (first) quality = +(first.dataset.value || 0);
  }
  debug("quality from player is", quality);
  return quality;
}

// 目标清晰度：优先播放器当前值，回退到用户设置，再回退 120。
async function resolveQuality() {
  let quality = localStorage.bilibili_player_settings
    && `${localStorage.bilibili_player_settings}` != "undefined"
    && +JSON.parse(localStorage.bilibili_player_settings).setting_config.defquality || 120;
  quality = await readPlayerQuality() || quality;
  return quality;
}

// ---- 4. 视频信息获取 ---------------------------------------------------------
// 从页面 HTML 抽取 __INITIAL_STATE__ / __NEXT_DATA__（番剧 next2025 走 hydrate）。
async function fetchVideoInfo(mode) {
  try {
    if (mode === "next2025" && window.__PLAYURL_HYDRATE_DATA__) {
      return { data: window.__PLAYURL_HYDRATE_DATA__, code: 0, status: "success" };
    }
    const html = await (await window.fetch(window.location.href, FETCH_OPTIONS)).text();
    const initialState = html.match(/<script>window.__INITIAL_STATE__=(.+?)<\/script>/);
    if (initialState && initialState[1]) {
      const state = JSON.parse(initialState[1].replace(";(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());", ""));
      debug("initial state:", state);
      return { code: CODE.OK, data: state };
    }
    const nextData = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
    if (nextData && nextData[1]) {
      const state = JSON.parse(nextData[1]).props.pageProps.dehydratedState.queries[0].state;
      if (state.status === "success") state.code = CODE.OK;
      debug("initial state:", state);
      return state;
    }
    return { code: CODE.INVALID_RESPONSE, message: "获取视频信息失败，可以尝试清除浏览器cookies和缓存后重试" };
  } catch (error) {
    debug("获取视频信息失败：", error);
    return { code: CODE.FAILED_TO_FETCH, message: "获取视频信息失败：" + (error?.message || error) };
  }
}

// ---- 5. playurl 解析 ---------------------------------------------------------
// 统一解析 playurl 响应：更新清晰度描述、打印主/备链接、产出 dash/durl。
function parsePlayurlResponse(error, data, quality) {
  if (data && (data.dash || data.durl)) {
    const { dash, accept_description, accept_quality, video_codecid, support_formats } = data;
    const { durl } = data;
    if (accept_quality) {
      accept_quality.forEach((q, index) => { QUALITY_LABELS[q] = accept_description?.[index] || QUALITY_LABELS[q]; });
    }
    Object.values(support_formats).forEach(format => {
      QUALITY_LABELS[format.quality] = format.new_description || format.display_desc || QUALITY_LABELS[format.quality];
    });
    logHeading("下载链接");
    const video = dash?.video?.find(v => `${v.codecid}` == `${video_codecid}` && `${v.id}` == `${quality}`) ?? dash?.video?.[0];
    const audio = dash?.audio?.[0];
    // DASH 不带 size：先按码率×时长估算，渲染前再用 HEAD 探测精确值覆盖。
    for (const media of [audio, video]) {
      if (media && !media.size) {
        media.size = estimateSize(media.bandwidth, data.timelength);
        media.sizeEstimated = media.size > 0;
      }
    }
    if (audio) {
      logSection("音频", "audio");
      logLink("主链接", audio.base_url);
      if (audio.backup_url && audio.backup_url.length) audio.backup_url.forEach((url, i) => logLink(`备用 ${i + 1}`, url));
    }
    if (video) {
      logSection("视频", "video");
      logLink("主链接", video.base_url);
      if (video.backup_url && video.backup_url.length) video.backup_url.forEach((url, i) => logLink(`备用 ${i + 1}`, url));
    }
    if (durl?.length) {
      durl.forEach((segment, i) => {
        logSection(`视频分段 ${i + 1}`, "segment");
        logLink("主链接", segment.url);
        if (segment.backup_url && segment.backup_url.length) segment.backup_url.forEach((url, j) => logLink(`备用 ${j + 1}`, url));
      });
    }
    return {
      code: CODE.OK,
      dash: audio && video ? { audio, video } : undefined,
      durl: data.durl,
      qualityDescription: QUALITY_LABELS[video?.id ?? quality]
    };
  }
  if (error) {
    if (error.code === CODE.VIP_ONLY) {
      error.message = "该视频只能登陆大会员账号之后下载，如登录后仍然报错，可以尝试清除浏览器cookies和缓存后重试";
      return error;
    }
    return typeof error.code !== "undefined" ? error : { code: CODE.INVALID_RESPONSE, message: "该视频暂时不支持下载，可以尝试清除浏览器cookies和缓存后重试" };
  }
  debug("params:", [error, data, quality]);
  return { code: CODE.UNKNOWN, message: "未知错误" };
}

// 渲染前并行 HEAD 探测，把估算尺寸替换为真实 Content-Length（失败保留估算）。
async function resolveSizes(parsed) {
  if (!parsed || parsed.code !== CODE.OK) return parsed;
  const items = parsed.dash ? [parsed.dash.audio, parsed.dash.video] : (parsed.durl || []);
  await Promise.all(items.map(async item => {
    if (!item || (item.size > 0 && !item.sizeEstimated)) return;
    const exact = await headSize(item.base_url || item.url);
    if (exact > 0) { item.size = exact; item.sizeEstimated = false; }
  }));
  return parsed;
}

// 投稿视频 playurl。
async function fetchVideoPlayurl(aid, bvid, cid, quality = 120) {
  const url = `${PLAYURL_API}?qn=${quality}&fnver=0&fnval=4048&fourk=1&avid=${aid}&bvid=${bvid}&cid=${cid}`;
  const json = await (await window.fetch(url, FETCH_OPTIONS)).json();
  debug("视频信息", json);
  if (json.code !== CODE.OK) return parsePlayurlResponse({ code: json.code, message: json.message }, null, quality);
  return resolveSizes(parsePlayurlResponse(null, json.data, quality));
}

// 番剧 playurl（信息已由 XHR 钩子/hydrate 取得）。
async function fetchBangumiPlayurl(quality = 120, episodeInfo) {
  return resolveSizes(parsePlayurlResponse(null, episodeInfo, quality));
}

// ---- 6. 下载执行 -------------------------------------------------------------
// 大块二进制（ffmpeg 合并、CDN 字节下载）一律委托后台扩展上下文执行：页面 MAIN
// world 受页面 CSP（worker-src / connect-src）与 Trusted Types 约束，后台凭
// host_permissions 豁免 CORS 且可建 Worker。通道与 universal-panel 完全一致：
// 面板 postMessage → content/panel-relay.js → runtime 消息 → background。

// ffmpeg 合并/转封装请求（经 relay 转后台；结果由 main 的 ffmpeg-result 分支回收）。
// run 可选：登记 requestId，取消时即时 settle 并丢弃迟到结果。
let ffmpegSeq = 0;
const ffmpegPending = new Map();
function requestFFmpeg(payload, transfer, run) {
  return new Promise((resolve, reject) => {
    const requestId = ++ffmpegSeq;
    const timer = setTimeout(() => {
      ffmpegPending.delete(requestId);
      reject(new Error("ffmpeg 处理超时"));
    }, 600000);
    ffmpegPending.set(requestId, { resolve, reject, timer });
    run?.ffmpegRequests.add(requestId);
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "ffmpeg", requestId, ...payload }, "*", transfer);
  });
}

// ---- 原地取消（与 universal-panel 同一套交互） --------------------------------
// 点击后链接原地变「取消下载」，再点即取消：页内 fetch 经 AbortController 中断，
// ffmpeg 阶段即时 settle 桥接 Promise；取消为终态，不重试备用链接，迟到结果丢弃。
let activeDownload = null;
function beginDownload(link, progressEl) {
  const run = { canceled: false, controller: new AbortController(), ffmpegRequests: new Set(), progress: progressEl };
  activeDownload = run;
  link.dataset.label = link.textContent;
  link.dataset.title = link.title;
  link.textContent = "取消下载";
  link.title = "取消当前下载";
  link.classList.add("cancel");
  return run;
}
function endDownload(link, run) {
  if (activeDownload === run) activeDownload = null;
  link.textContent = link.dataset.label || "下载";
  link.title = link.dataset.title || "";
  link.classList.remove("cancel");
}
function cancelDownload(run) {
  if (run.canceled) return;
  run.canceled = true;
  run.controller.abort();
  for (const requestId of run.ffmpegRequests) {
    const pending = ffmpegPending.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      ffmpegPending.delete(requestId);
      pending.reject(new DOMException("已取消", "AbortError"));
    }
  }
  if (run.progress) run.progress.textContent = "已取消。";
}
function checkCanceled(run) {
  if (run?.canceled) throw new DOMException("已取消", "AbortError");
}

// 合并音视频：页面只把 Blob 转成 Uint8Array 转移给后台，不在页面建 ffmpeg Worker。
async function mergeInBackground(videoBlob, audioBlob, run) {
  const video = new Uint8Array(await videoBlob.arrayBuffer());
  const audio = new Uint8Array(await audioBlob.arrayBuffer());
  return requestFFmpeg(
    { op: "merge", outputName: "merged.mp4", videoExt: "mp4", audioExt: "mp4", videoBytes: video, audioBytes: audio },
    [video.buffer, audio.buffer],
    run
  );
}

// 触发浏览器保存（附带手动保存链接兜底）。
function triggerDownload(bytes, filename, container, onDone) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(blob);
  trackBlobUrl(url);
  anchor.setAttribute("href", url);
  anchor.setAttribute("download", filename);
  anchor.className = "save-link";
  anchor.textContent = "（如果没有弹出下载，请点击这里保存）";
  container.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000);
  onDone?.();
}

// 带进度 fetch → Blob。CDN 字节下载留在页内：B站播放器本就从同一 CDN 取流
// （connect-src 必然放行），且页内 fetch 自带正确的 bilibili Referer；迁后台反而
// 需要 DNR 改写 Referer，会波及播放器自身的播放请求，得不偿失。
// signal：取消下载时中断；body 流式阶段须自行响应（fetch 只保证连接阶段）。
async function fetchWithProgress(url, size, onProgress, signal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  let timer = null;
  let reader = null;
  const onAbort = () => { reader?.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await window.fetch(url, { signal });
    const total = size || parseInt(response.headers.get("content-length"), 10);
    let received = 0;
    timer = setInterval(() => onProgress(received, total), 1000);
    return await new Response(new ReadableStream({
      start(controller) {
        reader = response.body.getReader();
        const pump = () => {
          reader.read().then(({ done, value }) => {
            if (signal?.aborted) { controller.error(new DOMException("已取消", "AbortError")); return; }
            if (done) { controller.close(); return; }
            received += value.byteLength;
            controller.enqueue(value);
            pump();
          }).catch(error => controller.error(error));
        };
        pump();
      }
    })).blob();
  } finally {
    if (timer) { clearInterval(timer); timer = null; }
    signal?.removeEventListener("abort", onAbort);
  }
}

// 依次尝试主链接与备用链接。取消为终态：不重试、不切备用。
async function fetchMedia(item, url, size, onProgress, signal) {
  const urls = [url, url, ...(item && item.backup_url || [])].filter(Boolean);
  let lastError;
  for (let i = 0; i < urls.length; i++) {
    try {
      return await fetchWithProgress(urls[i], size, onProgress, signal);
    } catch (error) {
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      lastError = error;
      debug("下载失败，重试或切换备用链接：", urls[i], error);
    }
  }
  throw lastError || new Error("下载失败");
}

// 单文件下载（音频/视频独立、或单分段）。按钮状态由 wirePanel 的 begin/endDownload 管理。
async function downloadSingle(link, item, title, progressEl, run) {
  const bytes = await fetchMedia(item, item.url, item.size, (received, total) => {
    const percent = total > 0 ? Math.ceil(received / total * 100) : 0;
    progressEl.textContent = ` 正在下载 - ${formatSize(received)}/${total > 0 ? formatSize(total) : "未知"} - ${percent}%`;
  }, run.controller.signal);
  checkCanceled(run);
  progressEl.textContent = " 已下载完成";
  let ext = (new URL(item.url).pathname.toLowerCase().match(/\.[a-z0-9]+?$/) || [".mp4"])[0];
  if (ext == ".m4s") ext = ".mp4";
  triggerDownload(bytes, title + ext, progressEl);
}

// 合并下载（音视频合一 / 多分段）。第一项按音频、第二项按视频送入 ffmpeg。
async function downloadMerge(isAudioVideo, link, items, title, progressList, run) {
  if (items.length === 1) return downloadSingle(link, items[0], title, progressList, run);
  const total = items.reduce((sum, item) => sum + (item.size || 0), 0);
  if (total > 1536 * 1024 * 1024 && !window.confirm(`合并下载约需占用 ${formatSize(total)} 以上的运行内存，较大文件建议改用“浏览器下载”模式。仍要继续合并吗？`)) return;
  const jobs = items.map(async (item, index) => {
    const size = item.size;
    let actualSize = size;
    const label = isAudioVideo ? `${index === 0 ? "音频" : "视频"}` : `分段${index + 1}`;
    const li = document.createElement("li");
    li.textContent = `${label} (${formatSize(size)}) 正在下载`;
    progressList.appendChild(li);
    const bytes = await fetchMedia(item, item.url, size, (received, total) => {
      const percent = total > 0 ? Math.ceil(received / total * 100) : 0;
      li.textContent = `${label} (${formatSize(size || total)}) 正在下载 - ${formatSize(received)}/${total > 0 ? formatSize(total) : "未知"} - ${percent}%`;
      actualSize = total;
    }, run.controller.signal);
    li.textContent = `${label} (${formatSize(actualSize)}) 已下载完成，等待合并`;
    return bytes;
  });
  const [first, second] = await Promise.all(jobs);
  checkCanceled(run);
  progressList.textContent = "正在合并，所需时间取决于视频大小...";
  const buffer = await mergeInBackground(second, first, run);
  checkCanceled(run);
  progressList.textContent = "已完成";
  triggerDownload(buffer, title + ".mp4", progressList);
}

// 页面卸载：回收下载产生的 blob: URL（ffmpeg 在后台执行，无需页面侧清理）。
window.addEventListener("beforeunload", () => {
  for (const url of downloadBlobUrls) {
    try { URL.revokeObjectURL(url); } catch (error) { debug(error); }
  }
}, true);

// ---- 7. 番剧 XHR 钩子 --------------------------------------------------------
// 番剧 playurl 由播放器 XHR 发起;钩住响应拿到 video_info，超时则回退。
function hookBangumiXHR(onInfo, OriginalXHR, fallback) {
  const done = { current: false };
  setTimeout(() => { if (!done.current) fallback(); }, 3000);
  window.XMLHttpRequest = class extends OriginalXHR {
    constructor() {
      super();
      this.addEventListener("load", () => {
        if (!this.responseURL.includes("/playurl")) return;
        const params = new URLSearchParams(this.responseURL);
        const avid = params.get("avid");
        const cid = params.get("cid");
        const bvid = params.get("bvid");
        const epId = params.get("ep_id");
        const json = JSON.parse(this.responseText);
        const info = json.result ? json.result.video_info || json.result : json.data;
        info.avid = +avid;
        info.cid = +cid;
        info.bvid = bvid ? +bvid : undefined;
        info.ep_id = epId ? +epId : undefined;
        debug("视频信息:", info);
        onInfo(info);
        done.current = true;
      }, { capture: true, passive: true });
    }
  };
}

// ---- 8. 面板样式与模板 -------------------------------------------------------
const PANEL_CSS = `
p,
a,
div,
span,
li,
i,
b,
strong,
input,
button,
label {
  font-size: inherit;
}
#content,
#content * {
  box-sizing: border-box;
}
li {
  margin-bottom: 5px;
}
p {
  margin: 0;
  line-height: 1.5;
}
h1 {
  font-size: 20px;
  font-weight: bold;
  margin-bottom: 20px;
}
#title {
  margin: 12px 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  word-break: break-word;
  white-space: normal;
}
#content {
  display: block;
  width: 100%;
  font-size: 14px;
  position: relative;
  color: #23304a;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
a {
  color: #00a1d6 !important;
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
a.disabled {
  color: #666 !important;
}
a.disabled:hover {
  text-decoration: none;
  cursor: not-allowed;
}
#main {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 14px 14px;
}
.donate {
  border-top: 1px solid #ccc;
  padding-top: 10px;
}
#zanshang {
  width: 80%;
}
.b-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #52617a;
  font-size: 12px;
  font-weight: 600;
}
.b-field select {
  flex: 1;
  min-width: 0;
  max-width: 320px;
  padding: 5px 8px;
  border: 1px solid #e4e9f2;
  border-radius: 8px;
  background: #f7f8fc;
  color: #465777;
  font: inherit;
  font-size: 12px;
}
.b-note {
  margin: 0;
  color: #8490a5;
  font-size: 11px;
  line-height: 1.5;
}
#actions {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: auto;
  gap: 12px;
  padding: 12px 14px 10px;
  background: linear-gradient(180deg, rgba(255, 255, 255, .76), rgba(255, 255, 255, 0));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  pointer-events: auto;
  cursor: move;
  user-select: none;
  touch-action: none;
}
#panel-title {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 110px);
  margin: 0;
  padding: 10px 18px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .72);
  border-radius: 999px;
  background: rgba(255, 255, 255, .62);
  color: #000;
  box-shadow: 0 0 0 2px rgba(244, 90, 141, .12), 0 0 16px 3px rgba(244, 90, 141, .2), 0 8px 24px rgba(46, 57, 84, .16);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  font-size: 13px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-large {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgba(255, 255, 255, .72);
  background: rgba(255, 255, 255, .62);
  border-radius: 999px;
  color: #863b5d;
  padding: 10px 18px;
  min-height: 42px;
  box-shadow: 0 0 0 2px rgba(244, 90, 141, .12), 0 0 16px 3px rgba(244, 90, 141, .2), 0 8px 24px rgba(46, 57, 84, .16);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  font-weight: 650;
  transition: width .22s ease, padding .22s ease, gap .22s ease, opacity .22s ease, background .22s ease, box-shadow .22s ease, transform .22s ease;
}
#toggle {
  outline: none;
  cursor: pointer;
  opacity: .76;
  pointer-events: auto;
}
#toggle .toggle-icon {
  display: block;
  width: 23px;
  height: 23px;
  flex: none;
  border-radius: 50%;
  object-fit: cover;
}
#toggle .toggle-label {
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  opacity: 1;
  transition: max-width .22s ease, opacity .18s ease;
}
.hide #main {
  display: none;
}
.hide #actions {
  position: relative;
  top: 0;
  width: 48px;
  height: 48px;
  padding: 0;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.hide #panel-title {
  display: none;
}
.hide #toggle {
  position: absolute;
  top: 0;
  right: 0;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: max-content;
  min-width: 48px;
  max-width: 48px;
  height: 48px;
  min-height: 48px;
  gap: 0;
  padding: 6px;
  overflow: hidden;
  border-radius: 50%;
  background: rgba(255, 255, 255, .48);
  box-shadow: 0 0 0 3px rgba(244, 90, 141, .16), 0 0 22px 8px rgba(244, 90, 141, .36);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-drag: none;
  transition: max-width .28s cubic-bezier(.2,.8,.2,1), gap .28s cubic-bezier(.2,.8,.2,1), padding .28s cubic-bezier(.2,.8,.2,1), border-radius .28s cubic-bezier(.2,.8,.2,1), opacity .22s ease, background .22s ease, box-shadow .22s ease;
}
.hide #toggle .toggle-icon {
  width: 34px;
  height: 34px;
  pointer-events: none;
  -webkit-user-drag: none;
}
.hide #toggle .toggle-label {
  max-width: 0;
  opacity: 0;
  transition: max-width .28s cubic-bezier(.2,.8,.2,1), opacity .18s ease;
}
/* max-width 贴近提示条实际宽度，避免按钮先展开到内容宽度后停顿。 */
.hide #toggle.fab-hover,
.hide #toggle:focus-visible {
  max-width: 150px;
  flex-direction: row;
  justify-content: flex-start;
  gap: 9px;
  padding: 6px 12px 6px 6px;
  border-radius: 999px;
  opacity: 1;
  background: rgba(255, 255, 255, .94);
  box-shadow: 0 0 0 2px rgba(244, 90, 141, .18), 0 0 20px 6px rgba(244, 90, 141, .28);
}
.hide #toggle.fab-hover .toggle-label,
.hide #toggle:focus-visible .toggle-label {
  max-width: 180px;
  opacity: 1;
}
/* 按钮靠近左边缘时提示条改向右展开（方向由位置控制器写 data-fab-side）。 */
:host([data-fab-side="right"]) .hide #toggle {
  left: 0;
  right: auto;
}
.btn-large:hover {
  opacity: 1;
  background: rgba(255, 255, 255, .94);
  box-shadow: 0 0 0 2px rgba(244, 90, 141, .16), 0 0 18px 4px rgba(244, 90, 141, .24), 0 10px 28px rgba(35, 48, 74, .22);
  transform: translateY(-1px);
}
.settings {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, .82);
  border-radius: 14px;
  background: rgba(255, 255, 255, .66);
  box-shadow: 0 12px 35px rgba(65, 81, 117, .08);
  backdrop-filter: blur(18px);
}
.size {
  margin: 0;
  color: #8994a8;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
#durls {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 0;
  margin: 0;
}
#durls > li {
  min-width: 0;
  margin-bottom: 0;
  padding: 10px;
  border: 1px solid #e5eaf3;
  border-radius: 16px;
  background: rgba(255, 255, 255, .78);
  box-shadow: 0 8px 24px rgba(56, 73, 110, .06);
  list-style: none;
}
.download-card { display: grid; gap: 6px; }
.dl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dl-head strong { font-size: 12px; color: #3d4653; }
#durls a {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 32px;
  margin: 0;
  padding: 0 12px;
  border-radius: 10px;
  background: #f0f3fa;
  color: #465777 !important;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
#durls a[mode="advanced"] {
  background: linear-gradient(135deg, #f45a8d, #d83f80);
  color: #fff !important;
}
#durls a.cancel { background: linear-gradient(135deg, #97a1b5, #6f7a92); }
#durls a.disabled { opacity: .55; pointer-events: none; }
#durls .progress {
  font-size: 11px;
  line-height: 1.5;
  color: #68758e;
  word-break: break-all;
}
#durls span.progress { display: block; }
#durls span.progress:empty { display: none; }
#durls ul.progress { display: block; list-style: none; margin: 0; padding: 0; }
#durls ul.progress:empty { display: none; }
#durls ul.progress li { margin-top: 4px; margin-bottom: 0; }
#durls ul.progress li:first-child { margin-top: 0; }
#durls .progress a.save-link {
  display: inline;
  width: auto;
  min-height: 0;
  margin: 0 0 0 6px;
  padding: 0;
  border-radius: 0;
  background: none;
  color: #f45a8d !important;
  font-size: 11px;
  font-weight: 600;
  text-decoration: underline;
}
@media (max-width: 560px) {
  #main { padding: 14px; }
  .settings { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: .01ms !important; }
}
.pv-loader {
  display: inline-block;
  width: 16px;
  height: 16px;
  vertical-align: middle;
  border: 2px solid rgba(244, 90, 141, .25);
  border-top-color: #f45a8d;
  border-radius: 50%;
  animation: pv-spin .8s linear infinite;
}
@keyframes pv-spin { to { transform: rotate(360deg); } }
`;

// 把样式注入 shadow root：优先 constructable stylesheet（adoptedStyleSheets 不受
// 页面 style-src 'unsafe-inline' 限制，Trusted Types 安全），不支持时回退 <style>。
function applyStyles(shadow, cssText) {
  if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in shadow) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shadow.adoptedStyleSheets = [sheet];
  } else {
    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.appendChild(style);
  }
}

// 下载方式设置区（DOM API 构建，不用 innerHTML）。
function buildSettings() {
  const wrap = document.createElement("div");
  wrap.className = "settings";
  const field = document.createElement("label");
  field.className = "b-field";
  const span = document.createElement("span");
  span.textContent = "下载方式";
  const select = document.createElement("select");
  select.id = "setting-download-mode";
  for (const [value, text] of [
    ["merge", "合并下载（音视频合一，也可单独下载）"],
    ["browser", "浏览器下载（省内存，需手动合并）"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  field.append(span, select);
  const note = document.createElement("p");
  note.className = "b-note";
  note.textContent = "清晰度跟随 B站播放器，切换后自动更新。下载进行中请勿刷新或关闭页面，也不要切换分集和清晰度。";
  wrap.append(field, note);
  return wrap;
}

// ---- 9. 面板渲染与交互 -------------------------------------------------------
// 全部用 DOM API（createElement / textContent）构建，不用 innerHTML：标题/错误
// 消息/URL 经 textContent 写入天然防 XSS，且兼容 Trusted Types CSP。

// 填充标题区（加载中显示旋转 spinner；错误显示消息；成功显示清晰度+标题）。
function fillTitle(el, { title, code, message, quality, dash, durl, loading }) {
  el.replaceChildren();
  if (loading) {
    el.append("加载中 ");
    const spinner = document.createElement("span");
    spinner.className = "pv-loader";
    el.appendChild(spinner);
    return;
  }
  const strong = document.createElement("strong");
  if (code !== CODE.OK) {
    strong.textContent = message;
    el.appendChild(strong);
    return;
  }
  if (dash || durl) {
    if (quality) el.append(`[${quality}] `);
    strong.textContent = title;
    el.append(strong, " 的下载地址：");
  } else {
    strong.textContent = "出错了:( " + message;
    el.appendChild(strong);
  }
}

// 构建下载卡片列表。保留 durl/durls（encodeURIComponent(JSON)）属性契约，
// wirePanel 的点击委托据此读取下载项与进度容器，无需改动下载逻辑。
function buildDownloadCards({ title, code, dash, durl }) {
  const frag = document.createDocumentFragment();
  if (code !== CODE.OK) return frag;
  const hasDash = !!dash;
  const items = hasDash
    ? [{ label: "音频", item: { ...dash.audio, url: dash.audio.base_url } }, { label: "视频", item: { ...dash.video, url: dash.video.base_url } }]
    : (durl || []).map((item, index) => ({ label: "分段" + (index + 1), item }));
  const advanced = isAdvancedMode();

  const makeHead = (label, sizeLabelText) => {
    const head = document.createElement("div");
    head.className = "dl-head";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = sizeLabelText;
    head.append(strong, size);
    return head;
  };

  items.forEach(({ label, item }, index) => {
    const encoded = encodeURIComponent(JSON.stringify(item));
    const name = hasDash ? `${title}_${label}` : `${title}_分段${index + 1}`;
    const li = document.createElement("li");
    li.className = "download-card";
    li.appendChild(makeHead(label, sizeText(item)));
    const a = document.createElement("a");
    a.title = name;
    if (advanced) {
      a.setAttribute("mode", "advanced");
      a.setAttribute("merge", "off");
      a.href = "#nogo";
      a.setAttribute("durl", encoded);
      a.textContent = "下载" + label;
    } else {
      a.setAttribute("download", name + ".mp4");
      a.href = item.url;
      a.textContent = "打开" + label + "主链接或右键保存";
    }
    li.appendChild(a);
    if (advanced) {
      const progress = document.createElement("span");
      progress.className = "progress";
      progress.setAttribute("durl", encoded);
      li.appendChild(progress);
    }
    frag.appendChild(li);
  });

  // 合并卡片与单流卡片同屏：合并下载与单独下载不再拆成两种模式。
  if (advanced && hasDash) {
    const entries = items.map(({ item }) => item);
    const encoded = encodeURIComponent(JSON.stringify(entries));
    const total = entries.reduce((sum, item) => sum + (item.size || 0), 0);
    const totalEstimated = entries.some(item => item.sizeEstimated);
    const li = document.createElement("li");
    li.className = "download-card merge-card";
    li.appendChild(makeHead("音频 + 视频", (totalEstimated ? "共约 " : "共 ") + formatSize(total)));
    const a = document.createElement("a");
    a.title = title;
    a.setAttribute("durls", encoded);
    a.setAttribute("mode", "advanced");
    a.setAttribute("type", "a+v");
    a.setAttribute("merge", "on");
    a.href = "#nogo";
    a.textContent = "合并下载";
    const ul = document.createElement("ul");
    ul.setAttribute("durls", encoded);
    ul.className = "progress";
    li.append(a, ul);
    frag.appendChild(li);
  }
  return frag;
}

// 面板交互：下载方式切换、下载点击、展开/收起动画。
function wirePanel(shadowRoot) {
  const modeSelect = shadowRoot.getElementById("setting-download-mode");
  const downloads = shadowRoot.getElementById("durls");
  const toggle = shadowRoot.getElementById("toggle");
  const content = shadowRoot.getElementById("content");
  const host = document.getElementById(HOST_ID);
  const positionController = createPositionController(host, shadowRoot.getElementById("actions"));
  logConsole = createLogConsole(shadowRoot.getElementById("purrvid-logs"), { title: "解析日志" });
  const disableSettings = () => { modeSelect.disabled = true; };
  const enableSettings = () => { modeSelect.disabled = false; };
  let panelAnimation = null, buttonAnimation = null;

  const setOpen = (open, animate = true) => {
    const from = toggle.getBoundingClientRect();
    if (panelAnimation) { panelAnimation.cancel(); panelAnimation = null; }
    if (buttonAnimation) { buttonAnimation.cancel(); buttonAnimation = null; }
    localStorage.purrvid_show = open ? "show" : "hide";
    host.classList.toggle("hide", !open);
    const label = open ? "收起" : "打开星喵助手";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    const setToggleLabel = text => { toggle.querySelector(".toggle-label").textContent = text; };
    if (!open) {
      content.classList.add("hide");
      setToggleLabel(label);
      host.style.cssText = "display:block;position:fixed;z-index:" + Number.MAX_SAFE_INTEGER + ";" + positionController.collapsedPosition() + ";margin:0;width:48px;height:48px;max-height:none;overflow:visible;border:0;background:transparent;box-shadow:none;backdrop-filter:none;";
      // 常驻关闭时收起态不留悬浮按钮，整个宿主隐藏。
      if (!floatingEnabled) host.style.display = "none";
      const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (animate && !reduceMotion && typeof toggle.animate === "function") {
        buttonAnimation = toggle.animate([
          { transform: "scale(1)" },
          { transform: "scale(.8)" },
          { transform: "scale(1)" }
        ], { duration: 280, easing: "cubic-bezier(0.34,1.56,0.64,1)" });
        buttonAnimation.onfinish = () => { buttonAnimation = null; };
      }
      return;
    }
    content.classList.remove("hide");
    setToggleLabel(label);
    host.style.cssText = "display:block;position:fixed;z-index:" + Number.MAX_SAFE_INTEGER + ";left:0;top:0;right:auto;bottom:auto;margin:0;width:min(480px,calc(100vw - 32px));height:auto;max-height:min(78vh,640px);overflow:hidden;border:1px solid rgba(255,255,255,.82);border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 18px 60px rgba(35,48,74,.22);backdrop-filter:blur(20px);";
    const measured = host.getBoundingClientRect();
    host.style.height = measured.height + "px";
    // 按锚点象限算落点：靠边/靠顶时反向展开并夹回视口，动画原点取靠近按钮的角。
    const placement = positionController.placePanel(measured.width, measured.height);
    const target = host.getBoundingClientRect();
    if (!animate || typeof host.animate !== "function") {
      host.style.height = "auto";
      host.style.overflow = "auto";
      return;
    }
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panelAnimation = host.animate([
      panelOpenStartFrame(from, target, placement),
      { transform: "none", transformOrigin: placement.origin, opacity: 1 }
    ], { duration: reduceMotion ? 1 : 520, easing: "cubic-bezier(0.16,1,0.3,1)" });
    panelAnimation.onfinish = () => {
      panelAnimation = null;
      host.style.height = "auto";
      host.style.overflow = "auto";
    };
  };

  modeSelect.value = isAdvancedMode() ? "merge" : "browser";
  const refresh = () => shadowRoot.buildDownloadLinks();
  modeSelect.addEventListener("change", () => {
    localStorage.purrvid_download_mode = modeSelect.value === "browser" ? "normal" : "advanced";
    refresh();
  });
  downloads.addEventListener("click", event => {
    const link = event.target.closest("a[mode=advanced]");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    // 下载中再次点击同一链接 = 取消（原地切换，复用元素）。
    if (link.classList.contains("cancel")) {
      if (activeDownload) cancelDownload(activeDownload);
      return;
    }
    if (link.classList.contains("disabled") || activeDownload) return;
    const merge = link.getAttribute("merge") === "on";
    const progressEl = merge
      ? shadowRoot.querySelector("ul[durls=\"" + link.getAttribute("durls") + "\"]")
      : shadowRoot.querySelector("span[durl=\"" + link.getAttribute("durl") + "\"]");
    const run = beginDownload(link, progressEl);
    const title = link.dataset.title;
    const operation = merge
      ? downloadMerge(true, link, JSON.parse(decodeURIComponent(link.getAttribute("durls"))), title, progressEl, run)
      : downloadSingle(link, JSON.parse(decodeURIComponent(link.getAttribute("durl"))), title, progressEl, run);
    disableSettings();
    operation.catch(error => {
      if (!run.canceled) console.error("下载失败", error);
    }).finally(() => {
      enableSettings();
      endDownload(link, run);
    });
  });
  toggle.addEventListener("click", () => setOpen(isHidden()));
  attachDelayedHover(toggle);
  setOpen(!isHidden(), false);
  panelOpen = setOpen;
}

// 应用悬浮按钮常驻开关：仅调整收起态宿主的可见性，不打断展开的面板。
function applyFloating(value) {
  floatingEnabled = value !== false;
  const host = document.getElementById(HOST_ID);
  if (host && isHidden()) host.style.display = floatingEnabled ? "block" : "none";
}

// 渲染（或更新）面板。首次用 DOM API 创建宿主与 shadow DOM，之后仅更新标题/链接。
function renderPanel({ code, title, dash, quality, message, loading, durl }) {
  const fillDurls = (durls, isLoading) => {
    durls.replaceChildren();
    if (!isLoading) durls.appendChild(buildDownloadCards({ title, code, dash, durl }));
  };
  let host = document.getElementById(HOST_ID);
  let shadow;
  if (host) {
    shadow = host.shadowRoot;
    fillTitle(shadow.getElementById("title"), { title, code, message, quality, dash, durl, loading });
    fillDurls(shadow.getElementById("durls"), loading);
  } else {
    host = document.createElement(HOST_ID);
    host.id = HOST_ID;
    host.style.cssText = `display:block;position:fixed;z-index:${Number.MAX_SAFE_INTEGER};left:0;top:0;right:auto;bottom:auto;width:min(480px,calc(100vw - 32px));max-height:min(78vh,640px);overflow:auto;border:1px solid rgba(255,255,255,.82);border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 18px 60px rgba(35,48,74,.22);backdrop-filter:blur(20px);`;
    host.classList.toggle("hide", isHidden());
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    applyStyles(shadow, PANEL_CSS + LOG_CSS);

    const hidden = isHidden();
    const label = hidden ? "打开星喵助手" : "收起";
    const content = document.createElement("div");
    content.id = "content";
    if (hidden) content.classList.add("hide");

    const actions = document.createElement("div");
    actions.id = "actions";
    const panelTitle = document.createElement("h1");
    panelTitle.id = "panel-title";
    panelTitle.textContent = "星喵助手";
    const toggle = document.createElement("button");
    toggle.id = "toggle";
    toggle.className = "btn-large";
    toggle.type = "button";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    const icon = document.createElement("img");
    icon.className = "toggle-icon";
    icon.src = PAW_URL;
    icon.alt = "";
    icon.draggable = false;
    const toggleLabel = document.createElement("span");
    toggleLabel.className = "toggle-label";
    toggleLabel.textContent = label;
    toggle.append(icon, toggleLabel);
    actions.append(panelTitle, toggle);

    const main = document.createElement("div");
    main.id = "main";
    main.appendChild(buildSettings());
    const titleEl = document.createElement("h3");
    titleEl.id = "title";
    fillTitle(titleEl, { title, code, message, quality, dash, durl, loading });
    const durls = document.createElement("ul");
    durls.id = "durls";
    fillDurls(durls, loading);
    const logs = document.createElement("div");
    logs.id = "purrvid-logs";
    logs.className = "pv-logs";
    main.append(titleEl, durls, logs);

    content.append(actions, main);
    shadow.appendChild(content);
    wirePanel(shadow);
  }
  shadow.buildDownloadLinks = () => fillDurls(shadow.getElementById("durls"), false);
}

// ---- 10. 业务流程与入口 ------------------------------------------------------
// 投稿视频流程。
async function runVideoFlow() {
  const info = await fetchVideoInfo();
  const quality = await resolveQuality();
  if (info.code) return renderPanel({ code: info.code, quality: QUALITY_LABELS[quality], title: info.data.videoData.title });
  const videoData = info.data.videoData;
  let aid = videoData.aid, bvid = videoData.bvid, cid = videoData.cid;
  logId({ av: aid, bvid: bvid, cid: cid });
  let page, part;
  if (videoData.pages.length > 1) {
    const match = location.search.match(/p=(\d+)/);
    let target = videoData.pages[0];
    if (match && match[1]) target = videoData.pages.find(p => `${p.page}` == `${match[1]}`);
    page = target.page; part = target.part; cid = target.cid;
  }
  const { code, dash, qualityDescription, message } = await fetchVideoPlayurl(aid, bvid, cid, quality);
  if (code === CODE.OK) {
    let title = `${videoData.title}`;
    if (page && part) title = `${videoData.title}_P${page}_${part}`;
    renderPanel({ code, title, quality: qualityDescription, dash, message });
  } else {
    renderPanel({ code, message });
  }
}

// 番剧流程。
async function runBangumiFlow(episodeInfo) {
  const mode = episodeInfo ? "next" : "next2025";
  const isNext2025 = mode === "next2025";
  const info = await fetchVideoInfo(mode);
  const quality = await resolveQuality();
  if (info.code) {
    return renderPanel({
      code: info.code,
      quality: QUALITY_LABELS[quality],
      title: isNext2025 ? info.data.result.supplement.ogv_episode_info.long_title : info.data.seasonInfo.mediaInfo.title
    });
  }
  const episodes = isNext2025 ? [] : info.data.seasonInfo.mediaInfo.episodes;
  const epId = isNext2025 ? info.data.result.supplement.ogv_episode_info.episode_id : episodeInfo.ep_id;
  const episode = isNext2025 ? {} : episodes.find(e => epId === e.ep_id);
  const ogv = isNext2025 ? info.data.result.supplement.ogv_episode_info : undefined;
  logId({ ep: epId, quality: QUALITY_LABELS[quality] });
  const payload = isNext2025
    ? { ...info.data.result.video_info, dash: info.data.result.video_info.dash, avid: info.data.result.arc.aid, cid: info.data.result.arc.cid }
    : episodeInfo;
  const { code, dash, qualityDescription, message, durl } = await fetchBangumiPlayurl(quality, payload);
  if (dash || durl) {
    const title = isNext2025
      ? `${document.title.split("-")?.[0]}_${ogv.index_title}_${ogv.long_title}`
      : `${info.data.seasonInfo.mediaInfo.title}_${episode.titleFormat || episode.title || ""}_${episode.long_title || ""}`;
    renderPanel({ code, title, dash, message, quality: qualityDescription, durl });
  } else {
    renderPanel({ code, message });
  }
}

// 监听清晰度切换与 URL 变化，触发重新解析。
function watchQualityAndUrl(refresh, state) {
  let lastUrl = `${window.location.href}`;
  let initialized = false;
  (async () => {
    const qualityEl = await waitForSelector(".bpx-player-ctrl-quality-result");
    if (!qualityEl) return;
    let lastText = qualityEl.textContent;
    new MutationObserver(mutations => {
      if (mutations[0]?.type === "childList") {
        const newText = mutations[0]?.addedNodes?.[0]?.textContent ?? lastText;
        if (lastText !== newText) { lastText = newText; clearLogs(); initialized = true; refresh(); }
      }
    }).observe(qualityEl, { childList: true });
  })();
  state.interval = window.setInterval(() => {
    const currentUrl = window.location.href;
    if (lastUrl !== currentUrl) { lastUrl = currentUrl; clearLogs(); initialized = true; refresh(); }
    else if (!initialized) { initialized = true; refresh(); }
  }, 1000);
}

// 入口：B站走本引擎，其它站点委托通用面板。
async function main(win) {
  if (!isBilibili()) { initUniversalPanel(); return; }
  const OriginalXHR = XMLHttpRequest;
  defineHostElement(win);
  // 接收 relay 下发的悬浮按钮常驻开关、调出面板命令，以及后台 ffmpeg 回包。
  window.addEventListener("message", event => {
    const data = event.data;
    if (data?.source !== RELAY_SOURCE || data.from !== "relay") return;
    if (data.type === "floating-enabled") {
      applyFloating(data.value);
    } else if (data.type === "open-panel" && panelOpen) {
      panelOpen(true, true);
    } else if (data.type === "ffmpeg-result") {
      const pending = ffmpegPending.get(data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      ffmpegPending.delete(data.requestId);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.buffer);
    }
  });
  window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "ready" }, "*");
  const start = async () => {
    if (bangumiState.interval) win.clearInterval(bangumiState.interval);
    if (!isBilibili() || (!isVideoPage() && !isBangumiPage())) return;
    watchQualityAndUrl(async () => {
      if (!isBilibili()) return;
      renderPanel({ loading: true });
      if (isVideoPage()) { log("这是一个投稿视频"); runVideoFlow(); }
      if (isBangumiPage()) { log("这是一个番剧"); runBangumiFlow(bangumiState.videoInfo); }
    }, bangumiState);
  };
  if (isBangumiPage()) {
    hookBangumiXHR(info => { bangumiState.videoInfo = info; whenQualityReady(start); }, OriginalXHR, () => whenQualityReady(start));
  } else {
    whenQualityReady(start);
  }
}

main(window);