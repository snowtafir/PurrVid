// ============================================================================
// tasks/tasks.js — 下载任务管理页（扩展页面 · module）
// ----------------------------------------------------------------------------
// 职责：展示并执行下载任务队列。支持 HLS / DASH / YouTube / 直连四类资源；
//   流媒体先解析清单、让用户选清晰度/音轨，再分段下载并合并/转封装，最后经
//   downloads API 保存。任务状态与后台 service-worker 双向同步。
//
// 为什么是独立页面：流媒体下载耗时长、需保持运行，放在扩展页（非内容脚本）可
//   不受页面导航影响，且能直接使用 downloads / ffmpeg（后台 Worker）。
//
// 消息契约（↔ background/service-worker.js）：
//   发送：update-task · remove-task · yt-rewrite · get-tasks · tasks-page-ready
//   接收：tasks-updated（触发重新同步）
// 存储键：local.taskConcurrency（分段并发）· local.hlsFormat（mp4|ts）
// DOM id（与 tasks.html 对应）：task-list · empty-tip · concurrency · hls-format · clear-finished
// ============================================================================

import {
  fetchWithRetry,
  downloadBuffer,
  mapLimit,
  concatBuffers,
  formatSize,
  sanitizeFilename,
  hostOf
} from "../lib/media-utils.js";
import { isMasterPlaylist, parseMaster, parseMedia, isFmp4Segments } from "../lib/m3u8.js";
import { parseMPD, representationLabel } from "../lib/mpd.js";
import { remuxWithFFmpeg, mergeWithFFmpeg } from "../lib/ffmpeg-client.js";
import { sortYoutubeFormats, youtubeFormatLabel, cleanGoogleVideoUrl, googleVideoTotal } from "../lib/youtube.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ---- DOM 引用与状态 ----------------------------------------------------------
const listEl = document.getElementById("task-list");
const emptyTip = document.getElementById("empty-tip");
const concurrencySelect = document.getElementById("concurrency");
const hlsFormatSelect = document.getElementById("hls-format");
const clearFinishedButton = document.getElementById("clear-finished");

const tasks = new Map();        // id → 任务对象（与后台同步）
const cards = new Map();        // id → 卡片 DOM 引用
const activeTasks = new Map();  // id → 运行态（AbortController/进度计数等）
let concurrency = 5;            // 分段并发数
let hlsFormat = "mp4";          // HLS 保存格式

const STATUS_LABELS = {
  pending: "等待中",
  parsing: "解析清单…",
  selecting: "等待选择",
  running: "下载中",
  merging: "合并中…",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
  interrupted: "已中断"
};

// ---- 与后台通信 --------------------------------------------------------------
function sendToBackground(message) {
  return api.runtime.sendMessage(message).catch(() => null);
}

// 更新本地任务 + 通知后台 + 刷新卡片（运行中的卡片由 tickProgress 驱动，不在此重绘）。
function updateTask(id, patch) {
  const task = tasks.get(id);
  if (task) Object.assign(task, patch);
  sendToBackground({ type: "update-task", id, patch });
  const card = cards.get(id);
  if (card && !activeTasks.has(id)) renderCard(task, card);
}

async function fetchText(url, signal) {
  const response = await fetchWithRetry(url, { retries: 2, timeout: 30000, signal });
  return response.text();
}

