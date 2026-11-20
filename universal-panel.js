// ============================================================================
// universal-panel.js — 通用页内下载面板（MAIN world · 由 bilibili-engine.js 导入）
// ----------------------------------------------------------------------------
// 职责：在非 B站页面（YouTube 与通用站点）提供与 B站风格一致的右下角悬浮按钮 +
//   页内下载面板。支持 YouTube（HLS 清单 / 自适应直链）、通用 HLS / DASH / 直连。
//   所有解析与下载都在原页面完成，不跳转新标签页。
//
// 为什么留在根目录：bilibili-engine.js 相对导入本模块与 lib/，ffmpeg 客户端相对
//   解析 vendor/ffmpeg/*，引擎与本模块须同在根目录，故不并入子文件夹。
//
// 协作契约（勿改）：
//   - 宿主 id HOST_ID = "purrvid-host"（与 loader.js 全屏 CSS、引擎共享）
//   - window.postMessage：YT_SOURCE("purrvid-yt") ↔ youtube-bridge.js；
//     RELAY_SOURCE("purrvid-panel") ↔ content/panel-relay.js（协议见该文件头）
//   - localStorage.purrvid_show：面板展开状态（与引擎共享）
//   - 导出 initUniversalPanel()：由 bilibili-engine.js 在非 B站时调用
//
// 安全：面板用 DOM API 构建（不用 innerHTML），图标用 data URL，兼容 YouTube 的
//   严格 Trusted Types CSP。ffmpeg 与 HLS 分片下载委托后台执行（见 panel-relay）。
//
// 下载路由（防 Referer/Cookie 回归的三层设计）：
//   1. 同源资源留页内（天然 Referer/Cookie，行为与旧版一致）；跨域直连/HLS 走
//      后台（host_permissions 豁免 CORS / 页面 CSP，能力增强）；DASH 仍全程页内。
//   2. 后台按任务注册 DNR 规则补真实页面 Referer/Origin（见 lib/request-headers.js）。
//   3. 后台失败自动回退页内原路径 → 旧版能下的这里仍能下（DRM/直播拒绝除外）。
//   下载按钮点击后原地切换「取消下载」（复用元素）：页内 AbortSignal + 后台
//   cancel-download 双路中断；取消为终态，不触发回退；合并阶段取消丢弃结果。
// ============================================================================

import {
  formatSize,
  formatDuration,
  sanitizeFilename,
  downloadBuffer,
  mapLimit,
  concatBuffers,
  fetchWithRetry
} from "./lib/media-utils.js";
import { isMasterPlaylist, parseMaster, parseMedia, isFmp4Segments } from "./lib/m3u8.js";
import { parseMPD, representationLabel } from "./lib/mpd.js";
import {
  buildYoutubeResource,
  sortYoutubeFormats,
  youtubeFormatLabel,
  cleanGoogleVideoUrl,
  googleVideoTotal,
  isYoutubePage
} from "./lib/youtube.js";
import { PAW_URL } from "./lib/paw.js";
import { LOG_CSS, createLogConsole } from "./lib/log-console.js";

// ---- 常量 --------------------------------------------------------------------
const HOST_ID = "purrvid-host";
const YT_SOURCE = "purrvid-yt";
const RELAY_SOURCE = "purrvid-panel";
const CONCURRENCY = 4;                 // 分段并发下载数
const CHUNK_SIZE = 8 * 1024 * 1024;    // googlevideo 直链分块大小（8MB）

// ---- 面板样式（Shadow DOM 内联）----------------------------------------------
const CSS = `
* { box-sizing: border-box; }
#content { display: block; width: 100%; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #23304a; }
#content.hide { display: none; }
#actions { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px 10px; background: linear-gradient(180deg, rgba(255,255,255,.76), rgba(255,255,255,0)); backdrop-filter: blur(12px); }
#panel-title { display: inline-flex; align-items: center; min-width: 0; max-width: calc(100% - 130px); margin: 0; padding: 10px 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.72); border-radius: 999px; background: rgba(255,255,255,.62); color: #000; box-shadow: 0 0 0 2px rgba(244,90,141,.12), 0 0 16px 3px rgba(244,90,141,.2), 0 8px 24px rgba(46,57,84,.16); backdrop-filter: blur(16px) saturate(150%); font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
#toggle { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 18px; min-height: 42px; border: 1px solid rgba(255,255,255,.72); border-radius: 999px; background: rgba(255,255,255,.62); color: #863b5d; box-shadow: 0 0 0 2px rgba(244,90,141,.12), 0 0 16px 3px rgba(244,90,141,.2), 0 8px 24px rgba(46,57,84,.16); backdrop-filter: blur(16px) saturate(150%); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; opacity: .76; transition: background .22s ease, box-shadow .22s ease, transform .22s ease, opacity .22s ease; }
#toggle:hover { opacity: 1; background: rgba(255,255,255,.94); box-shadow: 0 0 0 2px rgba(244,90,141,.16), 0 0 18px 4px rgba(244,90,141,.24), 0 10px 28px rgba(35,48,74,.22); transform: translateY(-1px); }
#toggle .toggle-icon { width: 23px; height: 23px; flex: none; border-radius: 50%; object-fit: cover; }
#fab { display: none; position: absolute; right: 0; bottom: 0; box-sizing: border-box; width: 48px; height: 48px; align-items: center; justify-content: center; gap: 0; padding: 6px; overflow: hidden; border: 0; border-radius: 50%; background: rgba(255,255,255,.48); color: #863b5d; box-shadow: 0 0 0 3px rgba(244,90,141,.16), 0 0 22px 8px rgba(244,90,141,.36); cursor: pointer; transition: width .22s ease, gap .22s ease, padding .22s ease, border-radius .22s ease, background .22s ease, box-shadow .22s ease; }
#fab .fab-icon { width: 34px; height: 34px; flex: none; border-radius: 50%; object-fit: cover; }
#fab .fab-label { max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; font-size: 13px; font-weight: 650; transition: max-width .22s ease, opacity .18s ease; }
#fab:hover, #fab:focus-visible { width: 176px; justify-content: flex-start; gap: 9px; padding: 6px 12px 6px 6px; border-radius: 999px; background: rgba(255,255,255,.94); box-shadow: 0 0 0 2px rgba(244,90,141,.18), 0 0 20px 6px rgba(244,90,141,.28); }
#fab:hover .fab-label, #fab:focus-visible .fab-label { max-width: 180px; opacity: 1; }
#main { padding: 6px 14px 14px; }
#site-badge { display: inline-block; margin-bottom: 6px; padding: 2px 8px; border-radius: 99px; background: linear-gradient(135deg, #f45a8d, #d83f80); color: #fff; font-size: 10px; font-weight: 700; }
#site-badge.youtube { background: linear-gradient(135deg, #ff4e45, #cc0000); }
#title { margin: 0 0 8px; font-size: 13px; font-weight: 600; line-height: 1.5; word-break: break-word; white-space: normal; }
#controls { display: grid; gap: 8px; margin-bottom: 10px; }
.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #52617a; font-size: 12px; font-weight: 600; }
.field select { flex: 1; min-width: 0; max-width: 320px; padding: 5px 8px; border: 1px solid #e4e9f2; border-radius: 8px; background: #f7f8fc; color: #465777; font: inherit; font-size: 12px; }
.primary-button { min-height: 32px; padding: 0 14px; border: 0; border-radius: 9px; background: linear-gradient(135deg, #f45a8d, #d83f80); color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.primary-button:disabled { opacity: .55; cursor: wait; }
#download-list button.cancel, .primary-button.cancel { background: linear-gradient(135deg, #97a1b5, #6f7a92); }
#download-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; padding: 0; margin: 0 0 8px; list-style: none; }
#download-list > li { min-width: 0; padding: 10px; border: 1px solid #e5eaf3; border-radius: 16px; background: rgba(255,255,255,.78); box-shadow: 0 8px 24px rgba(56,73,110,.06); }
#download-list strong { display: block; font-size: 12px; line-height: 1.45; word-break: break-word; white-space: normal; }
#download-list .size { display: block; margin: 2px 0 6px; color: #8994a8; font-size: 11px; }
#download-list button { width: 100%; min-height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: linear-gradient(135deg, #f45a8d, #d83f80); color: #fff; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
#download-list button:disabled { opacity: .55; cursor: wait; }
#status { margin: 6px 0; color: #68758e; font-size: 11px; min-height: 16px; }
.empty { padding: 14px; border: 1px dashed #d8dfeb; border-radius: 10px; color: #8994a8; font-size: 12px; text-align: center; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }
`;


