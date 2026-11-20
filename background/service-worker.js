// ============================================================================
// background/service-worker.js — 后台中枢（MV3 service worker · module）
// ============================================================================
// 架构总览（星喵助手）：
//
//   页面 MAIN world                      isolated world              后台（本文件）
//   ┌─────────────────────────┐         ┌──────────────────┐        ┌────────────────────┐
//   │ bilibili-engine.js      │         │ content/loader.js│ 注入   │ 资源嗅探/校验/存储  │
//   │  └ universal-panel.js   │◄───────►│ content/panel-   │◄──────►│ 任务队列管理        │
//   │ content/youtube-bridge.js│postMsg │   relay.js       │runtime │ ffmpeg 合并/转封装  │
//   └─────────────────────────┘         │ content/media-   │消息    │ HLS 后台下载        │
//                                        │   sniffer.js     │        │ DNR 请求头改写      │
//                                        └──────────────────┘        └────────────────────┘
//   任务管理页 tasks/tasks.html 通过 runtime 消息与本文件同步任务状态。
//
// 为什么 ffmpeg / HLS 下载放后台：页面与 isolated world 都受页面 Trusted Types
//   CSP 限制（无法 new Worker），且 googlevideo 跨域重定向会丢失 CORS 头；后台
//   扩展上下文豁免这两者（host_permissions + worker-src 'self'）。
//
// runtime 消息协议（type 字段）：
//   嗅探/资源：media-found · youtube-resource · yt-rewrite · scan-result ·
//             get-resources · set-sniff-enabled · clear-resources · resources-updated(广播)
//   面板：    set-floating-enabled · floating-enabled(→所有标签页) · open-panel(→活动标签页) ·
//             panel-activate(→记录到资源的标签页，通知按需注入面板)
//   任务：    start-task · get-tasks · tasks-page-ready · update-task · remove-task ·
//             tasks-updated(广播)
//   下载：    ffmpeg · hls-download · hls-progress(→标签页) ·
//             direct-download(通用直连) · direct-progress(→标签页) · hls-probe(清单探测) ·
//             cancel-download(中断指定 requestId 的后台下载)
//
// 存储：local.sniffEnabled / local.floatingEnabled（开关）；session.res:<tabId> / session.tasks（断点恢复）。
// ============================================================================

import {
  classifyMediaUrl,
  normalizeMediaUrl,
  hostOf,
  formatDuration,
  formatSize,
  downloadBuffer,
  fetchWithRetry
} from "../lib/media-utils.js";
import { isYoutubePage, buildYoutubeResource } from "../lib/youtube.js";
import { runFfmpeg } from "../lib/ffmpeg-host.js";
import { attachHeavyServer } from "../lib/transport.js";
import { fetchHlsMedia, downloadHlsTrack } from "../lib/hls.js";
import { isMasterPlaylist } from "../lib/m3u8.js";
import { acquireHeaderRules } from "../lib/request-headers.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ---- 常量与状态 --------------------------------------------------------------
const MAX_PER_TAB = 80;                       // 每标签页最多保留的资源数
const TASKS_PAGE = api.runtime.getURL("tasks/tasks.html");
const sessionStore = api.storage.session || null;

const tabResources = new Map();   // tabId → Map(url → resource)
const tabTitles = new Map();      // tabId → 页面标题
const youtubeTabs = new Set();    // 标记 YouTube 标签页（跳过通用嗅探）
let tasks = [];                   // 下载任务列表
let settings = { sniffEnabled: true, floatingEnabled: true };
let taskSeq = 0;                  // 任务自增 id

// ---- 会话持久化（防抖写 session storage，service worker 重启后可恢复）--------
const saveTimers = new Map();
function persist(key, value) {
  if (!sessionStore) return;
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    sessionStore.set({ [key]: value }).catch(() => {});
  }, 400));
}

function persistTab(tabId) {
  const resources = tabResources.get(tabId);
  persist(`res:${tabId}`, resources ? [...resources.values()] : null);
}

function persistTasks() {
  persist("tasks", tasks);
}

