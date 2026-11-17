// ============================================================================
// lib/ffmpeg-host.js — ffmpeg 执行宿主适配（共享库，仅后台调用）
// ----------------------------------------------------------------------------
// 能力分流：
//   Firefox 后台是事件页（有 DOM），可直接 new Worker → 用 ffmpeg-client 本机执行。
//   Chrome 后台是 service worker（无 DOM、不能 new Worker）→ 改用 offscreen document
//     承载 ffmpeg Worker。SW 与 offscreen 之间用 BroadcastChannel 通信，结构化克隆
//     可直接转移 ArrayBuffer（无需 base64/分片，不受 runtime 消息大小限制）。
//
// 对外仅暴露 runFfmpeg(api, op, fields)：返回合并/转封装后的 ArrayBuffer。
//   op="merge": fields { videoBytes, audioBytes, outputName, videoExt, audioExt }
//   op="remux": fields { inputBytes, inputName, outputName, extraArgs }
// ============================================================================

import { remuxWithFFmpeg, mergeWithFFmpeg } from "./ffmpeg-client.js";

const HAS_WORKER = typeof Worker !== "undefined";
const CHANNEL = "purrvid-ffmpeg";
const OFFSCREEN_URL = "offscreen/ffmpeg.html";

// ---- Chrome offscreen 宿主 ---------------------------------------------------
let channel = null;
let offscreenReady = null;
const pending = new Map();
let seq = 0;

function getChannel() {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = ({ data }) => {
      const task = pending.get(data?.id);
      if (!task) return;
      pending.delete(data.id);
      if (data.ok) task.resolve(data.buffer);
      else task.reject(new Error(data.error || "offscreen ffmpeg 失败"));
    };
  }
  return channel;
}

async function ensureOffscreen(api) {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const url = api.runtime.getURL(OFFSCREEN_URL);
    try {
      const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
      if (contexts && contexts.length) return;
    } catch {}
    try {
      await api.offscreen.createDocument({
        url,
        reasons: ["WORKERS"],
        justification: "ffmpeg.wasm 合并/转封装需要 Worker，service worker 无法创建"
      });
    } catch (error) {
      // 已存在时忽略;其它错误抛出。
      if (!/single offscreen|already/i.test(String(error?.message || error))) throw error;
    }
  })();
  return offscreenReady;
}

async function offscreenFfmpeg(api, op, fields) {
  await ensureOffscreen(api);
  const id = ++seq;
  const payload = {
    id, op,
    inputName: fields.inputName,
    outputName: fields.outputName,
    videoExt: fields.videoExt,
    audioExt: fields.audioExt,
    extraArgs: fields.extraArgs
  };
  const transfer = [];
  for (const key of ["videoBytes", "audioBytes", "inputBytes"]) {
    const value = fields[key];
    if (!value) continue;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    payload[key] = bytes.buffer;
    transfer.push(bytes.buffer);
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getChannel().postMessage(payload, transfer);
  });
}

// ---- 统一入口 ----------------------------------------------------------------
export async function runFfmpeg(api, op, fields) {
  if (HAS_WORKER) {
    return op === "merge"
      ? mergeWithFFmpeg(fields.videoBytes, fields.audioBytes, fields.outputName, fields.videoExt, fields.audioExt)
      : remuxWithFFmpeg(fields.inputBytes, fields.inputName, fields.outputName, fields.extraArgs);
  }
  return offscreenFfmpeg(api, op, fields);
}