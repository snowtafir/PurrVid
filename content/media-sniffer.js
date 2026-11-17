// ============================================================================
// content/media-sniffer.js — 通用 DOM 媒体嗅探（ISOLATED world · document_idle · 所有框架）
// ----------------------------------------------------------------------------
// 职责：在「非 B站、非 YouTube」的普通站点扫描 <video>/<audio>/<source>、
//   shadow DOM、同源 iframe 与 performance 资源记录，发现直连媒体 / HLS / DASH /
//   blob，上报给后台。B站由引擎接管、YouTube 由 youtube-bridge 接管，故此处跳过。
//
// 消息契约（→ background/service-worker.js）：
//   发送 { type:"media-found", items, title }
//   接收 { type:"download-blob", url, filename }  → 触发锚点下载
//   接收 { type:"rescan" }                        → 清空已上报记录并重扫
// 存储键：storage.local.sniffEnabled（自动嗅探开关，与 popup 共享）
// ============================================================================
(() => {
  // 防止同一页面重复注入。
  if (window.__purrvidSnifferLoaded) return;
  window.__purrvidSnifferLoaded = true;

  // ---- 站点过滤：B站 / YouTube 交给专用模块 ----------------------------------
  const hostname = location.hostname;
  if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) return;
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be" || hostname.endsWith(".youtube-nocookie.com")) return;
  if (!["http:", "https:"].includes(location.protocol)) return;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ---- 扩展名分类表 ----------------------------------------------------------
  const DIRECT_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi", "flv", "m4v", "mpg", "mpeg", "wmv", "3gp", "ogv"]);
  const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "opus"]);

  const reported = new Set();   // 已上报 URL，避免重复
  let enabled = true;
  let scanTimer = null;

  function extOf(url) {
    try {
      return new URL(url, document.baseURI).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    } catch {
      return "";
    }
  }

  function classify(url) {
    const ext = extOf(url);
    if (ext === "m3u8") return { kind: "hls", ext };
    if (ext === "mpd") return { kind: "dash", ext };
    if (DIRECT_EXTS.has(ext)) return { kind: "direct", ext };
    if (AUDIO_EXTS.has(ext)) return { kind: "audio", ext };
    return null;
  }

  // 归一化为绝对 URL；拒绝带鉴权信息的地址，去掉 hash。
  function absolute(rawUrl) {
    try {
      const url = new URL(rawUrl, document.baseURI);
      if (!["http:", "https:", "blob:"].includes(url.protocol)) return null;
      if (url.username || url.password) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  // ---- DOM 扫描 --------------------------------------------------------------
  function collectCandidates() {
    const items = [];
    const seen = new Set();
    const visited = new WeakSet();
    const pageTitle = document.title.trim().slice(0, 120);

    function push(rawUrl, meta = {}) {
      const url = absolute(rawUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);
      if (url.startsWith("blob:")) {
        items.push({ url, kind: "blob", title: meta.title || pageTitle, width: meta.width || 0, height: meta.height || 0, mime: meta.mime || "" });
        return;
      }
      const classified = classify(url);
      if (!classified) return;
      items.push({
        url,
        kind: classified.kind,
        ext: classified.ext,
        title: meta.title || pageTitle,
        width: meta.width || 0,
        height: meta.height || 0,
        mime: meta.mime || ""
      });
    }

    // 递归扫描根节点下的媒体元素，并深入 shadow DOM 与同源 iframe。
    function scanRoot(root) {
      if (!root || visited.has(root)) return;
      visited.add(root);
      let elements;
      try {
        elements = root.querySelectorAll("video, audio, source");
      } catch {
        return;
      }
      for (const element of elements) {
        if (element.tagName === "SOURCE") continue;
        const meta = {
          title: element.getAttribute("aria-label") || element.getAttribute("title") || "",
          width: element.videoWidth || 0,
          height: element.videoHeight || 0
        };
        push(element.currentSrc || element.src, meta);
        push(element.getAttribute("src"), meta);
        for (const source of element.querySelectorAll("source")) {
          push(source.src || source.getAttribute("src"), { ...meta, mime: source.type || "" });
        }
      }
      let all;
      try {
        all = root.querySelectorAll("*");
      } catch {
        return;
      }
      for (const element of all) {
        if (element.shadowRoot) scanRoot(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          try {
            if (element.contentDocument) scanRoot(element.contentDocument);
          } catch {}
        }
      }
    }

    scanRoot(document);
    // 补充：从 performance 资源记录里捞已发生的媒体请求。
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const ext = extOf(entry.name);
        if (["m3u8", "mpd", "mp4", "webm", "mov", "mkv"].includes(ext)) push(entry.name);
      }
    } catch {}
    return items;
  }

  // blob 地址尝试 fetch 出真实大小/MIME；失败则标记为 mse（媒体源扩展流）。
  async function probeBlobs(items) {
    const results = [];
    for (const item of items) {
      if (item.kind !== "blob") {
        results.push(item);
        continue;
      }
      try {
        const response = await fetch(item.url);
        const blob = await response.blob();
        if (!blob.size) throw new Error("empty blob");
        results.push({
          ...item,
          kind: "blob",
          size: blob.size,
          mime: blob.type || item.mime,
          ext: (blob.type.match(/^(?:video|audio)\/([a-z0-9]+)/i)?.[1] || "mp4").replace("quicktime", "mov")
        });
      } catch {
        results.push({ ...item, kind: "mse", mime: item.mime || "video/mp4" });
      }
    }
    return results;
  }

  // ---- 上报 ------------------------------------------------------------------
  async function report(force = false) {
    if (!enabled && !force) return;
    const candidates = collectCandidates();
    const fresh = candidates.filter(item => !reported.has(item.url));
    if (!fresh.length) return;
    for (const item of fresh) reported.add(item.url);
    const items = await probeBlobs(fresh);
    try {
      await api.runtime.sendMessage({
        type: "media-found",
        items,
        title: document.title.trim().slice(0, 120)
      });
    } catch {}
  }

  function scheduleScan() {
    if (!enabled) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => report(), 1500);
  }

  // ---- 启动：读取开关 + 监听 DOM 变化 ----------------------------------------
  api.storage.local.get({ sniffEnabled: true }).then(result => {
    enabled = result.sniffEnabled !== false;
    if (enabled) {
      report();
      setTimeout(() => report(), 2500);
    }
    const observer = new MutationObserver(scheduleScan);
    const start = () => {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      else setTimeout(start, 300);
    };
    start();
  }).catch(() => {});

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sniffEnabled) {
      enabled = changes.sniffEnabled.newValue !== false;
      if (enabled) report();
    }
  });

  // ---- 来自后台 / 任务页的指令 -----------------------------------------------
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "download-blob") {
      try {
        const anchor = document.createElement("a");
        anchor.href = message.url;
        anchor.download = message.filename || "video.mp4";
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return true;
    }
    if (message?.type === "rescan") {
      reported.clear();
      report(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    return undefined;
  });
})();