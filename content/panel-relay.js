// ============================================================================
// content/panel-relay.js — 面板 ↔ 后台 消息桥（ISOLATED world · document_idle · 所有站点）
// ----------------------------------------------------------------------------
// 为什么需要它：页内面板（universal-panel.js）运行在 MAIN world，无法直接调用
//   runtime.sendMessage；且 ffmpeg Worker 与 HLS 分片下载必须在后台扩展上下文
//   执行（页面与 isolated world 都受页面 Trusted Types CSP / CORS 约束）。
//   本脚本在 isolated world 用 window.postMessage 与面板通信，再转成 runtime 消息。
//
// window.postMessage 协议（source 固定为 RELAY_SOURCE）：
//   面板 → relay（from:"panel"）
//     { type:"ready" }                         面板就绪，请求资源列表
//     { type:"ffmpeg", requestId, op, ... }    请求合并/转封装（op: merge|remux）
//     { type:"hls-download", requestId, ... }  请求后台下载 HLS（mediaUrl/audioUrl/title/height）
//   relay → 面板（from:"relay"）
//     { type:"resources", resources }          当前标签页嗅探到的资源
//     { type:"ffmpeg-result", requestId, buffer|error }
//     { type:"hls-result", requestId, buffer, ext, height | error }
//     { type:"hls-progress", requestId, text } 下载进度文本
//     { type:"floating-enabled", value }       悬浮按钮是否常驻
//     { type:"inject-panel" }                  通知 MAIN world bootstrap 按需注入面板
//     { type:"open-panel" }                    调出（展开）面板
//
// runtime 消息（↔ background/service-worker.js）：
//   get-resources / resources-updated / ffmpeg / hls-download / hls-progress
//   floating-enabled(→所有标签页) / open-panel(→活动标签页) / panel-activate(→有资源的标签页)
//   Firefox：ffmpeg/hls-download 直传二进制（结构化克隆）。
//   Chrome：经 lib/transport.js 的 base64 分片 Port（runtime 消息仅 JSON 且有大小限制）。
// ============================================================================
(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
  const RELAY_SOURCE = "purrvid-panel";

  // Chrome 的 runtime 消息只支持 JSON 且有大小限制，大块二进制经 base64 分片 Port。
  let heavyModule = null;
  async function sendHeavy(kind, meta, binaries) {
    if (!heavyModule) heavyModule = await import(api.runtime.getURL("lib/transport.js"));
    return heavyModule.sendHeavyRequest(api, kind, meta, binaries);
  }

  // 向面板投递一条消息。
  function post(type, extra) {
    window.postMessage({ source: RELAY_SOURCE, from: "relay", type, ...extra }, "*");
  }

  // 拉取当前标签页资源并推给面板。
  async function pushResources() {
    try {
      const response = await api.runtime.sendMessage({ type: "get-resources" });
      post("resources", { resources: response?.resources || [] });
    } catch {
      // 后台不可用时忽略
    }
  }

  // 悬浮按钮常驻开关：缓存扩展级设置并推给面板（MAIN world 无法直接读 storage）。
  let floatingEnabled = true;
  function postFloating() {
    post("floating-enabled", { value: floatingEnabled });
  }
  async function loadFloating() {
    try {
      const stored = await api.storage.local.get({ floatingEnabled: true });
      floatingEnabled = stored.floatingEnabled !== false;
    } catch {
      // 读取失败时保持默认常驻
    }
    postFloating();
  }

  // ---- 面板就绪 → 推送资源与悬浮按钮状态 -------------------------------------
  window.addEventListener("message", event => {
    const data = event.data;
    if (data?.source === RELAY_SOURCE && data.from === "panel" && data.type === "ready") {
      pushResources();
      postFloating();
    }
  });

  // ---- 后台主动通知 → 转发给面板 ---------------------------------------------
  api.runtime.onMessage.addListener(message => {
    if (message?.type === "resources-updated") pushResources();
    if (message?.type === "hls-progress") post("hls-progress", { requestId: message.requestId, text: message.text });
    if (message?.type === "floating-enabled") { floatingEnabled = message.value !== false; postFloating(); }
    // 嗅探到媒体：通知 MAIN world bootstrap 注入面板（悬浮按钮随之出现）。
    if (message?.type === "panel-activate") post("inject-panel");
    // popup 调出面板：未注入时先注入，bootstrap 会在就绪后补投 open。
    if (message?.type === "open-panel") { post("inject-panel"); post("open-panel"); }
  });

  // ---- ffmpeg 合并/转封装：转发到后台执行，回传结果（buffer 用转移列表）--------
  window.addEventListener("message", async event => {
    const data = event.data;
    if (data?.source !== RELAY_SOURCE || data.from !== "panel" || data.type !== "ffmpeg") return;
    const { requestId, op } = data;
    try {
      let buffer;
      if (IS_FIREFOX) {
        const response = await api.runtime.sendMessage({
          type: "ffmpeg",
          op,
          videoBytes: data.videoBytes,
          audioBytes: data.audioBytes,
          inputBytes: data.inputBytes,
          inputName: data.inputName,
          outputName: data.outputName,
          videoExt: data.videoExt,
          audioExt: data.audioExt,
          extraArgs: data.extraArgs
        });
        if (!response?.ok) throw new Error(response?.error || "ffmpeg 处理失败");
        buffer = response.buffer;
      } else {
        const meta = { op, inputName: data.inputName, outputName: data.outputName, videoExt: data.videoExt, audioExt: data.audioExt, extraArgs: data.extraArgs };
        const result = await sendHeavy("ffmpeg", meta, { videoBytes: data.videoBytes, audioBytes: data.audioBytes, inputBytes: data.inputBytes });
        buffer = result.buffer;
      }
      window.postMessage({ source: RELAY_SOURCE, from: "relay", type: "ffmpeg-result", requestId, buffer }, "*", [buffer]);
    } catch (error) {
      window.postMessage({ source: RELAY_SOURCE, from: "relay", type: "ffmpeg-result", requestId, error: String(error?.message || error) }, "*");
    }
  });

  // ---- HLS 后台下载：host_permissions 豁免 CORS，规避跨域重定向丢失 ACAO ------
  window.addEventListener("message", async event => {
    const data = event.data;
    if (data?.source !== RELAY_SOURCE || data.from !== "panel" || data.type !== "hls-download") return;
    const { requestId } = data;
    try {
      let result;
      if (IS_FIREFOX) {
        const response = await api.runtime.sendMessage({
          type: "hls-download",
          requestId,
          mediaUrl: data.mediaUrl,
          audioUrl: data.audioUrl,
          title: data.title,
          height: data.height
        });
        if (!response?.ok) throw new Error(response?.error || "下载失败");
        result = response;
      } else {
        result = await sendHeavy("hls", { requestId, mediaUrl: data.mediaUrl, audioUrl: data.audioUrl, title: data.title, height: data.height }, {});
      }
      window.postMessage({ source: RELAY_SOURCE, from: "relay", type: "hls-result", requestId, buffer: result.buffer, ext: result.ext, height: result.height }, "*", [result.buffer]);
    } catch (error) {
      window.postMessage({ source: RELAY_SOURCE, from: "relay", type: "hls-result", requestId, error: String(error?.message || error) }, "*");
    }
  });

  // B站 / YouTube 的面板在 document_start 就已注入，其 ready 可能早于本脚本
  // （document_idle），故加载时主动推一次；其它站点面板按需注入、必晚于本脚本，
  // 靠 ready 握手即可——避免在无媒体站点产生多余的消息往返。
  const hostname = location.hostname;
  const earlyPanelHost = /(^|\.)bilibili\.com$/.test(hostname)
    || hostname === "youtube.com" || hostname.endsWith(".youtube.com")
    || hostname === "youtu.be" || hostname.endsWith(".youtube-nocookie.com");
  if (earlyPanelHost) {
    pushResources();
    loadFloating();
  }
})();