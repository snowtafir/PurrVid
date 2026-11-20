// ============================================================================
// lib/hls.js — 后台 HLS 下载（共享库，仅后台使用）
// ----------------------------------------------------------------------------
// fetchHlsMedia：取媒体清单；downloadHlsTrack：并发下载分段 + AES-128 解密 +
//   初始化段拼接，返回 {buffer, container, duration}。在后台扩展上下文执行，
//   以豁免页面 CORS / Trusted Types 限制。
// signal：外部 AbortSignal（面板取消下载时中断）；media.estimatedBytes 可选，
//   用于进度文本展示「/ 约 总量」。
// ============================================================================

import { parseMedia, isFmp4Segments } from "./m3u8.js";
import { downloadBuffer, mapLimit, concatBuffers, fetchWithRetry, formatSize } from "./media-utils.js";

const CONCURRENCY = 4;

export async function fetchHlsMedia(url, signal) {
  const response = await fetchWithRetry(url, { retries: 3, timeout: 30000, signal });
  return parseMedia(await response.text(), url);
}

export async function downloadHlsTrack(media, label, onProgress, signal) {
  const segments = media.segments;
  if (!segments.length) throw new Error("清单中没有媒体分段");
  const keyCache = new Map();
  const buffers = new Array(segments.length);
  const estimate = media.estimatedBytes ? ` / 约 ${formatSize(media.estimatedBytes)}` : "";
  let done = 0;
  let bytes = 0;
  // 字节级进度：已完成段累计 + 各在途段实时 received；200ms 节流，避免高频跨上下文消息。
  const partial = new Array(segments.length).fill(0);
  let lastReport = 0;
  const report = force => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    const total = bytes + partial.reduce((sum, value) => sum + value, 0);
    onProgress?.(`${label} ${done}/${segments.length} · ${formatSize(total)}${estimate}`);
  };
  await mapLimit(segments, CONCURRENCY, async (segment, index) => {
    const headers = segment.byteRange
      ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
      : undefined;
    let buffer = await downloadBuffer(segment.url, {
      headers, retries: 3, signal,
      onProgress: ({ received }) => { partial[index] = received; report(false); }
    });
    if (segment.key?.method === "AES-128" && segment.key.uri) {
      if (!keyCache.has(segment.key.uri)) {
        const response = await fetchWithRetry(segment.key.uri, { retries: 3, timeout: 30000, signal });
        const bytesKey = new Uint8Array(await response.arrayBuffer());
        keyCache.set(segment.key.uri, await crypto.subtle.importKey("raw", bytesKey, { name: "AES-CBC" }, false, ["decrypt"]));
      }
      buffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: segment.key.iv }, keyCache.get(segment.key.uri), buffer);
    }
    buffers[index] = buffer;
    partial[index] = 0;
    bytes += buffer.byteLength;
    done++;
    report(true);
  }, signal);
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