// 把样式注入 shadow root：优先 constructable stylesheet（不受页面 style-src
// 'unsafe-inline' 限制，Trusted Types 安全），不支持时回退 <style>。
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

// ---- 模块状态 ----------------------------------------------------------------
let panelRoot = null;        // Shadow root
let hostEl = null;           // 面板宿主元素
let ui = {};                 // 面板内各元素引用
let panelMode = "generic";   // "generic" | "youtube"
let youtubeResource = null;  // 当前 YouTube 资源
let renderedHlsKey = "";     // 已渲染的 HLS 清单键，避免重复解析
let lastGenericResources = [];
let isBusy = false;          // 是否有下载正在进行
let floatingEnabled = true;  // 悬浮按钮是否常驻（由 popup 经 relay 下发）
let activeRun = null;        // 进行中的下载（按钮原地切换「取消下载」）

// ---- 下载运行态：开始/结束/取消 ----------------------------------------------
// 按钮点击后原地变为「取消下载」（复用元素）；取消为终态：页内 AbortController
// 中断 + 后台 cancel-download 中断 + 立即 settle 桥接 Promise，迟到结果丢弃。
function beginRun(button) {
  isBusy = true;
  const run = { canceled: false, controller: new AbortController(), bgRequests: new Set() };
  activeRun = run;
  button.dataset.busy = "1";
  button.dataset.label = button.textContent;
  button.textContent = "取消下载";
  button.title = "取消当前下载";
  button.classList.add("cancel");
  return run;
}

function endRun(button, run) {
  if (activeRun === run) activeRun = null;
  isBusy = false;
  button.dataset.busy = "";
  button.textContent = button.dataset.label || "下载";
  button.title = "";
  button.classList.remove("cancel");
}

function cancelRun(run) {
  if (run.canceled) return;
  run.canceled = true;
  run.controller.abort();
  for (const requestId of run.bgRequests) {
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "cancel-download", requestId }, "*");
    for (const pendingMap of [hlsPending, directPending]) {
      const pending = pendingMap.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingMap.delete(requestId);
        pending.reject(new DOMException("已取消", "AbortError"));
      }
    }
  }
  setStatus("已取消。");
  log("下载已取消。");
}

function checkCanceled(run) {
  if (run?.canceled) throw new DOMException("已取消", "AbortError");
}

// 可取消按钮的统一点击接线：busy 时点击=取消，否则启动下载并原地切换按钮。
function wireCancelButton(button, execute) {
  button.addEventListener("click", () => {
    if (button.dataset.busy === "1") {
      if (activeRun) cancelRun(activeRun);
      return;
    }
    if (isBusy) return;
    const run = beginRun(button);
    Promise.resolve(execute(run)).catch(error => {
      if (run.canceled) return;
      log("下载失败：", error?.message || error);
      setStatus("下载失败：" + (error?.message || error));
    }).finally(() => endRun(button, run));
  });
}

// ---- 基础 UI 工具 ------------------------------------------------------------
function log(...parts) {
  if (!ui.logConsole) return;
  const text = parts.map(part => typeof part === "object" ? JSON.stringify(part) : String(part)).join(" ");
  ui.logConsole.line(text);
}

function setStatus(text) {
  if (ui.status) ui.status.textContent = text || "";
}

