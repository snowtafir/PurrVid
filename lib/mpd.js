// ============================================================================
// lib/mpd.js — DASH (MPD) 清单解析（共享库）
// ----------------------------------------------------------------------------
// parseMPD：解析 Period/AdaptationSet/Representation，支持 SegmentTemplate
//   （含 SegmentTimeline）与 SegmentList，输出 video/audio/other 流及 DRM/直播标记。
// representationLabel：生成清晰度展示文本。
// ============================================================================

import { resolveUrl } from "./media-utils.js";

export function parseIsoDuration(value) {
  if (!value) return 0;
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!match) return 0;
  const [, years, months, days, hours, minutes, seconds] = match.map(Number);
  return (years || 0) * 31536000 + (months || 0) * 2592000 + (days || 0) * 86400
    + (hours || 0) * 3600 + (minutes || 0) * 60 + (seconds || 0);
}

function baseUrlOf(node, parentBase) {
  const child = Array.from(node.children || []).find(item => item.tagName === "BaseURL");
  return child ? resolveUrl(parentBase, child.textContent.trim()) : parentBase;
}

function parseRange(value) {
  if (!value) return null;
  const [start, end] = value.split("-").map(Number);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { offset: start, length: end - start + 1 };
}

function fillTemplate(pattern, values) {
  return pattern.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_all, name, pad) => {
    const value = values[name];
    if (value == null) return "";
    const text = String(value);
    return pad ? text.padStart(Number(pad), "0") : text;
  });
}

function parseSegmentTemplate(node, representation, baseUrl, periodDuration) {
  if (!node) return null;
  const timescale = Number(node.getAttribute("timescale")) || 1;
  const media = node.getAttribute("media") || "";
  const startNumber = Number(node.getAttribute("startNumber")) || 1;
  const initNode = Array.from(node.children).find(item => item.tagName === "Initialization");
  const init = initNode
    ? {
        url: resolveUrl(baseUrl, fillTemplate(initNode.getAttribute("sourceURL") || "", { RepresentationID: representation.id, Bandwidth: representation.bandwidth })),
        range: parseRange(initNode.getAttribute("range"))
      }
    : null;

  const timelineNode = Array.from(node.children).find(item => item.tagName === "SegmentTimeline");
  const segments = [];
  const values = { RepresentationID: representation.id, Bandwidth: representation.bandwidth };

  if (timelineNode) {
    let time = 0;
    let number = startNumber;
    for (const s of Array.from(timelineNode.children).filter(item => item.tagName === "S")) {
      const t = s.getAttribute("t");
      if (t != null) time = Number(t);
      const d = Number(s.getAttribute("d")) || 0;
      const r = Number(s.getAttribute("r")) || 0;
      for (let i = 0; i <= r; i++) {
        segments.push({
          url: resolveUrl(baseUrl, fillTemplate(media, { ...values, Number: number, Time: time })),
          range: null
        });
        time += d;
        number++;
      }
    }
  } else {
    const duration = Number(node.getAttribute("duration")) || 0;
    if (duration && periodDuration > 0 && media) {
      const count = Math.ceil((periodDuration * timescale) / duration);
      for (let i = 0; i < count; i++) {
        segments.push({
          url: resolveUrl(baseUrl, fillTemplate(media, { ...values, Number: startNumber + i, Time: i * duration })),
          range: null
        });
      }
    }
  }
  return { init, segments };
}

function parseSegmentList(node, baseUrl) {
  if (!node) return null;
  const initNode = Array.from(node.children).find(item => item.tagName === "Initialization");
  const init = initNode
    ? { url: resolveUrl(baseUrl, initNode.getAttribute("sourceURL") || ""), range: parseRange(initNode.getAttribute("range")) }
    : null;
  const segments = Array.from(node.children)
    .filter(item => item.tagName === "SegmentURL")
    .map(item => ({
      url: resolveUrl(baseUrl, item.getAttribute("media") || ""),
      range: parseRange(item.getAttribute("mediaRange"))
    }));
  return { init, segments };
}

export function parseMPD(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("MPD 清单解析失败");
  const mpd = doc.documentElement;
  if (!mpd || mpd.tagName !== "MPD") throw new Error("不是有效的 DASH 清单");

  const live = (mpd.getAttribute("type") || "static").toLowerCase() === "dynamic";
  const duration = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
  const drm = doc.querySelector("ContentProtection") != null;
  const mpdBase = baseUrlOf(mpd, baseUrl);

  const video = [];
  const audio = [];
  const other = [];

  for (const period of Array.from(mpd.children).filter(item => item.tagName === "Period")) {
    const periodBase = baseUrlOf(period, mpdBase);
    const periodDuration = parseIsoDuration(period.getAttribute("duration")) || duration;

    for (const set of Array.from(period.children).filter(item => item.tagName === "AdaptationSet")) {
      const setBase = baseUrlOf(set, periodBase);
      const setContent = (set.getAttribute("contentType") || "").toLowerCase();
      const setMime = (set.getAttribute("mimeType") || "").toLowerCase();
      const setLang = set.getAttribute("lang") || "";
      const setTemplate = Array.from(set.children).find(item => item.tagName === "SegmentTemplate");
      const setList = Array.from(set.children).find(item => item.tagName === "SegmentList");

      for (const repNode of Array.from(set.children).filter(item => item.tagName === "Representation")) {
        const repBase = baseUrlOf(repNode, setBase);
        const mimeType = (repNode.getAttribute("mimeType") || setMime).toLowerCase();
        const content = setContent || (mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "");
        const representation = {
          id: repNode.getAttribute("id") || "",
          bandwidth: Number(repNode.getAttribute("bandwidth")) || 0,
          width: Number(repNode.getAttribute("width")) || 0,
          height: Number(repNode.getAttribute("height")) || 0,
          codecs: repNode.getAttribute("codecs") || set.getAttribute("codecs") || "",
          mimeType,
          lang: repNode.getAttribute("lang") || setLang,
          baseUrl: repBase,
          init: null,
          segments: null
        };

        const repTemplate = Array.from(repNode.children).find(item => item.tagName === "SegmentTemplate") || setTemplate;
        const repList = Array.from(repNode.children).find(item => item.tagName === "SegmentList") || setList;
        const template = parseSegmentTemplate(repTemplate, representation, repBase, periodDuration);
        const list = template ? null : parseSegmentList(repList, repBase);
        const parsed = template || list;
        if (parsed) {
          representation.init = parsed.init;
          representation.segments = parsed.segments;
        }

        if (content === "video" || mimeType.startsWith("video/")) video.push(representation);
        else if (content === "audio" || mimeType.startsWith("audio/")) audio.push(representation);
        else other.push(representation);
      }
    }
  }

  video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return { drm, live, duration, video, audio, other };
}

export function representationLabel(representation) {
  const parts = [];
  if (representation.height) parts.push(`${representation.height}p`);
  if (representation.width && representation.height) parts.push(`${representation.width}×${representation.height}`);
  if (representation.bandwidth) parts.push(`${(representation.bandwidth / 1e6).toFixed(2)}Mbps`);
  if (representation.lang) parts.push(representation.lang);
  if (representation.codecs) parts.push(representation.codecs.split(".")[0]);
  return parts.join(" · ") || representation.id || "媒体流";
}