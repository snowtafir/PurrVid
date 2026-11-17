// ============================================================================
// lib/transport.js — 跨浏览器二进制传输适配（共享库）
// ----------------------------------------------------------------------------
// 背景：Firefox 的 runtime 消息支持结构化克隆（可直接传 ArrayBuffer），而 Chrome
//   的 runtime 消息只做 JSON 序列化（二进制会丢失），且单条消息约 32MB 上限。
//   因此内容脚本(relay) ↔ 后台(SW) 的大块二进制（ffmpeg 输入/输出、HLS 结果）
//   在 Chrome 下需 base64 + 分片，经一条专用 Port 传输；Firefox 保持原样直传。
//
// 提供：
//   IS_FIREFOX                 浏览器判定（content script / SW 通用）
//   bytesToBase64 / base64ToBytes   分块安全的 base64 编解码
//   sendHeavyRequest           客户端（relay）：发起一次大块请求，返回 {buffer,...}
//   attachHeavyServer          服务端（SW）：重组请求 → 调 handler → 分片回传结果
//
// 注意：SW ↔ offscreen 的二进制走 BroadcastChannel（见 ffmpeg-host.js），不经此处。
// ============================================================================

// 用 userAgent 精确判定 Firefox（Chrome 148+ 也提供 browser.* 命名空间，
// 仅凭 typeof browser 会把新版 Chrome 误判为 Firefox）。
export const IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);

const HEAVY_PORT = "purrvid-heavy";
const CHUNK = 4 * 1024 * 1024;   // 每条 Port 消息的 base64 字符数（约 4MB，远低于上限）

// ---- base64 编解码（分块，避免 String.fromCharCode 参数过多爆栈） -------------
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- 客户端：relay 发起大块请求 ----------------------------------------------
// kind: "ffmpeg" | "hls"；meta: 非二进制字段;binaries: { 字段名: Uint8Array }。
// 返回 Promise<{ buffer:ArrayBuffer, ...resultMeta }>。
export function sendHeavyRequest(api, kind, meta, binaries = {}) {
  return new Promise((resolve, reject) => {
    const port = api.runtime.connect({ name: HEAVY_PORT });
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const resultChunks = [];
    const resultMeta = {};
    let settled = false;

    const finish = error => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      if (error) reject(error);
      else resolve({ ...resultMeta, buffer: base64ToBytes(resultChunks.join("")).buffer });
    };

    port.onMessage.addListener(message => {
      if (message?.id !== id) return;
      if (message.t === "res-data") resultChunks.push(message.chunk);
      else if (message.t === "res-meta") Object.assign(resultMeta, message.meta || {});
      else if (message.t === "res-done") finish(message.error ? new Error(message.error) : null);
    });
    port.onDisconnect.addListener(() => finish(new Error("后台连接中断")));

    port.postMessage({ t: "req", id, kind, meta, fields: Object.keys(binaries) });
    for (const [name, bytes] of Object.entries(binaries)) {
      if (!bytes) continue;
      const base64 = bytesToBase64(bytes);
      for (let i = 0; i < base64.length; i += CHUNK) {
        port.postMessage({ t: "data", id, name, chunk: base64.slice(i, i + CHUNK) });
      }
    }
    port.postMessage({ t: "done", id });
  });
}

// ---- 服务端：SW 重组请求并分片回传结果 ---------------------------------------
// handlers: { ffmpeg(meta, binaries, port), hls(meta, binaries, port) }
//   handler 返回 { buffer:ArrayBuffer, ...其它字段 };其它字段作为 res-meta 回传。
export function attachHeavyServer(api, handlers) {
  api.runtime.onConnect.addListener(port => {
    if (port.name !== HEAVY_PORT) return;
    const requests = new Map();

    port.onMessage.addListener(async message => {
      const id = message?.id;
      if (!id) return;
      if (message.t === "req") {
        requests.set(id, { kind: message.kind, meta: message.meta || {}, chunks: {} });
        return;
      }
      if (message.t === "data") {
        const request = requests.get(id);
        if (request) (request.chunks[message.name] ||= []).push(message.chunk);
        return;
      }
      if (message.t !== "done") return;

      const request = requests.get(id);
      requests.delete(id);
      if (!request) return;
      try {
        const binaries = {};
        for (const [name, chunks] of Object.entries(request.chunks)) {
          binaries[name] = base64ToBytes(chunks.join(""));
        }
        const handler = handlers[request.kind];
        if (!handler) throw new Error(`未知请求类型：${request.kind}`);
        const result = await handler(request.meta, binaries, port);
        const { buffer, ...meta } = result || {};
        if (Object.keys(meta).length) port.postMessage({ t: "res-meta", id, meta });
        if (buffer) {
          const base64 = bytesToBase64(new Uint8Array(buffer));
          for (let i = 0; i < base64.length; i += CHUNK) {
            port.postMessage({ t: "res-data", id, chunk: base64.slice(i, i + CHUNK) });
          }
        }
        port.postMessage({ t: "res-done", id });
      } catch (error) {
        port.postMessage({ t: "res-done", id, error: String(error?.message || error) });
      }
    });
  });
}