// ============================================================================
// lib/m3u8.js — HLS (M3U8) 清单解析（共享库）
// ----------------------------------------------------------------------------
// parseMaster：主清单 → 清晰度变体 + 音轨 rendition；
// parseMedia：媒体清单 → 分段（含 AES-128 密钥/IV、EXT-X-MAP 初始化段、byteRange、
//   直播判定 endList、DRM 判定）；isFmp4Segments：判断分段容器是 fMP4 还是 TS。
// ============================================================================

import { parseAttributes, resolveUrl } from "./media-utils.js";

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

export function parseMaster(text, baseUrl) {
  const variants = [];
  const audioRenditions = [];
  const lines = text.split(/\r?\n/);
  let pendingVariant = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const resolution = (attrs.RESOLUTION || "").split("x");
      pendingVariant = {
        bandwidth: Number(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || 0),
        width: Number(resolution[0]) || 0,
        height: Number(resolution[1]) || 0,
        codecs: attrs.CODECS || "",
        name: attrs.NAME || "",
        audioGroup: attrs.AUDIO || "",
        url: ""
      };
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if ((attrs.TYPE || "").toUpperCase() === "AUDIO" && attrs.URI) {
        audioRenditions.push({
          url: resolveUrl(baseUrl, attrs.URI),
          groupId: attrs["GROUP-ID"] || "",
          name: attrs.NAME || "",
          language: attrs.LANGUAGE || "",
          default: (attrs.DEFAULT || "").toUpperCase() === "YES",
          autoSelect: (attrs.AUTOSELECT || "").toUpperCase() === "YES"
        });
      }
    } else if (!line.startsWith("#") && pendingVariant) {
      pendingVariant.url = resolveUrl(baseUrl, line);
      variants.push(pendingVariant);
      pendingVariant = null;
    }
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants, audioRenditions };
}

function parseHexIv(value) {
  const hex = value.replace(/^0x/i, "").padStart(32, "0").slice(-32);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return bytes;
}

function sequenceIv(sequence) {
  const bytes = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function parseByteRange(value) {
  if (!value) return null;
  const [lengthPart, offsetPart] = value.split("@");
  const length = Number(lengthPart);
  if (!Number.isFinite(length) || length <= 0) return null;
  return { offset: offsetPart != null ? Number(offsetPart) : null, length };
}

export function parseMedia(text, baseUrl) {
  const segments = [];
  const lines = text.split(/\r?\n/);
  let mediaSequence = 0;
  let totalDuration = 0;
  let endList = false;
  let currentKey = null;
  let currentMap = null;
  let pendingDuration = 0;
  let pendingRange = null;
  let discontinuity = false;
  let lastUrl = "";
  let lastRangeEnd = 0;
  let drm = false;
  let aes128 = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const method = (attrs.METHOD || "").toUpperCase();
      if (method === "NONE") {
        currentKey = null;
      } else if (method) {
        const keyFormat = attrs.KEYFORMAT || "";
        if (method === "SAMPLE-AES" || /urn:uuid:edef8ba9|com\.widevine|com\.microsoft|com\.apple\.streamingkeydelivery/i.test(keyFormat)) {
          drm = true;
        }
        if (method === "AES-128") aes128 = true;
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : "",
          iv: attrs.IV ? parseHexIv(attrs.IV) : null,
          keyFormat
        };
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        currentMap = {
          url: resolveUrl(baseUrl, attrs.URI),
          byteRange: parseByteRange(attrs.BYTERANGE)
        };
        if (currentMap.byteRange && currentMap.byteRange.offset == null) currentMap.byteRange.offset = 0;
      }
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length));
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]) || 0;
    } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      discontinuity = true;
    } else if (!line.startsWith("#")) {
      const url = resolveUrl(baseUrl, line);
      let byteRange = null;
      if (pendingRange) {
        const offset = pendingRange.offset != null
          ? pendingRange.offset
          : (url === lastUrl ? lastRangeEnd : 0);
        byteRange = { offset, length: pendingRange.length };
      }
      segments.push({
        url,
        duration: pendingDuration,
        byteRange,
        key: currentKey,
        map: currentMap,
        discontinuity,
        sequence: mediaSequence + segments.length
      });
      totalDuration += pendingDuration;
      if (byteRange) {
        lastRangeEnd = byteRange.offset + byteRange.length;
        lastUrl = url;
      } else {
        lastRangeEnd = 0;
        lastUrl = url;
      }
      pendingDuration = 0;
      pendingRange = null;
      discontinuity = false;
    }
  }

  for (const segment of segments) {
    if (segment.key && !segment.key.iv && segment.key.method === "AES-128") {
      segment.key = { ...segment.key, iv: sequenceIv(segment.sequence) };
    }
  }

  return { segments, totalDuration, endList, mediaSequence, drm, aes128 };
}

export function isFmp4Segments(segments) {
  if (segments.some(segment => segment.map)) return true;
  return segments.every(segment => /\.(mp4|m4s|m4a|m4v|mov)(\?|$)/i.test(segment.url));
}