async function restoreState() {
  try {
    const local = await api.storage.local.get({ sniffEnabled: true, floatingEnabled: true });
    settings.sniffEnabled = local.sniffEnabled !== false;
    settings.floatingEnabled = local.floatingEnabled !== false;
  } catch {}
  if (!sessionStore) return;
  try {
    const all = await sessionStore.get(null);
    for (const [key, value] of Object.entries(all || {})) {
      if (key.startsWith("res:") && Array.isArray(value)) {
        const tabId = Number(key.slice(4));
        if (Number.isInteger(tabId)) tabResources.set(tabId, new Map(value.map(item => [item.url, item])));
      } else if (key === "tasks" && Array.isArray(value)) {
        tasks = value;
        taskSeq = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0);
      }
    }
    for (const tabId of tabResources.keys()) updateBadge(tabId);
  } catch {}
}

// ---- 资源记录与角标 ----------------------------------------------------------
function isBilibiliUrl(url) {
  const host = hostOf(url || "");
  return host === "bilibili.com" || host.endsWith(".bilibili.com");
}

function updateBadge(tabId) {
  const count = tabResources.get(tabId)?.size || 0;
  api.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: "#d83f80" }).catch(() => {});
}

// 合并同 URL 资源（保留已有的更优字段）；超限时淘汰最旧的非流媒体资源。
function touchResource(tabId, resource) {
  let resources = tabResources.get(tabId);
  if (!resources) {
    resources = new Map();
    tabResources.set(tabId, resources);
  }
  const existing = resources.get(resource.url);
  if (existing) {
    const merged = {
      ...existing,
      ...resource,
      title: resource.title || existing.title,
      size: resource.size || existing.size,
      width: resource.width || existing.width,
      height: resource.height || existing.height,
      drm: existing.drm || resource.drm,
      info: resource.info || existing.info,
      verified: existing.verified || resource.verified
    };
    resources.set(resource.url, merged);
    return merged;
  }
  if (resources.size >= MAX_PER_TAB) {
    const oldest = [...resources.values()].find(item => item.kind !== "hls" && item.kind !== "dash");
    if (oldest) resources.delete(oldest.url);
    else return null;
  }
  resources.set(resource.url, resource);
  return resource;
}

function recordMedia(tabId, rawUrl, extra = {}) {
  if (!settings.sniffEnabled || tabId < 0) return null;
  const url = normalizeMediaUrl(rawUrl);
  if (!url) return null;
  const classified = classifyMediaUrl(url, extra.mime || "");
  if (!classified && !extra.kind) return null;
  const kind = extra.kind || classified.kind;
  if (kind === "segment") return null;

  const resource = {
    url,
    kind,
    ext: extra.ext || classified?.ext || "",
    mime: extra.mime || "",
    size: extra.size || 0,
    title: extra.title || tabTitles.get(tabId) || "",
    host: hostOf(url),
    width: extra.width || 0,
    height: extra.height || 0,
    drm: Boolean(extra.drm),
    verified: Boolean(extra.verified),
    info: extra.info || "",
    frameId: Number.isInteger(extra.frameId) ? extra.frameId : null,
    source: extra.source || "network",
    ts: Date.now()
  };
  const saved = touchResource(tabId, resource);
  if (saved) {
    updateBadge(tabId);
    persistTab(tabId);
    broadcast({ type: "resources-updated", tabId });
    notifyPanel(tabId);
  }
  return saved;
}

function broadcast(message) {
  api.runtime.sendMessage(message).catch(() => {});
}

// 记录到媒体后通知标签页按需注入面板（内容脚本只收 tabs.sendMessage）。
// 面板未注入的站点由此出现悬浮按钮；无媒体站点永远不打扰。
function notifyPanel(tabId) {
  if (tabId != null && tabId >= 0) {
    api.tabs.sendMessage(tabId, { type: "panel-activate" }).catch(() => {});
  }
}

