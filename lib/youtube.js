// ============================================================================
// lib/youtube.js — YouTube 资源解析（共享库）
// ----------------------------------------------------------------------------
// 站点判定、googlevideo URL 清理/取大小/itag、signatureCipher 解析、格式归一化与
//   排序；buildYoutubeResource 汇总为统一资源对象。被后台与面板/任务页共用。
// ============================================================================

export function isYoutubePage(url) {
  try {
    const host = new URL(url).hostname;
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
  } catch {
    return false;
  }
}

export function isGoogleVideoUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().includes("googlevideo.com");
  } catch {
    return String(url).toLowerCase().includes("googlevideo.com");
  }
}

export function extFromMime(mimeType, isAudio) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("webm")) return isAudio ? "weba" : "webm";
  if (mime.includes("mp4")) return isAudio ? "m4a" : "mp4";
  return isAudio ? "m4a" : "mp4";
}

export function parseSignatureCipher(cipher) {
  if (!cipher) return null;
  const params = new URLSearchParams(cipher);
  const url = params.get("url");
  const s = params.get("s");
  const sp = params.get("sp") || "signature";
  if (!url || !s) return null;
  return { url, s, sp };
}

export function cleanGoogleVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ["range", "rn", "rbuf", "alr", "cpn"]) url.searchParams.delete(key);
    return url.href;
  } catch {
    return rawUrl;
  }
}

export function googleVideoTotal(rawUrl) {
  try {
    const clen = new URL(rawUrl).searchParams.get("clen");
    const value = Number(clen);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function googleVideoItag(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("itag") || "";
  } catch {
    return "";
  }
}

function normalizeFormat(raw, kind, overrideUrl) {
  if (!raw || typeof raw !== "object") return null;
  const mimeType = raw.mimeType || "";
  const isAudio = kind === "audio" || mimeType.startsWith("audio/");
  const resolvedKind = kind === "muxed" ? "muxed" : isAudio ? "audio" : "video";
  const cipher = parseSignatureCipher(raw.signatureCipher || raw.cipher);
  const url = overrideUrl || raw.url || cipher?.url || "";
  if (!url && !cipher) return null;
  const contentLength = Number(raw.contentLength) || googleVideoTotal(url) || 0;
  return {
    itag: String(raw.itag ?? ""),
    kind: resolvedKind,
    mimeType,
    ext: extFromMime(mimeType, isAudio),
    qualityLabel: raw.qualityLabel || "",
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    fps: Number(raw.fps) || 0,
    bitrate: Number(raw.bitrate || raw.averageBitrate) || 0,
    contentLength,
    url,
    cipher,
    needsRewrite: !overrideUrl && /[?&/]n[=/][^/&]+/.test(url),
    needsSig: Boolean(cipher) && !overrideUrl,
    audioTrack: raw.audioTrack?.displayName || raw.audioTrack?.id || "",
    language: raw.language || ""
  };
}

export function parseYoutubeFormats(streamingData, rewrittenUrls) {
  if (!streamingData || typeof streamingData !== "object") return [];
  const formats = [];
  let index = 0;
  for (const raw of streamingData.formats || []) {
    const normalized = normalizeFormat(raw, "muxed", rewrittenUrls?.[index]);
    index++;
    if (normalized) formats.push(normalized);
  }
  for (const raw of streamingData.adaptiveFormats || []) {
    const mime = String(raw.mimeType || "");
    const kind = mime.startsWith("audio/") ? "audio" : "video";
    const normalized = normalizeFormat(raw, kind, rewrittenUrls?.[index]);
    index++;
    if (normalized) formats.push(normalized);
  }
  return formats;
}

export function youtubeFormatLabel(format) {
  const parts = [];
  if (format.kind === "audio") {
    parts.push(format.audioTrack || format.language || "音频");
    if (format.bitrate) parts.push(`${Math.round(format.bitrate / 1000)}kbps`);
    parts.push(format.ext.toUpperCase());
  } else {
    if (format.height) parts.push(`${format.height}p`);
    else if (format.qualityLabel) parts.push(format.qualityLabel);
    if (format.fps && format.fps > 30) parts.push(`${format.fps}fps`);
    if (format.bitrate) parts.push(`${(format.bitrate / 1e6).toFixed(2)}Mbps`);
    parts.push(format.ext.toUpperCase());
    if (format.kind === "muxed") parts.push("内嵌音频");
  }
  return parts.filter(Boolean).join(" · ") || `itag ${format.itag}`;
}

export function sortYoutubeFormats(formats) {
  const videos = formats.filter(f => f.kind !== "audio")
    .sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));
  const audio = formats.filter(f => f.kind === "audio")
    .sort((a, b) => b.bitrate - a.bitrate);
  return { videos, audio };
}

export function buildYoutubeResource({ videoDetails, streamingData, pageUrl, title, rewrittenUrls, hlsManifestUrl }) {
  const details = videoDetails || {};
  const formats = parseYoutubeFormats(streamingData, rewrittenUrls);
  const hls = hlsManifestUrl || streamingData?.hlsManifestUrl || "";
  if (!formats.length && !hls) return null;
  return {
    kind: "youtube",
    url: pageUrl || `https://www.youtube.com/watch?v=${details.videoId || ""}`,
    videoId: details.videoId || "",
    title: (details.title || title || "YouTube 视频").slice(0, 120),
    author: details.author || "",
    duration: Number(details.lengthSeconds) || 0,
    host: "youtube.com",
    formats,
    hlsManifestUrl: hls,
    size: formats.reduce((max, f) => Math.max(max, f.contentLength), 0),
    info: `${formats.filter(f => f.kind !== "audio").length} 个画质 / ${formats.filter(f => f.kind === "audio").length} 个音轨`
  };
}