// ---- 卡片 UI -----------------------------------------------------------------
function createCard(task) {
  const cardEl = document.createElement("li");
  cardEl.className = "task-card";

  const head = document.createElement("div");
  head.className = "task-head";
  const badge = document.createElement("span");
  const kind = task.resource.kind;
  const badgeClass = kind === "dash" ? "dash" : kind === "hls" ? "" : kind === "youtube" ? "youtube" : "direct";
  const badgeText = kind === "hls" ? "HLS" : kind === "dash" ? "DASH" : kind === "youtube" ? "YouTube" : "直连";
  badge.className = `kind-badge ${badgeClass}`;
  badge.textContent = badgeText;
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.resource.title || task.resource.host || "媒体资源";
  title.title = task.resource.url;
  const status = document.createElement("span");
  status.className = "task-status";
  head.append(badge, title, status);

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const select = document.createElement("div");
  select.className = "task-select";
  select.hidden = true;

  const progress = document.createElement("div");
  progress.className = "task-progress";
  progress.hidden = true;
  const bar = document.createElement("div");
  bar.className = "bar";
  const barFill = document.createElement("i");
  bar.appendChild(barFill);
  const progressText = document.createElement("div");
  progressText.className = "progress-text";
  progress.append(bar, progressText);

  const error = document.createElement("div");
  error.className = "task-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "task-actions";

  cardEl.append(head, meta, select, progress, error, actions);
  listEl.appendChild(cardEl);

  const card = { root: cardEl, status, meta, select, progress, barFill, progressText, error, actions };
  cards.set(task.id, card);
  renderCard(task, card);
  return card;
}

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderCard(task, card) {
  if (!task) return;
  const { status, meta, select, progress, error, actions } = card;
  status.textContent = STATUS_LABELS[task.status] || task.status;
  status.className = `task-status ${task.status}`;
  meta.textContent = [hostOf(task.resource.url), task.resource.info, task.filename, task.size ? formatSize(task.size) : ""]
    .filter(Boolean).join(" · ");

  if (!activeTasks.has(task.id)) select.hidden = true;
  progress.hidden = !["running", "merging"].includes(task.status);
  error.hidden = !(task.error && ["error", "interrupted"].includes(task.status));
  if (!error.hidden) error.textContent = task.error;

  actions.replaceChildren();
  if (["pending", "parsing", "selecting", "running", "merging"].includes(task.status)) {
    actions.appendChild(makeButton("取消", "minor-button", () => cancelTask(task.id)));
  } else if (task.status === "done") {
    if (task.downloadId != null) {
      actions.appendChild(makeButton("打开文件", "primary-button", () => openDownload(task.downloadId)));
    }
    actions.appendChild(makeButton("移除", "minor-button", () => removeTask(task.id)));
  } else {
    actions.appendChild(makeButton("重试", "primary-button", () => retryTask(task.id)));
    actions.appendChild(makeButton("移除", "minor-button", () => removeTask(task.id)));
  }
  emptyTip.hidden = tasks.size > 0;
}

// ---- 进度统计与刷新 ----------------------------------------------------------
function pushSample(state) {
  state.samples.push({ t: Date.now(), bytes: state.received });
  if (state.samples.length > 40) state.samples.shift();
}

// 每 500ms 刷新运行中卡片的进度条/速度/分段计数。
function tickProgress() {
  const now = Date.now();
  for (const [id, state] of activeTasks) {
    const card = cards.get(id);
    const task = tasks.get(id);
    if (!card || !task) continue;
    card.status.textContent = STATUS_LABELS[task.status] || task.status;
    card.status.className = `task-status ${task.status}`;
    if (!["running", "merging"].includes(task.status)) continue;
    const percent = task.status === "merging" ? 100
      : state.totalSegments ? Math.min(100, Math.round((state.doneSegments / state.totalSegments) * 100)) : 0;
    card.barFill.style.width = `${percent}%`;
    card.progress.hidden = false;
    // 用最近 6s 的采样估算瞬时速度。
    const samples = state.samples.filter(sample => now - sample.t < 6000);
    let speedText = "";
    if (samples.length >= 2) {
      const first = samples[0], last = samples[samples.length - 1];
      const speed = ((last.bytes - first.bytes) / Math.max(1, last.t - first.t)) * 1000;
      if (speed > 0) speedText = ` · ${formatSize(speed)}/s`;
    }
    const stage = state.stage ? `${state.stage} · ` : "";
    card.progressText.textContent = task.status === "merging"
      ? "正在合并 / 转封装，请稍候（取决于文件大小）…"
      : `${stage}${state.doneSegments}/${state.totalSegments} 分段 · 已下载 ${formatSize(state.received)}${speedText} · ${percent}%`;
  }
}
setInterval(tickProgress, 500);