// 触发浏览器保存（创建临时 blob URL + 锚点点击）。
function saveBlob(buffer, mime, filename) {
  const blob = new Blob([buffer], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function outputName(title, ext, height) {
  const base = sanitizeFilename(title || "video");
  return `${base}${height ? `_${height}p` : ""}.${ext}`;
}

// 通用资源卡片（标题 + 大小 + 下载按钮）。cancelable 时按钮原地切换「取消下载」；
// 解析类操作（选择清晰度）保持旧的禁用逻辑。
function makeCard(label, sizeText, onClick, cancelable = false) {
  const li = document.createElement("li");
  const strong = document.createElement("strong");
  strong.textContent = label;
  strong.title = label;
  const size = document.createElement("span");
  size.className = "size";
  size.textContent = sizeText || "";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "下载";
  if (cancelable) {
    wireCancelButton(button, onClick);
  } else {
    button.addEventListener("click", async () => {
      if (isBusy) return;
      isBusy = true;
      button.disabled = true;
      try {
        await onClick();
      } catch (error) {
        log("下载失败：", error?.message || error);
        setStatus("下载失败：" + (error?.message || error));
      } finally {
        isBusy = false;
        button.disabled = false;
      }
    });
  }
  li.append(strong, size, button);
  return li;
}

function makeSelect(options) {
  const select = document.createElement("select");
  options.forEach((option, index) => {
    const el = document.createElement("option");
    el.value = String(index);
    el.textContent = option.label;
    select.appendChild(el);
  });
  return select;
}

function makeField(labelText, select) {
  const field = document.createElement("label");
  field.className = "field";
  const span = document.createElement("span");
  span.textContent = labelText;
  field.append(span, select);
  return field;
}

function clearPanel() {
  ui.controls.replaceChildren();
  ui.downloadList.replaceChildren();
}

// ---- 面板外壳：展开/收起 + 构建 ----------------------------------------------
let panelAnimation = null;
let fabAnimation = null;
function setOpen(open, animate = false) {
  const from = hostEl.getBoundingClientRect();
  localStorage.purrvid_show = open ? "show" : "hide";
  ui.content.classList.toggle("hide", !open);
  ui.fab.style.display = open ? "none" : (floatingEnabled ? "flex" : "none");
  if (panelAnimation) { panelAnimation.cancel(); panelAnimation = null; }
  if (fabAnimation) { fabAnimation.cancel(); fabAnimation = null; }
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!open) {
    hostEl.style.cssText = "display:block;position:fixed;z-index:2147483647;right:12px;bottom:12px;left:auto;top:auto;margin:0;width:48px;height:48px;overflow:visible;border:0;background:transparent;box-shadow:none;";
    // 常驻关闭且面板收起时，整个宿主隐藏（不留悬浮按钮）。
    if (!floatingEnabled) hostEl.style.display = "none";
    if (animate && !reduceMotion && typeof ui.fab.animate === "function") {
      fabAnimation = ui.fab.animate(
        [{ transform: "scale(1)" }, { transform: "scale(.8)" }, { transform: "scale(1)" }],
        { duration: 280, easing: "cubic-bezier(0.34,1.56,0.64,1)" }
      );
      fabAnimation.onfinish = () => { fabAnimation = null; };
    }
    return;
  }
  // 展开：与 B 站引擎一致的高度过渡（先量目标高度，再从收起态位移+缩放过渡）。
  hostEl.style.cssText = "display:block;position:fixed;z-index:2147483647;right:16px;bottom:16px;left:auto;top:auto;margin:0;width:min(480px,calc(100vw - 32px));height:auto;max-height:min(78vh,640px);overflow:hidden;border:1px solid rgba(255,255,255,.82);border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 18px 60px rgba(35,48,74,.22);backdrop-filter:blur(20px);";
  const measured = hostEl.getBoundingClientRect();
  hostEl.style.height = measured.height + "px";
  const target = hostEl.getBoundingClientRect();
  if (!animate || reduceMotion || typeof hostEl.animate !== "function") {
    hostEl.style.height = "auto";
    hostEl.style.overflow = "auto";
    return;
  }
  const scaleX = from.width / Math.max(target.width, 1);
  const scaleY = from.height / Math.max(target.height, 1);
  panelAnimation = hostEl.animate(
    [
      { transform: "translate(" + (from.left - target.left) + "px," + (from.top - target.top) + "px) scale(" + scaleX + "," + scaleY + ")", transformOrigin: "top left", opacity: 0.82 },
      { transform: "none", transformOrigin: "top left", opacity: 1 }
    ],
    { duration: 520, easing: "cubic-bezier(0.16,1,0.3,1)" }
  );
  panelAnimation.onfinish = () => {
    panelAnimation = null;
    hostEl.style.height = "auto";
    hostEl.style.overflow = "auto";
  };
}

// 用 DOM API 构建面板（不用 innerHTML，兼容 Trusted Types CSP）。
function ensurePanel() {
  if (panelRoot) return panelRoot;
  hostEl = document.getElementById(HOST_ID);
  if (!hostEl) {
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    document.body.appendChild(hostEl);
  }
  panelRoot = hostEl.shadowRoot || hostEl.attachShadow({ mode: "open" });
  applyStyles(panelRoot, CSS + LOG_CSS);

  const content = document.createElement("div");
  content.id = "content";
  const actions = document.createElement("div");
  actions.id = "actions";
  const panelTitle = document.createElement("h1");
  panelTitle.id = "panel-title";
  panelTitle.textContent = "星喵助手";
  const toggle = document.createElement("button");
  toggle.id = "toggle";
  toggle.type = "button";
  toggle.title = "收起";
  toggle.setAttribute("aria-label", "收起");
  const toggleIcon = document.createElement("img");
  toggleIcon.className = "toggle-icon";
  toggleIcon.src = PAW_URL;
  toggleIcon.alt = "";
  const toggleLabel = document.createElement("span");
  toggleLabel.className = "toggle-label";
  toggleLabel.textContent = "收起";
  toggle.append(toggleIcon, toggleLabel);
  actions.append(panelTitle, toggle);

  const main = document.createElement("div");
  main.id = "main";
  const badge = document.createElement("span");
  badge.id = "site-badge";
  badge.textContent = "通用";
  const title = document.createElement("h3");
  title.id = "title";
  const controls = document.createElement("div");
  controls.id = "controls";
  const downloadList = document.createElement("ul");
  downloadList.id = "download-list";
  const status = document.createElement("div");
  status.id = "status";
  const logs = document.createElement("div");
  logs.id = "helper-logs";
  logs.className = "pv-logs";
  main.append(badge, title, controls, downloadList, status, logs);
  content.append(actions, main);

  const fab = document.createElement("button");
  fab.id = "fab";
  fab.type = "button";
  fab.title = "打开星喵助手";
  fab.setAttribute("aria-label", "打开星喵助手");
  const fabIcon = document.createElement("img");
  fabIcon.className = "fab-icon";
  fabIcon.src = PAW_URL;
  fabIcon.alt = "";
  const fabLabel = document.createElement("span");
  fabLabel.className = "fab-label";
  fabLabel.textContent = "打开星喵助手";
  fab.append(fabIcon, fabLabel);
  panelRoot.append(content, fab);

  ui = { content, toggle, fab, badge, title, controls, downloadList, status, logs, logConsole: createLogConsole(logs, { title: "解析日志" }) };
  ui.toggle.addEventListener("click", () => setOpen(false, true));
  ui.fab.addEventListener("click", () => setOpen(true, true));
  setOpen(localStorage.purrvid_show === "show");
  return panelRoot;
}

function setBadge(text, cls) {
  ui.badge.textContent = text;
  ui.badge.className = cls || "";
}

function setTitle(text) {
  ui.title.textContent = text || "";
  ui.title.title = text || "";
}

function showEmpty(text) {
  clearPanel();
  const li = document.createElement("li");
  li.className = "empty";
  li.style.gridColumn = "1 / -1";
  li.textContent = text;
  ui.downloadList.appendChild(li);
}

async function fetchText(url, signal) {
  const response = await fetchWithRetry(url, { retries: 3, timeout: 30000, signal });
  return response.text();
}

// ---- YouTube 直链下载（googlevideo 分块） ------------------------------------
async function downloadGoogleVideo(format, onProgress, signal) {
  const baseUrl = cleanGoogleVideoUrl(format.finalUrl || format.url);
  const total = format.contentLength || googleVideoTotal(baseUrl);
  if (!total || total <= CHUNK_SIZE) {
    return downloadBuffer(baseUrl, { retries: 3, timeout: 300000, onProgress, signal });
  }
  const chunks = [];
  for (let start = 0; start < total; start += CHUNK_SIZE) {
    chunks.push({ start, end: Math.min(start + CHUNK_SIZE, total) - 1 });
  }
  const buffers = new Array(chunks.length);
  // 并发分块各自从 0 计 received，直接上报会互相覆盖导致进度回跳：
  // 汇总已完成块 + 各在途块实时字节，200ms 节流。
  const partial = new Array(chunks.length).fill(0);
  let completed = 0;
  let lastReport = 0;
  const report = force => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    onProgress?.({ received: completed + partial.reduce((sum, value) => sum + value, 0), total });
  };
  await mapLimit(chunks, CONCURRENCY, async (chunk, index) => {
    buffers[index] = await downloadBuffer(baseUrl, {
      retries: 3,
      timeout: 300000,
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
      onProgress: ({ received }) => { partial[index] = received; report(false); },
      signal
    });
    partial[index] = 0;
    completed += buffers[index].byteLength;
    report(true);
  }, signal);
  return concatBuffers(buffers);
}

