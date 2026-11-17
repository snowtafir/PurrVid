// ============================================================================
// lib/media-utils.js — 通用媒体工具（共享库）
// ----------------------------------------------------------------------------
// URL 分类/归一化、格式化（大小/时长/文件名）、带重试与并发的下载原语。
// 被 background/service-worker.js、universal-panel.js、tasks/tasks.js 及 lib/* 引用。
// 关键：requestCredentials 对 googlevideo/youtube 用 omit（避免携带 Cookie 触发
//   跨域限制），其余 include；fetchWithRetry 支持超时/重试/外部 abort 信号。
// ============================================================================

export const DIRECT_VIDEO_EXTS = new Set([
  "mp4", "webm", "mov", "mkv", "avi", "flv", "m4v", "mpg", "mpeg", "wmv", "3gp", "ogv", "m2ts", "mts"
]);
export const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "opus", "weba"]);
export const SEGMENT_EXTS = new Set(["ts", "m4s", "m2t", "vtt", "jpg", "png", "webp", "key"]);

export function urlExtension(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

export function classifyMediaUrl(url, contentType = "") {
  const type = String(contentType).toLowerCase();
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/.test(type)) return { kind: "hls", ext: "m3u8" };
  if (/application\/dash\+xml/.test(type)) return { kind: "dash", ext: "mpd" };

  const ext = urlExtension(url);
  if (ext === "m3u8") return { kind: "hls", ext };
  if (ext === "mpd") return { kind: "dash", ext };
  if (SEGMENT_EXTS.has(ext)) return null;

  if (DIRECT_VIDEO_EXTS.has(ext)) return { kind: "direct", ext };
  if (AUDIO_EXTS.has(ext)) return { kind: "audio", ext };

  if (/^video\//.test(type) && !/video\/mp2t/.test(type)) {
    return { kind: "direct", ext: ext || "mp4" };
  }
  if (/^audio\//.test(type) && !/audio\/mpegurl/.test(type)) {
    return { kind: "audio", ext: ext || "m4a" };
  }

  if (/mpegurl|\/hls\/|playlist/i.test(url) && /octet-stream|^text\/plain/.test(type)) {
    return { kind: "hls", ext: "m3u8" };
  }
  return null;
}

export function normalizeMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  const gb = 1024 ** 3, mb = 1024 ** 2, kb = 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(2)}GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(2)}MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(2)}KB`;
  return `${bytes}B`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function sanitizeFilename(name, fallback = "video") {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("已取消", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestCredentials(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "googlevideo.com" || host.endsWith(".googlevideo.com") || host === "youtube.com" || host.endsWith(".youtube.com")) return "omit";
  } catch {}
  return "include";
}

export async function fetchWithRetry(url, { retries = 3, timeout = 60000, signal, headers, credentials } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        credentials: credentials || requestCredentials(url),
        redirect: "follow",
        signal: controller.signal,
        headers
      });
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (attempt < retries) await abortableSleep(600 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastError || new Error("下载失败");
}

export async function downloadBuffer(url, { onProgress, signal, retries = 3, timeout = 120000, headers } = {}) {
  let received = 0;
  const response = await fetchWithRetry(url, { retries, timeout, signal, headers });
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ received: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({ received, total });
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function mapLimit(items, limit, worker, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function concatBuffers(buffers) {
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return merged.buffer;
}

export function parseAttributes(line) {
  const attrs = {};
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(line))) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

export function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}