// ---- 流媒体校验：探测 HLS/DASH 清单，标记 DRM / 直播 / 清晰度数 ----------------
const verifying = new Set();
async function verifyStreamResource(tabId, resource) {
  if (verifying.has(resource.url) || resource.verified) return;
  verifying.add(resource.url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let text = "";
    try {
      const response = await fetch(resource.url, { credentials: "include", signal: controller.signal });
      if (!response.ok) return;
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          text += decoder.decode(value, { stream: true });
          if (received > 2 * 1024 * 1024) break;   // 最多读 2MB 足以判定清单类型
        }
        reader.cancel().catch(() => {});
      } else {
        text = await response.text();
      }
    } finally {
      clearTimeout(timer);
    }

    const patch = { verified: true };
    if (resource.kind === "hls") {
      if (!/^\uFEFF?\s*#EXTM3U/i.test(text)) {
        removeResource(tabId, resource.url);
        return;
      }
      // DRM：SAMPLE-AES 或 Widevine/PlayReady/FairPlay 密钥格式 → 拒绝下载。
      if (/#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(text) || /#EXT-X-SESSION-KEY:[^\n]*KEYFORMAT="(urn:uuid:edef8ba9|com\.widevine|com\.microsoft|com\.apple)/i.test(text)) {
        patch.drm = true;
        patch.info = "DRM 加密，无法下载";
      } else if (/#EXT-X-KEY:[^\n]*METHOD=AES-128/i.test(text)) {
        patch.info = "AES-128 加密（可自动解密）";
      }
      const variants = text.match(/#EXT-X-STREAM-INF/g);
      if (variants) {
        patch.info = patch.info || `${variants.length} 个清晰度可选`;
      } else {
        const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
        const total = durations.reduce((sum, value) => sum + value, 0);
        if (total > 0) patch.info = patch.info || formatDuration(total);
        if (!/#EXT-X-ENDLIST/i.test(text) && /#EXTINF/i.test(text)) {
          patch.info = "直播流，不支持完整下载";
          patch.live = true;
        }
      }
    } else if (resource.kind === "dash") {
      if (!/<MPD[\s>]/i.test(text)) {
        removeResource(tabId, resource.url);
        return;
      }
      if (/<ContentProtection/i.test(text)) {
        patch.drm = true;
        patch.info = "DRM 加密，无法下载";
      } else {
        const videos = (text.match(/<Representation[^>]*mimeType="video/gi) || []).length || (text.match(/<Representation/gi) || []).length;
        if (videos) patch.info = patch.info || `${videos} 个媒体流可选`;
      }
    }
    const resources = tabResources.get(tabId);
    const current = resources?.get(resource.url);
    if (current) {
      Object.assign(current, patch);
      persistTab(tabId);
      broadcast({ type: "resources-updated", tabId });
    }
  } catch {
    // 验证失败（如需鉴权）时保留候选，交给任务页重试。
  } finally {
    verifying.delete(resource.url);
  }
}

function removeResource(tabId, url) {
  const resources = tabResources.get(tabId);
  if (!resources) return;
  resources.delete(url);
  updateBadge(tabId);
  persistTab(tabId);
  broadcast({ type: "resources-updated", tabId });
}

// ---- 网络嗅探：webRequest 监听媒体请求 ---------------------------------------
api.webRequest.onBeforeRequest.addListener(
  details => {
    if (!settings.sniffEnabled || details.tabId < 0) return;
    const pageUrl = details.documentUrl || details.originUrl || details.initiator || "";
    if (isBilibiliUrl(pageUrl)) return;
    if (isYoutubePage(pageUrl)) {
      youtubeTabs.add(details.tabId);
      return;
    }
    const classified = classifyMediaUrl(details.url, "");
    if (!classified) return;
    const resource = recordMedia(details.tabId, details.url, { source: "network" });
    if (resource && (resource.kind === "hls" || resource.kind === "dash")) {
      verifyStreamResource(details.tabId, resource);
    }
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other", "object"] }
);

api.webRequest.onHeadersReceived.addListener(
  details => {
    if (!settings.sniffEnabled || details.tabId < 0) return;
    const pageUrl = details.documentUrl || details.originUrl || details.initiator || "";
    if (isBilibiliUrl(pageUrl)) return;
    if (isYoutubePage(pageUrl)) {
      youtubeTabs.add(details.tabId);
      return;
    }
    const headers = details.responseHeaders || [];
    const get = name => headers.find(header => header.name.toLowerCase() === name)?.value || "";
    const mime = get("content-type");
    const length = Number(get("content-length")) || 0;
    const url = normalizeMediaUrl(details.url);
    if (!url) return;

    const resources = tabResources.get(details.tabId);
    const existing = resources?.get(url);
    if (existing) {
      if (mime) existing.mime = mime;
      if (length && !existing.size) existing.size = length;
      // 过小的直连文件多半是占位/广告，剔除。
      if (existing.kind === "direct" && existing.size && existing.size < 20 * 1024) {
        removeResource(details.tabId, url);
        return;
      }
      persistTab(details.tabId);
      broadcast({ type: "resources-updated", tabId: details.tabId });
      return;
    }
    const classified = classifyMediaUrl(url, mime);
    if (!classified) return;
    if (classified.kind === "direct" && length && length < 20 * 1024) return;
    const resource = recordMedia(details.tabId, url, { mime, size: length, source: "network" });
    if (resource && (resource.kind === "hls" || resource.kind === "dash")) {
      verifyStreamResource(details.tabId, resource);
    }
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

// ---- 标签页生命周期：导航/关闭时清理资源 -------------------------------------
api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title) tabTitles.set(tabId, changeInfo.title);
  if (changeInfo.url) {
    tabResources.delete(tabId);
    youtubeTabs.delete(tabId);
    if (sessionStore) sessionStore.remove(`res:${tabId}`).catch(() => {});
    updateBadge(tabId);
    broadcast({ type: "resources-updated", tabId });
  }
  if (tab?.title && !tabTitles.has(tabId)) tabTitles.set(tabId, tab.title);
});

api.tabs.onRemoved.addListener(tabId => {
  tabResources.delete(tabId);
  tabTitles.delete(tabId);
  youtubeTabs.delete(tabId);
  if (sessionStore) sessionStore.remove(`res:${tabId}`).catch(() => {});
});

// ---- 任务管理页：复用已打开的标签页 ------------------------------------------
async function openTasksPage() {
  const existing = await api.tabs.query({ url: TASKS_PAGE });
  if (existing.length) {
    await api.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) {
      await api.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
    }
    return existing[0].id;
  }
  const tab = await api.tabs.create({ url: TASKS_PAGE });
  return tab.id;
}