function youtubeMergeContainer(videoExt, audioExt) {
  if (videoExt === "webm" && audioExt === "weba") return "webm";
  if (videoExt === "mp4" && audioExt === "m4a") return "mp4";
  return "mkv";
}

function youtubeMime(ext) {
  if (ext === "webm") return "video/webm";
  if (ext === "weba") return "audio/webm";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

// ---- 与 youtube-bridge 的解混淆桥接 ------------------------------------------
let rewriteSeq = 0;
const rewritePending = new Map();
function requestRewrite(urls) {
  return new Promise(resolve => {
    const messageId = ++rewriteSeq;
    const timer = setTimeout(() => {
      rewritePending.delete(messageId);
      resolve(urls.map(() => ""));
    }, 6000);
    rewritePending.set(messageId, { resolve, timer });
    window.postMessage({ source: YT_SOURCE, from: "isolated", type: "rewrite", messageId, urls }, "*");
  });
}

// ---- 与后台的 ffmpeg / HLS 桥接（经 panel-relay） ----------------------------
let ffmpegSeq = 0;
const ffmpegPending = new Map();
function requestFFmpeg(payload, transfer) {
  return new Promise((resolve, reject) => {
    const requestId = ++ffmpegSeq;
    const timer = setTimeout(() => {
      ffmpegPending.delete(requestId);
      reject(new Error("ffmpeg 处理超时"));
    }, 600000);
    ffmpegPending.set(requestId, { resolve, reject, timer });
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "ffmpeg", requestId, ...payload }, "*", transfer);
  });
}

function remuxWithFFmpeg(inputBytes, inputName, outputName, extraArgs = []) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  return requestFFmpeg({ op: "remux", inputName, outputName, extraArgs, inputBytes: bytes }, [bytes.buffer]);
}

function mergeWithFFmpeg(videoBytes, audioBytes, outputName, videoExt = "mp4", audioExt = "m4a") {
  const video = videoBytes instanceof Uint8Array ? videoBytes : new Uint8Array(videoBytes);
  const audio = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
  return requestFFmpeg({ op: "merge", outputName, videoExt, audioExt, videoBytes: video, audioBytes: audio }, [video.buffer, audio.buffer]);
}

let hlsSeq = 0;
const hlsPending = new Map();
function requestHlsBackground(payload) {
  return new Promise((resolve, reject) => {
    const requestId = ++hlsSeq;
    const timer = setTimeout(() => {
      hlsPending.delete(requestId);
      // 超时也要中断后台任务，否则面板回退页内时会与后台重复下载。
      window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "cancel-download", requestId }, "*");
      reject(new Error("HLS 下载超时"));
    }, 1800000);
    hlsPending.set(requestId, { resolve, reject, timer });
    activeRun?.bgRequests.add(requestId);
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "hls-download", requestId, ...payload }, "*");
  });
}

// ---- 与后台的 直连下载 / HLS 清单探测 桥接（跨域资源专用，经 panel-relay） ----
let directSeq = 0;
const directPending = new Map();
function requestDirectBackground(payload) {
  return new Promise((resolve, reject) => {
    const requestId = ++directSeq;
    const timer = setTimeout(() => {
      directPending.delete(requestId);
      window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "cancel-download", requestId }, "*");
      reject(new Error("直连下载超时"));
    }, 1800000);
    directPending.set(requestId, { resolve, reject, timer });
    activeRun?.bgRequests.add(requestId);
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "direct-download", requestId, ...payload }, "*");
  });
}

let probeSeq = 0;
const probePending = new Map();
function requestHlsProbe(url) {
  return new Promise((resolve, reject) => {
    const requestId = ++probeSeq;
    const timer = setTimeout(() => {
      probePending.delete(requestId);
      reject(new Error("清单探测超时"));
    }, 120000);
    probePending.set(requestId, { resolve, reject, timer });
    window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "hls-probe", requestId, url }, "*");
  });
}

