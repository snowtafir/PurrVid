// ============================================================================
// content/youtube-bridge.js — YouTube 播放器桥（MAIN world · document_start · YouTube 域）
// ----------------------------------------------------------------------------
// 职责（运行在页面 MAIN world，才能访问 window._yt_player / ytcfg 等页面全局）：
//   1. 钩住 fetch / XHR，捕获 /youtubei/v1/player 响应里的 streamingData。
//   2. 用页面自带的 _yt_player URL 类对带 n 参数的 googlevideo 直链做解混淆
//      （rewrite），绕过限速/签名。
//   3. WEB 客户端 VOD 响应通常不含 hlsManifestUrl，改用 VISIONOS 客户端向
//      innertube 重新请求拿到 HLS 清单（走标准 GET 分段，比 progressive 直链稳）。
//   4. 把解析结果 postMessage 给 universal-panel.js。
//
// 消息契约（source 固定为 SOURCE）：
//   bridge → 面板（from:"bridge"）：{ type:"player", payload } /
//                                  { type:"rewrite-result", messageId, urls }
//   面板 → bridge（from:"isolated"）：{ type:"rewrite", messageId, urls }
//
// 注意：SERIALIZE_CANDIDATES / KNOWN_CLASSES 里的 "jy"/"JA" 等是 YouTube 自身
//   混淆后的方法名/类名，属于外部契约，随 YouTube 版本变化，切勿当作本项目变量重命名。
// ============================================================================
(() => {
  "use strict";

  const SOURCE = "purrvid-yt";

  // ---- YouTube URL 类的已知混淆名（外部契约，按版本探测） --------------------
  const SERIALIZE_CANDIDATES = ["jy", "tq", "KW", "qT", "pS", "A$"];
  const KNOWN_CLASSES = [
    { name: "JA", serialize: "jy" },
    { name: "MG", serialize: "tq" },
    { name: "iO", serialize: "KW" },
    { name: "XA", serialize: "qT" },
    { name: "Ob", serialize: "pS" },
    { name: "Hb", serialize: "A$" }
  ];
  const MAX_CLASS_SOURCE = 4000;
  const MAX_PROTO_MEMBERS = 12;

  let cachedEntry;   // 缓存探测到的 URL 类入口，避免每次重复探测

  // 是否需要 n 参数解混淆。
  const needsRewrite = (url) => /[?&/]n[=/][^/&]+/.test(url);

  function asHttpUrl(value) {
    if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : "";
    if (value && typeof value.toString === "function") {
      try {
        const text = String(value.toString());
        return /^https?:\/\//i.test(text) ? text : "";
      } catch {
        return "";
      }
    }
    return "";
  }

  // ---- n 参数解混淆 ----------------------------------------------------------
  function rewriteOne(entry, url) {
    if (!url || typeof url !== "string") return "";
    if (!needsRewrite(url)) return url;
    try {
      const instance = new entry.Cls(url, true);
      const method = instance?.[entry.serialize];
      const result = typeof method === "function"
        ? method.call(instance)
        : instance.jy?.() ?? instance.tq?.() ?? instance.KW?.() ?? instance.qT?.() ?? instance.pS?.() ?? instance.A$?.();
      return asHttpUrl(result);
    } catch {
      return "";
    }
  }

  function entryWorks(entry, sample) {
    return !sample || !needsRewrite(sample) ? true : Boolean(rewriteOne(entry, sample));
  }

  function findInstanceSerialize(instance, sample) {
    for (const name of SERIALIZE_CANDIDATES) {
      if (typeof instance?.[name] === "function") return name;
    }
    const proto = Object.getPrototypeOf(instance) || {};
    const names = new Set([...Object.getOwnPropertyNames(instance), ...Object.getOwnPropertyNames(proto)]);
    for (const name of names) {
      if (name === "constructor" || typeof instance[name] !== "function" || instance[name].length > 0) continue;
      try {
        const result = asHttpUrl(instance[name]());
        if (!result) continue;
        if (/googlevideo|manifest|videoplayback|youtube\.com/i.test(result) || result !== sample) return name;
      } catch {
        // ignore probing errors
      }
    }
    return null;
  }

  function findSerializeInSource(source) {
    for (const name of SERIALIZE_CANDIDATES) {
      const escaped = name.replace(/\$/g, "\\$");
      if (new RegExp(`\\b${escaped}\\s*\\(`).test(source)) return name;
    }
    return null;
  }

  function looksLikeUrlClass(fn, source) {
    if (!source || source.length > MAX_CLASS_SOURCE || !/\bget\s*\(/.test(source) || !/\bset\s*\(/.test(source)) return false;
    try {
      const names = Object.getOwnPropertyNames(fn?.prototype || {});
      return names.length > 0 && names.length <= MAX_PROTO_MEMBERS;
    } catch {
      return false;
    }
  }

  // 三级探测：已知类名 → 源码特征匹配 → 实例化试探。
  function detectEntry(player, sample) {
    if (!player || typeof player !== "object") return null;
    for (const known of KNOWN_CLASSES) {
      const fn = player[known.name];
      if (typeof fn !== "function") continue;
      const entry = { Cls: fn, name: known.name, serialize: known.serialize };
      if (!sample || entryWorks(entry, sample)) return entry;
    }
    for (const key of Object.keys(player)) {
      const fn = player[key];
      if (typeof fn !== "function") continue;
      let source = "";
      try {
        source = Function.prototype.toString.call(fn);
      } catch {
        continue;
      }
      if (!looksLikeUrlClass(fn, source)) continue;
      const serialize = findSerializeInSource(source);
      if (!serialize) continue;
      const entry = { Cls: fn, name: key, serialize };
      if (!sample || entryWorks(entry, sample)) return entry;
    }
    if (sample) {
      for (const key of Object.keys(player)) {
        const fn = player[key];
        if (typeof fn !== "function") continue;
        let source = "";
        try {
          source = Function.prototype.toString.call(fn);
        } catch {
          continue;
        }
        if (!looksLikeUrlClass(fn, source)) continue;
        try {
          const instance = new fn(sample, true);
          const serialize = findInstanceSerialize(instance, sample);
          if (!serialize) continue;
          const entry = { Cls: fn, name: key, serialize };
          if (!entryWorks(entry, sample)) continue;
          return entry;
        } catch {
          // ignore instantiation errors
        }
      }
    }
    return null;
  }

  function getEntry(player, sample) {
    if (cachedEntry === undefined) cachedEntry = detectEntry(player, sample);
    return cachedEntry;
  }

  function rewriteUrls(urls) {
    const player = window._yt_player;
    const sample = urls.find(u => typeof u === "string" && u && needsRewrite(u))
      || urls.find(u => typeof u === "string" && u)
      || "";
    if (!player) return urls.map(() => "");
    const entry = getEntry(player, sample);
    if (!entry?.Cls) return urls.map(() => "");
    const result = urls.map(url => {
      if (!url || typeof url !== "string") return "";
      if (!needsRewrite(url)) return url;
      try {
        return rewriteOne(entry, url);
      } catch {
        return "";
      }
    });
    // 若全部 n 链接都解混淆失败，作废缓存以便下次重新探测。
    const nUrls = urls.filter(u => typeof u === "string" && needsRewrite(u));
    const okCount = result.filter((u, i) => typeof urls[i] === "string" && needsRewrite(urls[i]) && u).length;
    if (nUrls.length > 0 && okCount === 0) cachedEntry = undefined;
    return result;
  }

  function cipherUrl(raw) {
    if (raw.url) return raw.url;
    const cipher = raw.signatureCipher || raw.cipher;
    if (!cipher) return "";
    try {
      return new URLSearchParams(cipher).get("url") || "";
    } catch {
      return "";
    }
  }

  // ---- VISIONOS innertube 客户端：获取 HLS 清单 ------------------------------
  const YT_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const VISIONOS = {
    clientName: "VISIONOS",
    clientVersion: "1.02",
    clientNameId: "101",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    osName: "visionOS",
    osVersion: "26.5.23O471"
  };

  function ytConfig() {
    return window.ytcfg?.data_ || window.yt?.config_ || {};
  }

  async function fetchHlsManifestUrl(videoId) {
    try {
      const cfg = ytConfig();
      const visitorData = cfg.INNERTUBE_CONTEXT?.client?.visitorData || "";
      const client = {
        hl: navigator.language || "en",
        gl: "US",
        clientName: VISIONOS.clientName,
        clientVersion: VISIONOS.clientVersion,
        userAgent: VISIONOS.userAgent,
        platform: "MOBILE",
        osName: VISIONOS.osName,
        osVersion: VISIONOS.osVersion,
        deviceMake: VISIONOS.deviceMake,
        deviceModel: VISIONOS.deviceModel
      };
      if (visitorData) client.visitorData = visitorData;
      const body = {
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
        playbackContext: {
          contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: "-1", signatureTimestamp: Number(cfg.STS) || 0 }
        },
        context: { client, user: {}, request: { useSsl: true } }
      };
      const headers = {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "X-Youtube-Client-Name": VISIONOS.clientNameId,
        "X-Youtube-Client-Version": VISIONOS.clientVersion,
        "X-GOOG-API-FORMAT-VERSION": "2"
      };
      if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
      const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${YT_API_KEY}&prettyPrint=false`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) return "";
      const json = await response.json();
      const data = json.playerResponse || json;
      return data?.streamingData?.hlsManifestUrl || "";
    } catch {
      return "";
    }
  }

  // ---- 解析结果发射（带重试与 HLS 缓存） -------------------------------------
  let latest = null;
  let emitTimer = null;
  let attempts = 0;
  let hlsCache = { videoId: "", url: "" };
  let hlsPending = false;

  function post(payload) {
    window.postMessage({ source: SOURCE, from: "bridge", type: "player", payload }, "*");
  }

  function emitPayload(hlsManifestUrl) {
    post({
      videoDetails: latest.videoDetails,
      streamingData: latest.streamingData,
      rewrittenUrls: latest.rewrittenUrls,
      hlsManifestUrl,
      pageUrl: location.href
    });
  }

  function tryEmit() {
    emitTimer = null;
    if (!latest) return;
    const streamingData = latest.streamingData;
    const raws = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
    const urls = raws.map(cipherUrl);
    const rewritten = rewriteUrls(urls);
    const hasN = urls.some(u => typeof u === "string" && needsRewrite(u));
    const anyOk = rewritten.some((u, i) => u && urls[i]);
    // 解混淆尚未就绪时重试（_yt_player 可能还没加载完）。
    if (hasN && !anyOk && attempts < 15) {
      attempts++;
      emitTimer = setTimeout(tryEmit, 700);
      return;
    }
    latest.rewrittenUrls = rewritten;
    const videoId = latest.videoDetails?.videoId || "";
    const hlsManifestUrl = streamingData.hlsManifestUrl || (hlsCache.videoId === videoId ? hlsCache.url : "");
    emitPayload(hlsManifestUrl);
    if (!hlsManifestUrl && videoId && !hlsPending && hlsCache.videoId !== videoId) {
      hlsPending = true;
      fetchHlsManifestUrl(videoId).then(url => {
        hlsPending = false;
        hlsCache = { videoId, url };
        if (url && latest?.videoDetails?.videoId === videoId) emitPayload(url);
      }).catch(() => { hlsPending = false; });
    }
  }

  function scheduleEmit() {
    attempts = 0;
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(tryEmit, 400);
  }

  function extractPlayer(json) {
    if (!json || typeof json !== "object") return;
    const streamingData = json.streamingData;
    if (!streamingData || (!streamingData.formats && !streamingData.adaptiveFormats)) return;
    latest = { videoDetails: json.videoDetails || {}, streamingData };
    scheduleEmit();
  }

  function readInitial() {
    try {
      extractPlayer(window.ytInitialPlayerResponse);
    } catch {
      // ignore
    }
  }

  // ---- 网络钩子：捕获 player 响应 --------------------------------------------
  function hookFetch() {
    const original = window.fetch;
    if (typeof original !== "function") return;
    window.fetch = async function (...args) {
      const response = await original.apply(this, args);
      try {
        const request = args[0];
        const url = typeof request === "string" ? request : request?.url || "";
        if (url.includes("/youtubei/v1/player")) {
          response.clone().json().then(extractPlayer).catch(() => {});
        }
      } catch {
        // ignore
      }
      return response;
    };
  }

  function hookXhr() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr) return;
    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    Xhr.prototype.open = function (method, url, ...rest) {
      this.__purrvidYtUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    Xhr.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (String(this.__purrvidYtUrl || "").includes("/youtubei/v1/player")) {
            extractPlayer(JSON.parse(this.responseText));
          }
        } catch {
          // ignore
        }
      });
      return originalSend.apply(this, args);
    };
  }

  // ---- 面板请求实时解混淆 ----------------------------------------------------
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== SOURCE || data.from !== "isolated" || data.type !== "rewrite") return;
    const urls = Array.isArray(data.urls) ? data.urls : [];
    const result = rewriteUrls(urls);
    window.postMessage({ source: SOURCE, from: "bridge", type: "rewrite-result", messageId: data.messageId, urls: result }, "*");
  });

  // ---- 启动 ------------------------------------------------------------------
  hookFetch();
  hookXhr();
  readInitial();
  document.addEventListener("yt-navigate-finish", () => setTimeout(readInitial, 300));
  let polls = 0;
  const pollTimer = setInterval(() => {
    readInitial();
    if (++polls >= 40) clearInterval(pollTimer);
  }, 500);
})();