// ---- YouTube 资源记录（由 youtube-bridge 经面板/转发上报） -------------------
function recordYoutube(tabId, payload, title, pageUrl) {
  if (!settings.sniffEnabled || tabId < 0 || !payload) return;
  const resource = buildYoutubeResource({
    videoDetails: payload.videoDetails,
    streamingData: payload.streamingData,
    rewrittenUrls: payload.rewrittenUrls,
    pageUrl: payload.pageUrl || pageUrl,
    title
  });
  if (!resource) return;
  let resources = tabResources.get(tabId);
  if (!resources) {
    resources = new Map();
    tabResources.set(tabId, resources);
  }
  // 每个标签页只保留一条最新的 YouTube 资源。
  for (const [key, item] of resources) {
    if (item.kind === "youtube") resources.delete(key);
  }
  const full = {
    ...resource,
    ext: "mp4",
    mime: "video/mp4",
    drm: false,
    verified: true,
    frameId: 0,
    source: "youtube",
    tabId,
    ts: Date.now()
  };
  resources.set(full.url, full);
  updateBadge(tabId);
  persistTab(tabId);
  broadcast({ type: "resources-updated", tabId });
  notifyPanel(tabId);
}

// ---- 合并 DOM 嗅探结果（来自 media-sniffer / 主动扫描） ----------------------
function mergeDomItems(tabId, items, title, source, frameId) {
  if (youtubeTabs.has(tabId)) return 0;
  let added = 0;
  for (const item of items || []) {
    if (!item || typeof item.url !== "string") continue;
    const itemFrameId = Number.isInteger(item.frameId) ? item.frameId : frameId;
    if (item.kind === "mse") {
      const url = normalizeMediaUrl(item.url);
      if (!url) continue;
      touchResource(tabId, {
        url,
        kind: "mse",
        ext: "blob",
        mime: item.mime || "",
        size: 0,
        title: item.title || title || "",
        host: "blob",
        width: item.width || 0,
        height: item.height || 0,
        drm: false,
        verified: true,
        info: "媒体流 blob：请在下方下载嗅探到的 HLS/DASH 资源",
        frameId: Number.isInteger(itemFrameId) ? itemFrameId : null,
        source,
        ts: Date.now()
      });
      added++;
      continue;
    }
    const saved = recordMedia(tabId, item.url, { ...item, frameId: itemFrameId, title: item.title || title, source });
    if (saved) added++;
  }
  if (added) {
    updateBadge(tabId);
    persistTab(tabId);
    broadcast({ type: "resources-updated", tabId });
    notifyPanel(tabId);
  }
  return added;
}