// ---- 下载路由工具：同源留页内、跨域走后台、失败回退页内 ----------------------
function isCrossOrigin(url) {
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

// DRM / 直播是明确拒绝而非网络故障：回退页内也会得到同样结论，不做无谓重试。
function isPolicyError(error) {
  return /DRM|直播/.test(String(error?.message || error));
}

// ---- YouTube 渲染与下载 ------------------------------------------------------
function renderYoutube(resource) {
  youtubeResource = resource;
  panelMode = "youtube";
  // 优先走 HLS 清单（更稳）；同一清单不重复解析。
  if (resource.hlsManifestUrl) {
    const key = `${resource.videoId}|${resource.hlsManifestUrl}`;
    if (key === renderedHlsKey) return;
    renderedHlsKey = key;
    openHls({ kind: "hls", url: resource.hlsManifestUrl, title: resource.title, youtube: true, duration: resource.duration }).catch(error => {
      renderedHlsKey = "";
      ensurePanel();
      log("HLS 解析失败：", error?.message || error);
      setStatus("HLS 解析失败：" + (error?.message || error));
    });
    return;
  }
  renderedHlsKey = "";
  ensurePanel();
  setBadge("YouTube", "youtube");
  setTitle(resource.title);
  clearPanel();
  setStatus("");

  const usable = resource.formats.filter(format => format.url && !format.needsSig);
  if (!usable.length) {
    showEmpty("没有可直接下载的格式（可能受签名保护、需要登录或为直播）。");
    return;
  }
  const { videos, audio } = sortYoutubeFormats(usable);
  const videoOptions = videos.map(format => ({ label: youtubeFormatLabel(format) + (format.contentLength ? ` · ${formatSize(format.contentLength)}` : ""), format }));
  if (audio.length) videoOptions.push({ label: "无（仅下载音频）", format: null });
  const audioOptions = audio.map(format => ({ label: youtubeFormatLabel(format) + (format.contentLength ? ` · ${formatSize(format.contentLength)}` : ""), format }));
  if (videos.length) audioOptions.push({ label: "无（仅下载视频）", format: null });

  const videoSelect = makeSelect(videoOptions);
  const audioSelect = makeSelect(audioOptions.length ? audioOptions : [{ label: "内嵌音频（无需合并）", format: null }]);
  const button = document.createElement("button");
  button.className = "primary-button";
  button.type = "button";
  button.textContent = "下载";

  // 选择内嵌音频的 muxed 画质时，禁用音轨选择。
  const syncAudio = () => {
    const videoFormat = videoOptions[Number(videoSelect.value)]?.format;
    if (videoFormat && videoFormat.kind === "muxed") {
      audioSelect.disabled = true;
    } else {
      audioSelect.disabled = false;
    }
  };
  videoSelect.addEventListener("change", syncAudio);
  syncAudio();

  wireCancelButton(button, run => {
    const videoFormat = videoOptions[Number(videoSelect.value)]?.format || null;
    const audioFormat = audioSelect.disabled ? null : (audioOptions[Number(audioSelect.value)]?.format || null);
    if (!videoFormat && !audioFormat) { setStatus("未选择任何格式"); return; }
    return runYoutubeDownload(videoFormat, audioFormat, run);
  });

  ui.controls.append(makeField("画质", videoSelect), makeField("音轨", audioSelect), button);
  ui.logConsole.section("YouTube", "youtube");
  ui.logConsole.id({ 画质: videos.length, 音轨: audio.length });
  if (resource?.url) ui.logConsole.link("HLS 清单", resource.url);
  log("下载在本页进行，自动合并音视频。");
}

async function runYoutubeDownload(videoFormat, audioFormat, run) {
  const targets = [videoFormat, audioFormat].filter(Boolean);
  const rawUrls = targets.map(format => format.url);
  setStatus("正在刷新下载地址…");
  const freshUrls = await requestRewrite(rawUrls);
  targets.forEach((format, index) => { format.finalUrl = freshUrls[index] || rawUrls[index]; });

  const signal = run.controller.signal;
  let received = 0;
  const onProgress = ({ received: r }) => { received = r; setStatus(`正在下载… ${formatSize(received)}`); };
  const videoBuffer = videoFormat ? await downloadGoogleVideo(videoFormat, onProgress, signal) : null;
  const audioBuffer = audioFormat ? await downloadGoogleVideo(audioFormat, onProgress, signal) : null;
  checkCanceled(run);
  const height = videoFormat?.height || 0;
  const title = youtubeResource?.title || "youtube";

  if (videoBuffer && audioBuffer) {
    setStatus("正在合并音视频…");
    const container = youtubeMergeContainer(videoFormat.ext, audioFormat.ext);
    const merged = await mergeWithFFmpeg(videoBuffer, audioBuffer, `merged.${container}`, videoFormat.ext, audioFormat.ext);
    checkCanceled(run);
    saveBlob(merged, youtubeMime(container), outputName(title, container, height));
  } else if (videoBuffer) {
    saveBlob(videoBuffer, youtubeMime(videoFormat.ext), outputName(title, videoFormat.ext, height));
  } else {
    saveBlob(audioBuffer, youtubeMime(audioFormat.ext), outputName(title, audioFormat.ext));
  }
  setStatus("已完成，已触发浏览器保存。");
  log("下载完成。");
}

// ---- HLS / DASH 分段下载（页内通用路径；YouTube 走后台） ---------------------
async function downloadHlsTrack(media, label, signal) {
  const segments = media.segments;
  if (!segments.length) throw new Error("清单中没有媒体分段");
  const keyCache = new Map();
  const buffers = new Array(segments.length);
  const estimate = media.estimatedBytes ? ` / 约 ${formatSize(media.estimatedBytes)}` : "";
  let done = 0;
  let bytes = 0;
  // 字节级进度：已完成段累计 + 各在途段实时 received，200ms 节流刷新状态栏。
  const partial = new Array(segments.length).fill(0);
  let lastReport = 0;
  const report = force => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    const total = bytes + partial.reduce((sum, value) => sum + value, 0);
    setStatus(`${label} ${done}/${segments.length} · ${formatSize(total)}${estimate}`);
  };
  await mapLimit(segments, CONCURRENCY, async (segment, index) => {
    const headers = segment.byteRange
      ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
      : undefined;
    let buffer = await downloadBuffer(segment.url, {
      headers, retries: 3, signal,
      onProgress: ({ received }) => { partial[index] = received; report(false); }
    });
    // AES-128 自动解密（密钥按 URI 缓存）。
    if (segment.key?.method === "AES-128" && segment.key.uri) {
      if (!keyCache.has(segment.key.uri)) {
        const response = await fetchWithRetry(segment.key.uri, { retries: 3, timeout: 30000, signal });
        const keyBytes = new Uint8Array(await response.arrayBuffer());
        keyCache.set(segment.key.uri, await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]));
      }
      buffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: segment.key.iv }, keyCache.get(segment.key.uri), buffer);
    }
    buffers[index] = buffer;
    partial[index] = 0;
    bytes += buffer.byteLength;
    done++;
    report(true);
  }, signal);
  // 按顺序拼接，必要时插入 EXT-X-MAP 初始化段。
  const parts = [];
  const mapCache = new Map();
  let lastMapUrl = null;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.map && segment.map.url !== lastMapUrl) {
      const cacheKey = segment.map.url + (segment.map.byteRange ? `:${segment.map.byteRange.offset}` : "");
      if (!mapCache.has(cacheKey)) {
        const headers = segment.map.byteRange
          ? { Range: `bytes=${segment.map.byteRange.offset}-${segment.map.byteRange.offset + segment.map.byteRange.length - 1}` }
          : undefined;
        mapCache.set(cacheKey, await downloadBuffer(segment.map.url, { headers, retries: 3, signal }));
      }
      parts.push(mapCache.get(cacheKey));
      lastMapUrl = segment.map.url;
    }
    parts.push(buffers[index]);
  }
  return { buffer: concatBuffers(parts), container: isFmp4Segments(segments) ? "fmp4" : "ts", duration: media.totalDuration };
}

