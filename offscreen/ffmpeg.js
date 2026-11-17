// ============================================================================
// offscreen/ffmpeg.js — Chrome offscreen ffmpeg 宿主
// ----------------------------------------------------------------------------
// offscreen 文档有 DOM，可创建 Worker，故直接复用 lib/ffmpeg-client.js。
// 通过 BroadcastChannel 与后台 SW 交换 ArrayBuffer（结构化克隆转移，零拷贝）。
// 串行处理（ffmpeg 单例），避免并发 exec 冲突。offscreen 仅支持 runtime API，
// 不能调用 downloads，故只回传结果字节，由后台触发浏览器保存。
// ============================================================================

import { remuxWithFFmpeg, mergeWithFFmpeg } from "../lib/ffmpeg-client.js";

const channel = new BroadcastChannel("purrvid-ffmpeg");
let queue = Promise.resolve();

channel.onmessage = ({ data }) => {
  const { id, op, ...fields } = data || {};
  if (!id) return;
  queue = queue.then(async () => {
    try {
      const buffer = op === "merge"
        ? await mergeWithFFmpeg(fields.videoBytes, fields.audioBytes, fields.outputName, fields.videoExt, fields.audioExt)
        : await remuxWithFFmpeg(fields.inputBytes, fields.inputName, fields.outputName, fields.extraArgs);
      channel.postMessage({ id, ok: true, buffer }, [buffer]);
    } catch (error) {
      channel.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
  });
};