// ---- 清晰度/音轨选择对话框（返回 Promise，取消时 resolve null） --------------
function askSelection(task, card, { videoOptions = [], audioOptionsFor = null, note = "" }) {
  return new Promise(resolve => {
    const state = activeTasks.get(task.id);
    const { select } = card;
    select.replaceChildren();
    select.hidden = false;

    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "progress-text";
      noteEl.textContent = note;
      select.appendChild(noteEl);
    }

    let videoSelect = null;
    let audioSelect = null;

    // 音轨选项随所选视频清晰度变化（按 audioGroup 过滤）。
    const rebuildAudio = () => {
      if (!audioSelect || !audioOptionsFor) return;
      const options = audioOptionsFor(videoSelect ? Number(videoSelect.value) : 0);
      audioSelect.replaceChildren();
      for (const [index, option] of options.entries()) {
        const element = document.createElement("option");
        element.value = String(index);
        element.textContent = option.label;
        audioSelect.appendChild(element);
      }
      audioSelect.parentElement.hidden = options.length === 0;
    };

    if (videoOptions.length) {
      const label = document.createElement("label");
      label.className = "field";
      label.append("视频清晰度 ");
      videoSelect = document.createElement("select");
      for (const [index, option] of videoOptions.entries()) {
        const element = document.createElement("option");
        element.value = String(index);
        element.textContent = option.label;
        videoSelect.appendChild(element);
      }
      videoSelect.addEventListener("change", rebuildAudio);
      label.appendChild(videoSelect);
      select.appendChild(label);
    }

    if (audioOptionsFor) {
      const label = document.createElement("label");
      label.className = "field";
      label.append("音频 ");
      audioSelect = document.createElement("select");
      label.appendChild(audioSelect);
      select.appendChild(label);
      rebuildAudio();
    }

    const actions = document.createElement("div");
    actions.className = "select-actions";
    const startButton = makeButton("开始下载", "primary-button", () => {
      select.hidden = true;
      state.selectionResolve = null;
      resolve({
        video: videoSelect ? Number(videoSelect.value) : 0,
        audio: audioSelect && !audioSelect.parentElement.hidden ? Number(audioSelect.value) : -1
      });
    });
    const cancelButton = makeButton("取消", "minor-button", () => {
      select.hidden = true;
      state.selectionResolve = null;
      resolve(null);
    });
    actions.append(startButton, cancelButton);
    select.appendChild(actions);

    state.selectionResolve = resolve;
    updateTask(task.id, { status: "selecting" });
  });
}

// ---- HLS 分段下载 ------------------------------------------------------------
async function loadAesKey(uri, cache, signal) {
  if (cache.has(uri)) return cache.get(uri);
  const response = await fetchWithRetry(uri, { retries: 3, timeout: 30000, signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]);
  cache.set(uri, key);
  return key;
}

async function downloadHlsTrack(media, signal, state, label) {
  const segments = media.segments;
  if (!segments.length) throw new Error("清单中没有媒体分段");
  state.totalSegments += segments.length;
  state.stage = label;
  const keyCache = new Map();
  const buffers = new Array(segments.length);

  await mapLimit(segments, concurrency, async (segment, index) => {
    const headers = segment.byteRange
      ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
      : undefined;
    let last = 0;
    let buffer = await downloadBuffer(segment.url, {
      signal,
      headers,
      retries: 3,
      onProgress: ({ received }) => {
        state.received += received - last;
        last = received;
        pushSample(state);
      }
    });
    if (segment.key?.method === "AES-128" && segment.key.uri) {
      const key = await loadAesKey(segment.key.uri, keyCache, signal);
      buffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: segment.key.iv }, key, buffer);
    }
    buffers[index] = buffer;
    state.doneSegments++;
  }, signal);

  // 顺序拼接，必要时插入初始化段（EXT-X-MAP）。
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
        mapCache.set(cacheKey, await downloadBuffer(segment.map.url, { signal, headers, retries: 3 }));
      }
      parts.push(mapCache.get(cacheKey));
      lastMapUrl = segment.map.url;
    }
    parts.push(buffers[index]);
  }

  return {
    buffer: concatBuffers(parts),
    container: isFmp4Segments(segments) ? "fmp4" : "ts",
    duration: media.totalDuration
  };
}