// ---- runtime 消息路由（sendResponse 模式，Firefox/Chrome 通用） --------------
// Firefox 允许监听器返回 Promise，Chrome 不允许;统一用 sendResponse + return true。
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse(result))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;   // 保持通道开放以异步响应（Chrome 必需，Firefox 兼容）
});

async function handleMessage(message, sender) {
  const type = message?.type;

  // 嗅探上报
  if (type === "media-found") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const pageUrl = sender.tab.url || sender.url || "";
    if (isBilibiliUrl(pageUrl)) return;
    if (isYoutubePage(pageUrl)) {
      youtubeTabs.add(tabId);
      return;
    }
    mergeDomItems(tabId, message.items, message.title || sender.tab.title, "dom", sender.frameId);
    return;
  }
  if (type === "youtube-resource") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    youtubeTabs.add(tabId);
    recordYoutube(tabId, message.data, message.title || sender.tab.title, message.url || sender.tab.url);
    return;
  }
  // 任务页请求实时解混淆 → 转发到对应标签页的 youtube-bridge（frameId 0）。
  if (type === "yt-rewrite") {
    const tabId = message.tabId;
    if (tabId == null) return { urls: [] };
    return api.tabs.sendMessage(tabId, { type: "yt-rewrite", urls: message.urls || [] }, { frameId: 0 })
      .then(response => ({ urls: response?.urls || [] }))
      .catch(() => ({ urls: [] }));
  }
  if (type === "scan-result") {
    const tabId = message.tabId;
    if (tabId == null) return;
    if (youtubeTabs.has(tabId)) return { ok: true, added: 0 };
    const added = mergeDomItems(tabId, message.items, message.title, "scan");
    return { ok: true, added };
  }

  // 资源查询 / 开关 / 清空
  if (type === "get-resources") {
    const tabId = message.tabId ?? sender.tab?.id;
    const resources = [...(tabResources.get(tabId)?.values() || [])]
      .sort((a, b) => b.ts - a.ts)
      .map(item => ({ ...item, title: item.title || tabTitles.get(tabId) || "" }));
    return {
      resources,
      sniffEnabled: settings.sniffEnabled,
      tasks: tasks.filter(task => task.resource?.tabId === tabId)
    };
  }
  if (type === "set-sniff-enabled") {
    settings.sniffEnabled = Boolean(message.value);
    api.storage.local.set({ sniffEnabled: settings.sniffEnabled }).catch(() => {});
    return { ok: true, sniffEnabled: settings.sniffEnabled };
  }
  // 悬浮按钮常驻开关：持久化并下发给所有标签页的 relay → 面板。
  // 注意：内容脚本只接收 tabs.sendMessage，后台 runtime.sendMessage 不会投递到 relay，
  // 故逐标签页发送，确保已打开的页面即时生效（无需刷新）。
  if (type === "set-floating-enabled") {
    settings.floatingEnabled = Boolean(message.value);
    api.storage.local.set({ floatingEnabled: settings.floatingEnabled }).catch(() => {});
    const tabs = await api.tabs.query({});
    for (const tab of tabs) {
      if (tab.id != null) api.tabs.sendMessage(tab.id, { type: "floating-enabled", value: settings.floatingEnabled }).catch(() => {});
    }
    return { ok: true, floatingEnabled: settings.floatingEnabled };
  }
  // 调出面板：仅向当前活动标签页下发打开命令。
  if (type === "open-panel") {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) api.tabs.sendMessage(tab.id, { type: "open-panel" }).catch(() => {});
    return { ok: true };
  }
  if (type === "clear-resources") {
    tabResources.delete(message.tabId);
    if (sessionStore) sessionStore.remove(`res:${message.tabId}`).catch(() => {});
    updateBadge(message.tabId);
    broadcast({ type: "resources-updated", tabId: message.tabId });
    return { ok: true };
  }

  // 任务管理
  if (type === "start-task") {
    const resource = message.resource;
    if (!resource?.url) return { ok: false, error: "无效的资源" };
    const duplicate = tasks.find(task =>
      task.resource?.url === resource.url && ["pending", "running"].includes(task.status));
    if (duplicate) {
      openTasksPage();
      return { ok: true, taskId: duplicate.id };
    }
    const task = {
      id: String(++taskSeq),
      resource: { ...resource, tabId: message.tabId ?? resource.tabId },
      status: "pending",
      createdAt: Date.now()
    };
    tasks.push(task);
    persistTasks();
    broadcast({ type: "tasks-updated" });
    openTasksPage();
    return { ok: true, taskId: task.id };
  }
  if (type === "get-tasks") {
    return { tasks };
  }
  if (type === "tasks-page-ready") {
    // 任务页重新打开：把上次遗留的 running 标记为中断。
    let changed = false;
    for (const task of tasks) {
      if (task.status === "running") {
        task.status = "interrupted";
        task.error = "页面曾被关闭，任务已中断";
        changed = true;
      }
    }
    if (changed) persistTasks();
    return { tasks };
  }
  if (type === "update-task") {
    const task = tasks.find(item => item.id === message.id);
    if (task) {
      Object.assign(task, message.patch || {});
      persistTasks();
      broadcast({ type: "tasks-updated" });
    }
    return { ok: Boolean(task) };
  }
  if (type === "remove-task") {
    tasks = tasks.filter(item => item.id !== message.id);
    persistTasks();
    broadcast({ type: "tasks-updated" });
    return { ok: true };
  }

  // 下载执行（ffmpeg / HLS，均在后台扩展上下文;Chrome 经 offscreen 跑 ffmpeg）
  if (type === "ffmpeg") {
    const buffer = await runFfmpeg(api, message.op, message);
    return { ok: true, buffer };
  }
  if (type === "hls-download") {
    const result = await downloadHlsInBackground(message, sender.tab?.id);
    return { ok: true, ...result };
  }
  // 通用直连：跨域资源经后台下载（host_permissions 豁免 CORS / 页面 CSP）。
  if (type === "direct-download") {
    const result = await downloadDirectInBackground(message, sender.tab?.id);
    return { ok: true, ...result };
  }
  // 通用 HLS 清单探测：跨域主清单在页内会被 CORS 拦截，改由后台取回原文。
  if (type === "hls-probe") {
    const result = await probeHlsInBackground(message);
    return { ok: true, ...result };
  }
  // 面板取消下载：中断对应后台任务的网络阶段（ffmpeg 阶段结果由面板丢弃）。
  if (type === "cancel-download") {
    downloadControllers.get(message.requestId)?.abort();
    return { ok: true };
  }
  return undefined;
}

