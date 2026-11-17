// ============================================================================
// lib/hls.js — 后台 HLS 下载（共享库，仅后台使用）
// ----------------------------------------------------------------------------
// fetchHlsMedia：取媒体清单；downloadHlsTrack：并发下载分段 + AES-128 解密 +
//   初始化段拼接，返回 {buffer, container, duration}。在后台扩展上下文执行，
//   以豁免页面 CORS / Trusted Types 限制。
// ============================================================================

import { parseMedia, isFmp4Segments } from "./m3u8.js";
import { downloadBuffer, mapLimit, concatBuffers, fetchWithRetry } from "./media-utils.js";

const CONCURRENCY = 4;

export async function fetchHlsMedia(url) {
  const response = await fetchWithRetry(url, { retries: 3, timeout: 30000 });
  return parseMedia(await response.text(), url);
}

export async function downloadHlsTrack(media, label, onProgress) {
  const segments = media.segments;
  if (!segments.length) throw new Error("清单中没有媒体分段");
  const keyCache = new Map();
  const buffers = new Array(segments.length);
  let done = 0;
  await mapLimit(segments, CONCURRENCY, async (segment, index) => {
    const headers = segment.byteRange
      ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
      : undefined;
    let buffer = await downloadBuffer(segment.url, { headers, retries: 3 });
    if (segment.key?.method === "AES-128" && segment.key.uri) {
      if (!keyCache.has(segment.key.uri)) {
        const response = await fetchWithRetry(segment.key.uri, { retries: 3, timeout: 30000 });
        const bytes = new Uint8Array(await response.arrayBuffer());
        keyCache.set(segment.key.uri, await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]));
      }
      buffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: segment.key.iv }, keyCache.get(segment.key.uri), buffer);
    }
    buffers[index] = buffer;
    done++;
    onProgress?.(`${label} ${done}/${segments.length}`);
  });
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
        mapCache.set(cacheKey, await downloadBuffer(segment.map.url, { headers, retries: 3 }));
      }
      parts.push(mapCache.get(cacheKey));
      lastMapUrl = segment.map.url;
    }
    parts.push(buffers[index]);
  }
  return { buffer: concatBuffers(parts), container: isFmp4Segments(segments) ? "fmp4" : "ts", duration: media.totalDuration };
}