function dashExtOf(mimeType, isAudio) {
  if (/webm/.test(mimeType)) return isAudio ? "weba" : "webm";
  return isAudio ? "m4a" : "mp4";
}

async function downloadDashTrack(representation, label, signal) {
  const isAudio = representation.mimeType.startsWith("audio/");
  const ext = dashExtOf(representation.mimeType, isAudio);
  if (!representation.segments || !representation.segments.length) {
    const buffer = await downloadBuffer(representation.baseUrl, { retries: 3, signal });
    return { buffer, ext, mime: representation.mimeType };
  }
  const segments = representation.segments;
  const buffers = new Array(segments.length);
  let done = 0;
  await mapLimit(segments, CONCURRENCY, async (segment, index) => {
    const headers = segment.range
      ? { Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}` }
      : undefined;
    buffers[index] = await downloadBuffer(segment.url, { headers, retries: 3, signal });
    done++;
    setStatus(`${label} ${done}/${segments.length}`);
  }, signal);
  const parts = [];
  if (representation.init) {
    const headers = representation.init.range
      ? { Range: `bytes=${representation.init.range.offset}-${representation.init.range.offset + representation.init.range.length - 1}` }
      : undefined;
    parts.push(await downloadBuffer(representation.init.url, { headers, retries: 3, signal }));
  }
  parts.push(...buffers);
  return { buffer: concatBuffers(parts), ext, mime: representation.mimeType };
}

// ---- 下载执行器 --------------------------------------------------------------
// 后台 HLS 下载入口（YouTube 与跨域通用资源共用），成功后保存并记录日志。
async function runHlsViaBackground(resource, mediaUrl, audioRendition, height, run, estimatedBytes) {
  setStatus("正在后台下载分片…");
  const result = await requestHlsBackground({
    mediaUrl,
    audioUrl: audioRendition?.url || "",
    title: resource.title || "video",
    height,
    // pageUrl 仅通用资源传入：后台据此按任务补 Referer/Origin 并拒绝直播。
    pageUrl: resource.youtube ? "" : location.href,
    estimatedBytes: estimatedBytes || 0
  });
  checkCanceled(run);
  saveBlob(result.buffer, "video/mp4", outputName(resource.title || "video", result.ext || "mp4", result.height));
  setStatus("已完成，已触发浏览器保存。");
  log("HLS 下载完成。");
}

async function runHlsDownload(resource, variant, audioRendition, run) {
  const mediaUrl = variant ? variant.url : resource.url;
  const height = variant?.height || resource.height || 0;
  const signal = run.controller.signal;
  // YouTube 与跨域通用 HLS：分片下载与合并都委托后台（豁免 CORS / CSP）。
  if (resource.youtube || isCrossOrigin(mediaUrl)) {
    try {
      await runHlsViaBackground(resource, mediaUrl, audioRendition, height, run, variant?.estimatedBytes);
      return;
    } catch (error) {
      if (resource.youtube || run.canceled || isPolicyError(error)) throw error;
      log("后台下载失败，回退页内重试：", error?.message || error);
    }
  }
  const media = parseMedia(await fetchText(mediaUrl, signal), mediaUrl);
  media.estimatedBytes = variant?.estimatedBytes || 0;
  if (media.drm) throw new Error("该 HLS 流受 DRM 保护，无法下载。");
  if (!media.endList && !resource.youtube) throw new Error("这是直播流（无 ENDLIST），不支持完整下载。");
  const videoTrack = await downloadHlsTrack(media, "视频分段", signal);
  let audioTrack = null;
  if (audioRendition) {
    const audioMedia = parseMedia(await fetchText(audioRendition.url, signal), audioRendition.url);
    if (audioMedia.drm) throw new Error("音频流受 DRM 保护，无法下载。");
    audioTrack = await downloadHlsTrack(audioMedia, "音频分段", signal);
  }
  checkCanceled(run);
  const title = resource.title || "video";
  if (audioTrack) {
    setStatus("正在合并音视频…");
    const merged = await mergeWithFFmpeg(videoTrack.buffer, audioTrack.buffer, "merged.mp4", "mp4", "m4a");
    checkCanceled(run);
    saveBlob(merged, "video/mp4", outputName(title, "mp4", height));
  } else if (videoTrack.container === "ts") {
    setStatus("正在转封装…");
    const remuxed = await remuxWithFFmpeg(videoTrack.buffer, "input.ts", "output.mp4", ["-movflags", "+faststart"]);
    checkCanceled(run);
    saveBlob(remuxed, "video/mp4", outputName(title, "mp4", height));
  } else {
    saveBlob(videoTrack.buffer, "video/mp4", outputName(title, "mp4", height));
  }
  setStatus("已完成，已触发浏览器保存。");
  log("HLS 下载完成。");
}

async function runDashDownload(resource, videoRep, audioRep, run) {
  const signal = run.controller.signal;
  const videoTrack = videoRep ? await downloadDashTrack(videoRep, "视频流", signal) : null;
  const audioTrack = audioRep ? await downloadDashTrack(audioRep, "音频流", signal) : null;
  checkCanceled(run);
  const title = resource.title || "video";
  if (videoTrack && audioTrack) {
    setStatus("正在合并音视频…");
    const outExt = videoTrack.ext === "webm" ? "webm" : "mp4";
    const merged = await mergeWithFFmpeg(videoTrack.buffer, audioTrack.buffer, `merged.${outExt}`, videoTrack.ext, audioTrack.ext);
    checkCanceled(run);
    saveBlob(merged, outExt === "webm" ? "video/webm" : "video/mp4", outputName(title, outExt, videoRep?.height));
  } else if (videoTrack) {
    saveBlob(videoTrack.buffer, videoTrack.mime || "video/mp4", outputName(title, videoTrack.ext, videoRep?.height));
  } else {
    saveBlob(audioTrack.buffer, audioTrack.mime || "audio/mp4", outputName(title, audioTrack.ext));
  }
  setStatus("已完成，已触发浏览器保存。");
  log("DASH 下载完成。");
}

async function downloadDirect(resource, run) {
  setStatus("正在下载…");
  const ext = resource.ext || "mp4";
  const mime = resource.kind === "audio" ? "audio/mp4" : "video/mp4";
  let buffer = null;
  // 跨域直连优先后台（豁免页面 CORS / CSP）；失败回退页内，保证不比旧版差。
  if (isCrossOrigin(resource.url)) {
    try {
      const result = await requestDirectBackground({ url: resource.url, ext });
      checkCanceled(run);
      buffer = result.buffer;
    } catch (error) {
      if (run.canceled || isPolicyError(error)) throw error;
      log("后台下载失败，回退页内重试：", error?.message || error);
    }
  }
  if (!buffer) {
    buffer = await downloadBuffer(resource.url, {
      retries: 3,
      timeout: 300000,
      signal: run.controller.signal,
      onProgress: ({ received }) => setStatus(`正在下载… ${formatSize(received)}`)
    });
  }
  checkCanceled(run);
  saveBlob(buffer, mime, outputName(resource.title, ext));
  setStatus("已完成，已触发浏览器保存。");
  log("下载完成：", resource.url);
}

// ---- 清晰度/音轨选择控件渲染 -------------------------------------------------
function renderStreamControls(resource, videoOptions, audioOptions, execute) {
  clearPanel();
  setStatus("");
  const videoSelect = makeSelect(videoOptions);
  const audioSelect = makeSelect(audioOptions.length ? audioOptions : [{ label: "无", value: null }]);
  const button = document.createElement("button");
  button.className = "primary-button";
  button.type = "button";
  button.textContent = "下载";
  wireCancelButton(button, run => {
    const video = videoOptions[Number(videoSelect.value)]?.value ?? null;
    const audio = audioOptions[Number(audioSelect.value)]?.value ?? null;
    return execute(video, audio, run);
  });
  ui.controls.append(makeField("视频", videoSelect), makeField("音频", audioSelect), button);
}

// 清单文本获取：跨域优先后台探测（豁免 CORS / CSP），失败回退页内。
async function fetchManifestText(resource, url, signal) {
  if (!resource.youtube && isCrossOrigin(url)) {
    try {
      return (await requestHlsProbe(url)).text;
    } catch (error) {
      if (isPolicyError(error)) throw error;
      log("后台清单探测失败，回退页内重试：", error?.message || error);
    }
  }
  return fetchText(url, signal);
}

async function openHls(resource) {
  ensurePanel();
  panelMode = "generic";
  setBadge(resource.youtube ? "YouTube" : "HLS", resource.youtube ? "youtube" : "");
  setTitle(resource.title || resource.url);
  clearPanel();
  setStatus("正在解析清单…");
  const text = await fetchManifestText(resource, resource.url);
  if (isMasterPlaylist(text)) {
    const master = parseMaster(text, resource.url);
    if (!master.variants.length) { showEmpty("未找到可用的清晰度。"); return; }
    // 时长优先用资源自带（YouTube lengthSeconds）；否则取首个变体媒体清单。
    let duration = resource.duration || 0;
    if (!duration) {
      try {
        const firstUrl = master.variants[0].url;
        duration = parseMedia(await fetchManifestText(resource, firstUrl), firstUrl).totalDuration;
      } catch {
        // 取不到时长就不显示预估大小，不影响下载。
      }
    }
    const videoOptions = master.variants.map(variant => {
      const estimatedBytes = duration && variant.bandwidth ? Math.round(variant.bandwidth / 8 * duration) : 0;
      variant.estimatedBytes = estimatedBytes;
      const label = [
        variant.height ? `${variant.height}p` : "",
        variant.bandwidth ? `${(variant.bandwidth / 1e6).toFixed(2)}Mbps` : "",
        estimatedBytes ? `约 ${formatSize(estimatedBytes)}` : "",
        variant.name
      ].filter(Boolean).join(" · ") || variant.url;
      return { label, value: variant };
    });
    // 音轨去重（按 URL）；同名音轨追加语言/itag 以区分。
    const seenAudio = new Set();
    const renditions = master.audioRenditions.filter(rendition => {
      if (seenAudio.has(rendition.url)) return false;
      seenAudio.add(rendition.url);
      return true;
    });
    const audioLabel = rendition => {
      const name = rendition.name || rendition.language || "音频";
      const lang = rendition.language && rendition.language !== rendition.name ? ` · ${rendition.language}` : "";
      return name + lang + (rendition.default ? "（默认）" : "");
    };
    const labelCounts = new Map();
    for (const rendition of renditions) {
      const label = audioLabel(rendition);
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
    const audioOptions = renditions.map(rendition => {
      let label = audioLabel(rendition);
      if (labelCounts.get(label) > 1) {
        const itag = (rendition.url.match(/\/itag\/(\d+)/) || [])[1];
        if (itag) label += ` · itag${itag}`;
      }
      return { label, value: rendition };
    });
    audioOptions.sort((a, b) => (b.value?.default ? 1 : 0) - (a.value?.default ? 1 : 0));
    audioOptions.push({ label: "无（仅视频）", value: null });
    renderStreamControls(resource, videoOptions, audioOptions, (variant, rendition, run) => runHlsDownload(resource, variant, rendition, run));
    ui.logConsole.section(resource.youtube ? "YouTube HLS" : "HLS 主清单", resource.youtube ? "youtube" : "hls");
    ui.logConsole.id({ 清晰度: master.variants.length, 音轨: renditions.length });
    ui.logConsole.link("主清单", resource.url);
  } else {
    const media = parseMedia(text, resource.url);
    if (media.drm) { showEmpty("该 HLS 流受 DRM 保护，无法下载。"); return; }
    if (!media.endList && !resource.youtube) { showEmpty("这是直播流，不支持完整下载。"); return; }
    renderStreamControls(resource, [{ label: `默认 (${formatDuration(media.totalDuration)})`, value: null }], [], (video, audio, run) => runHlsDownload(resource, null, null, run));
    ui.logConsole.section(resource.youtube ? "YouTube HLS" : "HLS 媒体清单", resource.youtube ? "youtube" : "hls");
    ui.logConsole.id({ 时长: formatDuration(media.totalDuration) });
    ui.logConsole.link("媒体清单", resource.url);
  }
}

async function openDash(resource) {
  ensurePanel();
  panelMode = "generic";
  setBadge("DASH");
  setTitle(resource.title || resource.url);
  clearPanel();
  setStatus("正在解析清单…");
  const mpd = parseMPD(await fetchText(resource.url), resource.url);
  if (mpd.drm) { showEmpty("该 DASH 流受 DRM 保护，无法下载。"); return; }
  if (mpd.live) { showEmpty("这是动态（直播）MPD，不支持完整下载。"); return; }
  if (!mpd.video.length && !mpd.audio.length) { showEmpty("MPD 中没有可用的媒体流。"); return; }
  const videoOptions = mpd.video.map(representation => ({ label: representationLabel(representation), value: representation }));
  if (mpd.audio.length) videoOptions.push({ label: "无（仅下载音频）", value: null });
  const audioOptions = mpd.audio.map(representation => ({ label: representationLabel(representation), value: representation }));
  if (mpd.video.length) audioOptions.push({ label: "无（仅下载视频）", value: null });
  renderStreamControls(resource, videoOptions, audioOptions, (videoRep, audioRep, run) => runDashDownload(resource, videoRep, audioRep, run));
  ui.logConsole.section("DASH", "dash");
  ui.logConsole.id({ 视频流: mpd.video.length, 音频流: mpd.audio.length });
  ui.logConsole.link("MPD", resource.url);
}

// ---- 通用资源列表渲染 --------------------------------------------------------
function renderGeneric(resources) {
  lastGenericResources = resources;
  if (panelMode === "youtube" || isYoutubePage(location.href)) return;
  ensurePanel();
  setBadge("通用嗅探");
  setTitle(document.title.replace(/_哔哩哔哩_bilibili$/i, "").slice(0, 120) || "本页媒体资源");
  clearPanel();
  setStatus("");
  const usable = resources.filter(resource => !resource.drm && resource.kind !== "mse" && !resource.live);
  if (!usable.length) {
    showEmpty("暂未发现可下载的媒体资源。播放视频后会自动嗅探。");
    return;
  }
  for (const resource of usable) {
    const label = resource.title || resource.host || resource.url;
    const sizeText = [resource.kind.toUpperCase(), resource.size ? formatSize(resource.size) : "", resource.info || ""].filter(Boolean).join(" · ");
    const card = makeCard(label, sizeText, async run => {
      if (resource.kind === "hls") await openHls(resource);
      else if (resource.kind === "dash") await openDash(resource);
      else await downloadDirect(resource, run);
    }, resource.kind !== "hls" && resource.kind !== "dash");
    if (resource.kind === "hls" || resource.kind === "dash") {
      card.querySelector("button").textContent = "选择清晰度";
    }
    ui.downloadList.appendChild(card);
  }
  ui.logConsole.heading("嗅探结果");
  ui.logConsole.id({ 可下载资源: usable.length });
  for (const resource of usable) ui.logConsole.link(resource.kind.toUpperCase(), resource.url);
}

// ---- 消息处理与启动 ----------------------------------------------------------
function onYoutubePlayer(payload) {
  const resource = buildYoutubeResource({
    videoDetails: payload.videoDetails,
    streamingData: payload.streamingData,
    rewrittenUrls: payload.rewrittenUrls,
    hlsManifestUrl: payload.hlsManifestUrl,
    pageUrl: payload.pageUrl,
    title: document.title
  });
  if (resource) renderYoutube(resource);
}

function handleRelayMessage(data) {
  if (data.type === "resources") {
    if (panelMode !== "youtube") renderGeneric(data.resources || []);
  } else if (data.type === "floating-enabled") {
    floatingEnabled = data.value !== false;
    // 仅影响收起态的悬浮按钮；面板展开时不打断。
    if (localStorage.purrvid_show !== "show") setOpen(false);
  } else if (data.type === "open-panel") {
    setOpen(true, true);
  }
}

function startUniversalPanel() {
  // 引擎已建好面板时不重复初始化。
  if (document.getElementById(HOST_ID)?.shadowRoot?.getElementById("panel-title")) return;
  ensurePanel();
  if (isYoutubePage(location.href)) {
    setBadge("YouTube", "youtube");
    setTitle(document.title.replace(/ - YouTube$/i, "").slice(0, 120) || "YouTube 视频");
    showEmpty("正在等待 YouTube 播放器解析…请先播放视频。");
  } else {
    setBadge("通用嗅探");
    showEmpty("正在等待媒体资源…播放视频后会自动嗅探。");
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // 来自 youtube-bridge：播放器解析结果 / 解混淆回包。
    if (data.source === YT_SOURCE && data.from === "bridge") {
      if (data.type === "player") onYoutubePlayer(data.payload);
      else if (data.type === "rewrite-result") {
        const pending = rewritePending.get(data.messageId);
        if (pending) {
          clearTimeout(pending.timer);
          rewritePending.delete(data.messageId);
          pending.resolve(Array.isArray(data.urls) ? data.urls : []);
        }
      }
    // 来自 panel-relay：ffmpeg / HLS 结果与进度 / 资源列表。
    } else if (data.source === RELAY_SOURCE && data.from === "relay") {
      if (data.type === "ffmpeg-result") {
        const pending = ffmpegPending.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          ffmpegPending.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve(data.buffer);
        }
      } else if (data.type === "hls-result") {
        const pending = hlsPending.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          hlsPending.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve({ buffer: data.buffer, ext: data.ext, height: data.height });
        }
      } else if (data.type === "hls-progress") {
        if (hlsPending.has(data.requestId) && !activeRun?.canceled) setStatus(data.text || "");
      } else if (data.type === "direct-result") {
        const pending = directPending.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          directPending.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve({ buffer: data.buffer, ext: data.ext });
        }
      } else if (data.type === "direct-progress") {
        if (directPending.has(data.requestId) && !activeRun?.canceled) setStatus(data.text || "");
      } else if (data.type === "hls-probe-result") {
        const pending = probePending.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          probePending.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve({ text: data.text, master: data.master });
        }
      } else {
        handleRelayMessage(data);
      }
    }
  });

  // 通知 relay 面板就绪，请求资源列表。
  window.postMessage({ source: RELAY_SOURCE, from: "panel", type: "ready" }, "*");
}

export function initUniversalPanel() {
  if (document.body) startUniversalPanel();
  else document.addEventListener("DOMContentLoaded", startUniversalPanel, { once: true });
}