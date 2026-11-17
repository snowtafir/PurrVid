// ============================================================================
// lib/ffmpeg-client.js — ffmpeg.wasm 客户端（共享库）
// ----------------------------------------------------------------------------
// FFmpegClient 封装 vendor/ffmpeg 的 Worker（LOAD/EXEC/读写文件）。两种加载模式：
//   blob=false（默认）：直接用扩展 URL 建 Worker。适用于后台事件页 / service worker
//     的 offscreen / 任务页等「扩展上下文」（豁免页面 CSP）。
//   blob=true：先把 vendor 文件 fetch 成 blob: URL 再建 Worker。适用于页面 MAIN world
//     （B站引擎）——页面 CSP 禁止用扩展 URL 建 Worker，必须转 blob。
// remuxWithFFmpeg：转封装;mergeWithFFmpeg：合并音视频。二者可传入 client（默认用
//   扩展模式单例 getFFmpeg()）;页面侧传入已 load({blob:true}) 的 client 即可复用。
// Worker 路径基于 import.meta.url 相对 vendor/ 解析。
// ============================================================================

const VENDOR_BASE = new URL("../vendor/ffmpeg/", import.meta.url);

// 把扩展资源 fetch 成 blob: URL（页面 MAIN world 建 Worker 用）。
async function fetchAsBlobURL(url, mime) {
  const response = await fetch(url);
  const blob = await response.blob();
  return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mime }));
}

export class FFmpegClient {
  #worker = null;
  #pending = new Map();
  #seq = 0;
  #logHandlers = [];
  #blobUrls = [];
  #logs = [];
  loaded = false;

  async load({ blob = false } = {}) {
    if (this.loaded) return this;
    if (!this.#worker) {
      const resolve = async (file, mime) => {
        const url = new URL(file, VENDOR_BASE).href;
        if (!blob) return url;
        const blobUrl = await fetchAsBlobURL(url, mime);
        this.#blobUrls.push(blobUrl);
        return blobUrl;
      };
      const workerURL = await resolve("ffmpeg.worker.js", "text/javascript");
      const coreURL = await resolve("ffmpeg-core.js", "text/javascript");
      const wasmURL = await resolve("ffmpeg-core.wasm", "application/wasm");
      const coreWorkerURL = await resolve("ffmpeg-core.worker.js", "text/javascript");

      this.#worker = new Worker(workerURL, { type: "module" });
      this.#worker.onmessage = ({ data: { id, type, data } }) => {
        if (type === "LOG") {
          const line = typeof data === "string" ? data : (data?.message ?? String(data));
          this.#logs.push(line);
          if (this.#logs.length > 60) this.#logs.shift();
          for (const handler of this.#logHandlers) handler(data);
          return;
        }
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        if (type === "ERROR") pending.reject(new Error(String(data)));
        else pending.resolve(data);
      };
      this.#worker.onerror = error => {
        for (const pending of this.#pending.values()) pending.reject(new Error(error.message || "ffmpeg worker 异常"));
        this.#pending.clear();
      };
      await this.#send("LOAD", { coreURL, wasmURL, workerURL: coreWorkerURL });
    }
    this.loaded = true;
    return this;
  }

  #send(type, data, transfer = []) {
    if (!this.#worker) return Promise.reject(new Error("ffmpeg 未加载"));
    const id = this.#seq++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, type, data }, transfer);
    });
  }

  onLog(handler) {
    this.#logHandlers.push(handler);
  }

  exec(args, timeout = -1) {
    this.#logs = [];
    return this.#send("EXEC", { args, timeout });
  }

  recentLogs(count = 15) {
    return this.#logs.slice(-count).join("\n");
  }

  async writeFile(path, data) {
    // 页面侧 fetchWithProgress 返回 Blob;new Uint8Array(Blob) 会静默得到空数组，须先读 arrayBuffer。
    const bytes = data instanceof Uint8Array ? data
      : data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
      : new Uint8Array(data);
    return this.#send("WRITE_FILE", { path, data: bytes }, [bytes.buffer]);
  }

  readFile(path) {
    return this.#send("READ_FILE", { path, encoding: "binary" });
  }

  deleteFile(path) {
    return this.#send("DELETE_FILE", { path });
  }

  terminate() {
    for (const pending of this.#pending.values()) pending.reject(new Error("ffmpeg 已终止"));
    this.#pending.clear();
    this.#worker?.terminate();
    this.#worker = null;
    this.loaded = false;
    for (const url of this.#blobUrls) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    this.#blobUrls = [];
  }
}

// 扩展上下文（后台/任务页/offscreen）共用的单例。
let sharedClient = null;
export function getFFmpeg() {
  if (!sharedClient) sharedClient = new FFmpegClient();
  return sharedClient;
}

export async function remuxWithFFmpeg(inputBytes, inputName, outputName, extraArgs = [], client = getFFmpeg()) {
  await client.load();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = `${stamp}_${inputName}`;
  const outputPath = `${stamp}_${outputName}`;
  try {
    await client.writeFile(inputPath, inputBytes);
    const code = await client.exec(["-i", inputPath, "-c", "copy", ...extraArgs, outputPath]);
    if (code !== 0) throw new Error(`ffmpeg 转封装失败（退出码 ${code}）\n${client.recentLogs()}`);
    const output = await client.readFile(outputPath);
    return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  } finally {
    client.deleteFile(inputPath).catch(() => {});
    client.deleteFile(outputPath).catch(() => {});
  }
}

export async function mergeWithFFmpeg(videoBytes, audioBytes, outputName, videoExt = "mp4", audioExt = "m4a", client = getFFmpeg()) {
  await client.load();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const videoPath = `${stamp}_video.${videoExt}`;
  const audioPath = `${stamp}_audio.${audioExt}`;
  const outputPath = `${stamp}_${outputName}`;
  try {
    await client.writeFile(videoPath, videoBytes);
    await client.writeFile(audioPath, audioBytes);
    // 不加 +faststart：B站 DASH 是分片 MP4，-c copy 输出仍分片，faststart 重写 moov 会失败（退出码 1）。
    const code = await client.exec(["-i", videoPath, "-i", audioPath, "-c", "copy", outputPath]);
    if (code !== 0) throw new Error(`ffmpeg 合并失败（退出码 ${code}）\n${client.recentLogs()}`);
    const output = await client.readFile(outputPath);
    return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  } finally {
    client.deleteFile(videoPath).catch(() => {});
    client.deleteFile(audioPath).catch(() => {});
    client.deleteFile(outputPath).catch(() => {});
  }
}