// ---- DASH 分段下载 -----------------------------------------------------------
function dashExtOf(mimeType, isAudio) {
  if (/webm/.test(mimeType)) return isAudio ? "weba" : "webm";
  if (/mp4|mp2t/.test(mimeType)) return isAudio ? "m4a" : "mp4";
  return isAudio ? "m4a" : "mp4";
}

async function downloadDashTrack(representation, signal, state, label) {
  const isAudio = representation.mimeType.startsWith("audio/");
  const ext = dashExtOf(representation.mimeType, isAudio);
  state.stage = label;

  // 无分段列表：整段下载 baseUrl。
  if (!representation.segments || !representation.segments.length) {
    state.totalSegments += 1;
    let last = 0;
    const buffer = await downloadBuffer(representation.baseUrl, {
      signal,
      retries: 3,
      onProgress: ({ received }) => {
        state.received += received - last;
        last = received;
        pushSample(state);
      }
    });
    state.doneSegments++;
    return { buffer, ext, mime: representation.mimeType };
  }

  const segments = representation.segments;
  state.totalSegments += segments.length + (representation.init ? 1 : 0);
  const buffers = new Array(segments.length);
  await mapLimit(segments, concurrency, async (segment, index) => {
    const headers = segment.range
      ? { Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}` }
      : undefined;
    let last = 0;
    buffers[index] = await downloadBuffer(segment.url, {
      signal,
      headers,
      retries: 3,
      onProgress: ({ received }) => {
        state.received += received - last;
        last = received;
        pushSample(state);
      }
    });
    state.doneSegments++;
  }, signal);

  const parts = [];
  if (representation.init) {
    const headers = representation.init.range
      ? { Range: `bytes=${representation.init.range.offset}-${representation.init.range.offset + representation.init.range.length - 1}` }
      : undefined;
    parts.push(await downloadBuffer(representation.init.url, { signal, headers, retries: 3 }));
    state.doneSegments++;
  }
  parts.push(...buffers);
  return { buffer: concatBuffers(parts), ext, mime: representation.mimeType };
}

// ---- 保存与命名 --------------------------------------------------------------
async function saveBuffer(buffer, mime, filename, task) {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await api.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    updateTask(task.id, { status: "done", downloadId, filename, size: buffer.byteLength, error: null });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function outputName(task, ext, height) {
  const base = sanitizeFilename(task.resource.title || task.resource.host || "video");
  return `${base}${height ? `_${height}p` : ""}.${ext}`;
}

// ---- HLS 任务 ----------------------------------------------------------------
async function runHlsTask(task, state) {
  const { signal } = state.controller;
  const text = await fetchText(task.resource.url, signal);
  let media;
  let mediaUrl = task.resource.url;
  let audioRendition = null;
  let height = task.resource.height || 0;
  let audioOnly = /^audio\//i.test(task.resource.mime || "");

  if (isMasterPlaylist(text)) {
    const master = parseMaster(text, task.resource.url);
    if (!master.variants.length) throw new Error("未找到可用的清晰度");
    // 按所选清晰度的 audioGroup 过滤可用音轨。
    const audioFor = index => {
      const group = master.variants[index]?.audioGroup;
      if (!group) return [];
      return master.audioRenditions
        .filter(rendition => rendition.groupId === group)
        .map(rendition => ({
          label: `${rendition.name || rendition.language || "音频"}${rendition.default ? "（默认）" : ""}`,
          rendition
        }));
    };
    const selection = await askSelection(task, cards.get(task.id), {
      videoOptions: master.variants.map(variant => ({
        label: [
          variant.height ? `${variant.height}p` : "",
          variant.bandwidth ? `${(variant.bandwidth / 1e6).toFixed(2)}Mbps` : "",
          variant.codecs ? variant.codecs.split(".")[0] : "",
          variant.name
        ].filter(Boolean).join(" · ") || variant.url,
        variant
      })),
      audioOptionsFor: audioFor,
      note: "选择清晰度后开始下载；若视频与音频分离，将自动合并。"
    });
    if (!selection) return false;
    const variant = master.variants[selection.video];
    height = variant.height || height;
    if (variant.codecs) audioOnly = !/avc1|hev1|hvc1|vp09|vp8|av01|dvh/i.test(variant.codecs);
    const options = audioFor(selection.video);
    audioRendition = selection.audio >= 0 ? options[selection.audio]?.rendition : (options.find(option => option.rendition.default)?.rendition || options[0]?.rendition || null);
    mediaUrl = variant.url;
    media = parseMedia(await fetchText(mediaUrl, signal), mediaUrl);
  } else {
    media = parseMedia(text, mediaUrl);
  }

  if (media.drm) throw new Error("该 HLS 流受 DRM（SAMPLE-AES / Widevine / FairPlay 等）保护，无法下载。");
  if (!media.endList) throw new Error("这是直播流（无 ENDLIST），不支持完整下载。");
  if (task.resource.live) throw new Error("这是直播流，不支持完整下载。");

  updateTask(task.id, { status: "running" });
  const videoTrack = await downloadHlsTrack(media, signal, state, "视频分段");
  let audioTrack = null;
  if (audioRendition) {
    const audioMedia = parseMedia(await fetchText(audioRendition.url, signal), audioRendition.url);
    if (audioMedia.drm) throw new Error("音频流受 DRM 保护，无法下载。");
    audioTrack = await downloadHlsTrack(audioMedia, signal, state, "音频分段");
  }

  updateTask(task.id, { status: "merging" });
  if (audioTrack) {
    const merged = await mergeWithFFmpeg(videoTrack.buffer, audioTrack.buffer, "merged.mp4", "mp4", "m4a");
    await saveBuffer(merged, "video/mp4", outputName(task, "mp4", height), task);
    return true;
  }

  const audioOnlyTrack = audioOnly && !audioRendition;
  if (videoTrack.container === "ts") {
    if (hlsFormat === "ts" && !audioOnlyTrack) {
      await saveBuffer(videoTrack.buffer, "video/mp2t", outputName(task, "ts", height), task);
    } else {
      const ext = audioOnlyTrack ? "m4a" : "mp4";
      const remuxed = await remuxWithFFmpeg(videoTrack.buffer, "input.ts", `output.${ext}`, ext === "mp4" ? ["-movflags", "+faststart"] : []);
      await saveBuffer(remuxed, audioOnlyTrack ? "audio/mp4" : "video/mp4", outputName(task, ext, height), task);
    }
  } else {
    const ext = audioOnlyTrack ? "m4a" : "mp4";
    await saveBuffer(videoTrack.buffer, audioOnlyTrack ? "audio/mp4" : "video/mp4", outputName(task, ext, height), task);
  }
  return true;
}

// ---- DASH 任务 ---------------------------------------------------------------
async function runDashTask(task, state) {
  const { signal } = state.controller;
  const text = await fetchText(task.resource.url, signal);
  const mpd = parseMPD(text, task.resource.url);
  if (mpd.drm) throw new Error("该 DASH 流受 DRM（Widevine / PlayReady / ClearKey 等）保护，无法下载。");
  if (mpd.live) throw new Error("这是动态（直播）MPD，不支持完整下载。");
  if (!mpd.video.length && !mpd.audio.length) throw new Error("MPD 中没有可用的媒体流");

  const videoOptions = mpd.video.map(representation => ({ label: representationLabel(representation), representation }));
  if (mpd.audio.length) videoOptions.push({ label: "无（仅下载音频）", representation: null });
  const audioOptions = mpd.audio.map(representation => ({ label: representationLabel(representation), representation }));
  if (mpd.video.length) audioOptions.push({ label: "无（仅下载视频）", representation: null });

  let videoRep = mpd.video[0] || null;
  let audioRep = mpd.audio[0] || null;
  if (videoOptions.length > 1 || audioOptions.length > 1) {
    const selection = await askSelection(task, cards.get(task.id), {
      videoOptions: videoOptions.length ? videoOptions : [],
      audioOptionsFor: () => audioOptions,
      note: "选择要下载的视频与音频流，将自动合并为单个文件。"
    });
    if (!selection) return false;
    videoRep = videoOptions.length ? videoOptions[selection.video]?.representation : null;
    audioRep = audioOptions.length && selection.audio >= 0 ? audioOptions[selection.audio]?.representation : null;
  }
  if (!videoRep && !audioRep) throw new Error("未选择任何媒体流");

  updateTask(task.id, { status: "running" });
  const videoTrack = videoRep ? await downloadDashTrack(videoRep, signal, state, "视频流") : null;
  const audioTrack = audioRep ? await downloadDashTrack(audioRep, signal, state, "音频流") : null;

  updateTask(task.id, { status: "merging" });
  if (videoTrack && audioTrack) {
    const outExt = videoTrack.ext === "webm" ? "webm" : "mp4";
    const merged = await mergeWithFFmpeg(videoTrack.buffer, audioTrack.buffer, `merged.${outExt}`, videoTrack.ext, audioTrack.ext);
    await saveBuffer(merged, outExt === "webm" ? "video/webm" : "video/mp4", outputName(task, outExt, videoRep?.height), task);
  } else if (videoTrack) {
    await saveBuffer(videoTrack.buffer, videoTrack.mime || "video/mp4", outputName(task, videoTrack.ext, videoRep?.height), task);
  } else {
    await saveBuffer(audioTrack.buffer, audioTrack.mime || "audio/mp4", outputName(task, audioTrack.ext), task);
  }
  return true;
}

// ---- YouTube 任务 ------------------------------------------------------------
const GOOGLEVIDEO_CHUNK = 8 * 1024 * 1024;

function youtubeOptionLabel(format) {
  const size = format.contentLength ? ` · ${formatSize(format.contentLength)}` : "";
  return youtubeFormatLabel(format) + size;
}

function youtubeMergeContainer(videoExt, audioExt) {
  if (videoExt === "webm" && audioExt === "weba") return "webm";
  if (videoExt === "mp4" && audioExt === "m4a") return "mp4";
  return "mkv";
}

function youtubeMime(ext) {
  if (ext === "webm") return "video/webm";
  if (ext === "weba") return "audio/webm";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

async function downloadGoogleVideo(format, signal, state, label) {
  const baseUrl = cleanGoogleVideoUrl(format.finalUrl || format.url);
  const total = format.contentLength || googleVideoTotal(baseUrl);
  state.stage = label;

  if (!total || total <= GOOGLEVIDEO_CHUNK) {
    state.totalSegments += 1;
    let last = 0;
    const buffer = await downloadBuffer(baseUrl, {
      signal,
      retries: 3,
      timeout: 300000,
      onProgress: ({ received }) => {
        state.received += received - last;
        last = received;
        pushSample(state);
      }
    });
    state.doneSegments++;
    return buffer;
  }

  const chunks = [];
  for (let start = 0; start < total; start += GOOGLEVIDEO_CHUNK) {
    chunks.push({ start, end: Math.min(start + GOOGLEVIDEO_CHUNK, total) - 1 });
  }
  state.totalSegments += chunks.length;
  const buffers = new Array(chunks.length);
  await mapLimit(chunks, Math.min(concurrency, 4), async (chunk, index) => {
    let last = 0;
    buffers[index] = await downloadBuffer(baseUrl, {
      signal,
      retries: 3,
      timeout: 300000,
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
      onProgress: ({ received }) => {
        state.received += received - last;
        last = received;
        pushSample(state);
      }
    });
    state.doneSegments++;
  }, signal);
  return concatBuffers(buffers);
}

async function runYoutubeTask(task, state) {
  const { signal } = state.controller;
  const resource = task.resource;
  const allFormats = Array.isArray(resource.formats) ? resource.formats : [];
  const usable = allFormats.filter(format => format.url && !format.needsSig);

  // 无可用直链时回退到 HLS 清单。
  if (!usable.length) {
    if (resource.hlsManifestUrl) {
      const hlsTask = { ...task, resource: { ...resource, kind: "hls", url: resource.hlsManifestUrl, ext: "m3u8" } };
      return runHlsTask(hlsTask, state);
    }
    throw new Error("没有可直接下载的格式（可能受签名保护、需要登录或为直播）。");
  }

  const { videos, audio } = sortYoutubeFormats(usable);
  const videoOptions = videos.map(format => ({ label: youtubeOptionLabel(format), format }));
  if (audio.length) videoOptions.push({ label: "无（仅下载音频）", format: null });
  const audioBase = audio.map(format => ({ label: youtubeOptionLabel(format), format }));
  const audioOptionsFor = videoIndex => {
    const videoFormat = videoOptions[videoIndex]?.format;
    if (videoFormat && videoFormat.kind === "muxed") return [{ label: "内嵌音频（无需合并）", format: null }];
    const options = audioBase.slice();
    if (videoFormat) options.push({ label: "无（仅下载视频）", format: null });
    return options;
  };

  const selection = await askSelection(task, cards.get(task.id), {
    videoOptions,
    audioOptionsFor,
    note: "选择画质与音轨；视频/音频分离的自适应流会自动合并。"
  });
  if (!selection) return false;

  const videoFormat = videoOptions[selection.video]?.format || null;
  const audioOptions = audioOptionsFor(selection.video);
  const audioFormat = selection.audio >= 0 ? audioOptions[selection.audio]?.format || null : null;
  if (!videoFormat && !audioFormat) throw new Error("未选择任何格式");

  // 下载前经后台转发到 youtube-bridge 实时解混淆 n 参数。
  const targets = [videoFormat, audioFormat].filter(Boolean);
  const rawUrls = targets.map(format => format.url);
  let freshUrls = rawUrls;
  const rewrite = await sendToBackground({ type: "yt-rewrite", tabId: resource.tabId, urls: rawUrls });
  if (rewrite?.urls?.length === rawUrls.length) {
    freshUrls = rewrite.urls.map((url, index) => url || rawUrls[index]);
  }
  targets.forEach((format, index) => { format.finalUrl = freshUrls[index]; });

  updateTask(task.id, { status: "running" });
  const videoBuffer = videoFormat ? await downloadGoogleVideo(videoFormat, signal, state, "视频") : null;
  const audioBuffer = audioFormat ? await downloadGoogleVideo(audioFormat, signal, state, "音频") : null;

  updateTask(task.id, { status: "merging" });
  const height = videoFormat?.height || 0;
  if (videoBuffer && audioBuffer) {
    const container = youtubeMergeContainer(videoFormat.ext, audioFormat.ext);
    const merged = await mergeWithFFmpeg(videoBuffer, audioBuffer, `merged.${container}`, videoFormat.ext, audioFormat.ext);
    await saveBuffer(merged, youtubeMime(container), outputName(task, container, height), task);
  } else if (videoBuffer) {
    await saveBuffer(videoBuffer, youtubeMime(videoFormat.ext), outputName(task, videoFormat.ext, height), task);
  } else {
    await saveBuffer(audioBuffer, youtubeMime(audioFormat.ext), outputName(task, audioFormat.ext), task);
  }
  return true;
}

// ---- 任务调度 ----------------------------------------------------------------
async function runTask(task) {
  const state = {
    controller: new AbortController(),
    received: 0,
    totalSegments: 0,
    doneSegments: 0,
    samples: [],
    stage: "",
    selectionResolve: null
  };
  activeTasks.set(task.id, state);
  updateTask(task.id, { status: "parsing", error: null });
  try {
    let finished = false;
    if (task.resource.kind === "hls") finished = await runHlsTask(task, state);
    else if (task.resource.kind === "dash") finished = await runDashTask(task, state);
    else if (task.resource.kind === "youtube") finished = await runYoutubeTask(task, state);
    else {
      // 直连资源：交给 downloads API。
      const downloadId = await api.downloads.download({
        url: task.resource.url,
        filename: outputName(task, task.resource.ext || "mp4"),
        saveAs: false,
        conflictAction: "uniquify"
      });
      updateTask(task.id, { status: "done", downloadId, error: null });
      finished = true;
    }
    if (!finished) updateTask(task.id, { status: "cancelled" });
  } catch (error) {
    if (state.controller.signal.aborted || error?.name === "AbortError") {
      updateTask(task.id, { status: "cancelled", error: null });
    } else {
      updateTask(task.id, { status: "error", error: String(error?.message || error) });
    }
  } finally {
    activeTasks.delete(task.id);
    const card = cards.get(task.id);
    if (card) renderCard(tasks.get(task.id), card);
    processQueue();
  }
}

// 串行队列：同一时刻只跑一个任务。
function processQueue() {
  if (activeTasks.size > 0) return;
  const next = [...tasks.values()].find(task => task.status === "pending");
  if (next) runTask(next);
}

function cancelTask(id) {
  const state = activeTasks.get(id);
  if (state) {
    state.controller.abort();
    state.selectionResolve?.(null);
  } else {
    updateTask(id, { status: "cancelled" });
  }
}

function retryTask(id) {
  updateTask(id, { status: "pending", error: null, downloadId: null });
  processQueue();
}

async function removeTask(id) {
  const state = activeTasks.get(id);
  if (state) {
    state.controller.abort();
    state.selectionResolve?.(null);
  }
  tasks.delete(id);
  cards.get(id)?.root.remove();
  cards.delete(id);
  await sendToBackground({ type: "remove-task", id });
  emptyTip.hidden = tasks.size > 0;
}

async function openDownload(downloadId) {
  try {
    if (api.downloads.open) await api.downloads.open(downloadId);
    else if (api.downloads.show) await api.downloads.show(downloadId);
  } catch {
    try {
      await api.downloads.show?.(downloadId);
    } catch {}
  }
}

// ---- 与后台同步任务列表 ------------------------------------------------------
async function syncTasks(initial = false) {
  const response = await sendToBackground({ type: initial ? "tasks-page-ready" : "get-tasks" });
  const list = response?.tasks || [];
  const ids = new Set(list.map(task => task.id));
  // 移除后台已不存在的卡片。
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.root.remove();
      cards.delete(id);
      tasks.delete(id);
    }
  }
  for (const task of list) {
    tasks.set(task.id, task);
    if (!cards.has(task.id)) createCard(task);
    else if (!activeTasks.has(task.id)) renderCard(task, cards.get(task.id));
  }
  emptyTip.hidden = tasks.size > 0;
  processQueue();
}

api.runtime.onMessage.addListener(message => {
  if (message?.type === "tasks-updated") syncTasks(false);
});

// ---- 设置项 ------------------------------------------------------------------
concurrencySelect.addEventListener("change", () => {
  concurrency = Number(concurrencySelect.value) || 5;
  api.storage.local.set({ taskConcurrency: concurrency }).catch(() => {});
});
hlsFormatSelect.addEventListener("change", () => {
  hlsFormat = hlsFormatSelect.value;
  api.storage.local.set({ hlsFormat }).catch(() => {});
});
clearFinishedButton.addEventListener("click", () => {
  for (const task of [...tasks.values()]) {
    if (["done", "error", "cancelled", "interrupted"].includes(task.status)) removeTask(task.id);
  }
});

api.storage.local.get({ taskConcurrency: 5, hlsFormat: "mp4" }).then(settings => {
  concurrency = Number(settings.taskConcurrency) || 5;
  hlsFormat = settings.hlsFormat === "ts" ? "ts" : "mp4";
  concurrencySelect.value = String(concurrency);
  hlsFormatSelect.value = hlsFormat;
}).catch(() => {});

// ---- 启动 --------------------------------------------------------------------
syncTasks(true);