// ---- 大块二进制请求（Chrome relay 经 base64 分片 Port;Firefox 走上面的消息） --
attachHeavyServer(api, {
  ffmpeg: async (meta, binaries) => ({ buffer: await runFfmpeg(api, meta.op, { ...meta, ...binaries }) }),
  hls: (meta, binaries, port) => downloadHlsInBackground(meta, port.sender.tab?.id),
  direct: (meta, binaries, port) => downloadDirectInBackground(meta, port.sender.tab?.id)
});

// ---- DNR 会话规则：为 googlevideo 请求补上 YouTube 的 Origin/Referer ----------
async function setupGoogleVideoRules() {
  if (!api.declarativeNetRequest?.updateSessionRules) return;
  try {
    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1001],
      addRules: [{
        id: 1001,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: "https://www.youtube.com" },
            { header: "Referer", operation: "set", value: "https://www.youtube.com/" }
          ]
        },
        condition: {
          urlFilter: "||googlevideo.com",
          resourceTypes: ["xmlhttprequest", "media", "other"]
        }
      }]
    });
  } catch {}
}

// ---- 后台 HLS 下载：取清单 → 下载视频/音频分段 → 合并/转封装 ------------------
// pageUrl 仅通用 HLS 传入：按任务补 Referer/Origin（YouTube 已有固定规则 1001）。
// requestId 登记 AbortController，供面板 cancel-download 中断网络阶段。
const downloadControllers = new Map();

async function downloadHlsInBackground(message, tabId) {
  const { requestId, mediaUrl, audioUrl, height, pageUrl, estimatedBytes } = message;
  const progress = text => {
    if (tabId != null) api.tabs.sendMessage(tabId, { type: "hls-progress", requestId, text }).catch(() => {});
  };
  const controller = new AbortController();
  if (requestId != null) downloadControllers.set(requestId, controller);
  const signal = controller.signal;
  const release = pageUrl ? await acquireHeaderRules(pageUrl, [mediaUrl, audioUrl]) : () => {};
  try {
    const media = await fetchHlsMedia(mediaUrl, signal);
    media.estimatedBytes = estimatedBytes || 0;
    if (media.drm) throw new Error("该 HLS 流受 DRM 保护，无法下载。");
    if (!media.endList && pageUrl) throw new Error("这是直播流（无 ENDLIST），不支持完整下载。");
    const videoTrack = await downloadHlsTrack(media, "视频分段", progress, signal);
    let audioTrack = null;
    if (audioUrl) {
      const audioMedia = await fetchHlsMedia(audioUrl, signal);
      if (audioMedia.drm) throw new Error("音频流受 DRM 保护，无法下载。");
      audioTrack = await downloadHlsTrack(audioMedia, "音频分段", progress, signal);
    }
    progress("正在合并…");
    if (audioTrack) {
      const buffer = await runFfmpeg(api, "merge", { videoBytes: videoTrack.buffer, audioBytes: audioTrack.buffer, outputName: "merged.mp4", videoExt: "mp4", audioExt: "m4a" });
      return { buffer, ext: "mp4", height };
    }
    if (videoTrack.container === "ts") {
      const buffer = await runFfmpeg(api, "remux", { inputBytes: videoTrack.buffer, inputName: "input.ts", outputName: "output.mp4", extraArgs: ["-movflags", "+faststart"] });
      return { buffer, ext: "mp4", height };
    }
    return { buffer: videoTrack.buffer, ext: "mp4", height };
  } finally {
    release();
    if (requestId != null) downloadControllers.delete(requestId);
  }
}

// ---- 后台通用直连下载：豁免页面 CORS / CSP，任务级 DNR 补 Referer -------------
async function downloadDirectInBackground(message, tabId) {
  const { requestId, url, ext, pageUrl } = message;
  const progress = text => {
    if (tabId != null) api.tabs.sendMessage(tabId, { type: "direct-progress", requestId, text }).catch(() => {});
  };
  const controller = new AbortController();
  if (requestId != null) downloadControllers.set(requestId, controller);
  const release = await acquireHeaderRules(pageUrl, [url]);
  try {
    const buffer = await downloadBuffer(url, {
      retries: 3,
      timeout: 300000,
      signal: controller.signal,
      onProgress: ({ received }) => progress(`正在下载… ${formatSize(received)}`)
    });
    return { buffer, ext: ext || "mp4" };
  } finally {
    release();
    if (requestId != null) downloadControllers.delete(requestId);
  }
}

// ---- 后台 HLS 清单探测：取回清单原文（跨域无 CORS 时页内取不到） --------------
// 只取文本不做解析：清晰度/音轨渲染逻辑留在面板，避免两处维护。
async function probeHlsInBackground(message) {
  const { url, pageUrl } = message;
  const release = await acquireHeaderRules(pageUrl, [url]);
  try {
    const response = await fetchWithRetry(url, { retries: 3, timeout: 30000 });
    const text = await response.text();
    // DRM 在探测阶段即拒绝（与嗅探校验同一判据），面板不再回退页内重试。
    if (/#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(text) || /#EXT-X-SESSION-KEY:[^\n]*KEYFORMAT="(urn:uuid:edef8ba9|com\.widevine|com\.microsoft|com\.apple)/i.test(text)) {
      throw new Error("该 HLS 流受 DRM 保护，无法下载。");
    }
    return { text, master: isMasterPlaylist(text) };
  } finally {
    release();
  }
}

// ---- 启动 --------------------------------------------------------------------
restoreState();
setupGoogleVideoRules();