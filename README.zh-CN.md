<div align="center">

<img src="icon.png" alt="PurrVid 图标" width="96" height="96">

# PurrVid · 星喵助手

**一只帮你保存网页视频的星空猫娘。**

一个轻量、零依赖的 Manifest V3 扩展，自带页内下载面板。

[English](README.md) · 简体中文 · [更新日志](CHANGELOG.md)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)
![ffmpeg.wasm](https://img.shields.io/badge/ffmpeg-wasm-007808?logo=ffmpeg&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.3-blue)
![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

</div>

---

## 简介

星喵助手是一只住在视频页角落的星空猫娘。她会在页面右下角添加一个常驻悬浮按钮，点击即可展开页内面板，自动解析当前视频，让你直接选择清晰度并下载——无需新开标签页，也不用手动复制链接。她能嗅探任何站点的标准 **HLS / DASH / 直连** 媒体，并对 **B 站** 与 **YouTube** 做了专门适配。

整个项目都是原生 ES 模块（无打包器、无框架），仓库根目录的一套共享代码同时适配 Firefox 与 Chrome。

## 功能特性

- **页内面板** —— 常驻悬浮按钮，展开 / 收起带平滑动画，全程不离开当前页面。
- **通用站点** —— 自动嗅探媒体请求，把 HLS / DASH / 直连资源汇总到同一个面板。
- **B 站** —— 投稿视频与番剧、多 P 分集，清晰度跟随播放器；三种下载方式：合并、分开、交给浏览器。
- **YouTube** —— HLS 流，支持清晰度 / 音轨选择。
- **后台下载** —— 独立的任务管理页，支持并发控制，覆盖 HLS / DASH / YouTube / 直连四类资源。
- **浏览器内合并** —— 音视频通过 `ffmpeg.wasm` 在本地合并，不经过任何服务器。
- **跨浏览器** —— 同一份源码适配 Firefox（事件页）与 Chrome（service worker + offscreen 文档）。

## 安装

> 需要 **Firefox 140+** 或 **Chrome 116+**。

### Firefox

**方法 1：从 AMO 安装（推荐）**

访问 [PurrVid · 星喵助手 – Firefox 附加组件](https://addons.mozilla.org/zh-CN/firefox/addon/purrvid/)，点击 **添加到 Firefox**。

**方法 2：从 GitHub Release 安装**

前往 [Release 页面](https://github.com/snowtafir/PurrVid/releases)，下载 Firefox 版本（`.xpi`），在 Firefox 中打开即可安装。

### Chrome

前往 [Release 页面](https://github.com/snowtafir/PurrVid/releases)，下载 Chrome 版本（`.zip`）并解压，然后：

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择解压出的 `PurrVid-chrome-v{version}/` 目录。

### 从源码加载（开发者）

- **Firefox**：打开 `about:debugging#/runtime/this-firefox` → **临时载入附加组件…** → 选择根目录的 `manifest.json`。仓库根目录即主代码，无需构建。
- **Chrome**：先运行 `node build.mjs` 生成 `dist/PurrVid-chrome-v{version}/`（见 [开发](#开发)），再按上面的方式加载已解压扩展。

## 使用说明

1. **先播放视频**，扩展才能解析出可用的流。
2. 点击页面右下角的 **悬浮按钮** 展开面板。
3. 选择清晰度 / 音轨并下载。

> 可在扩展弹窗中关闭 **悬浮按钮常驻**，页面便不再显示悬浮按钮；此时点击弹窗里的 **调出面板** 即可在当前页打开面板。

### B 站下载方式

| 方式 | 说明 |
| --- | --- |
| **合并下载** | 通过 `ffmpeg.wasm` 在本地把音视频合并为单个 MP4。 |
| **分开下载** | 音频、视频分别保存为独立文件。 |
| **浏览器下载** | 交给浏览器自带下载器，占用内存最低。 |

> 清晰度始终跟随 B 站播放器，切换清晰度或分集后面板会自动刷新。合并 / 分开下载进行中，请勿刷新或关闭页面。

### YouTube 与通用站点

同一个面板会列出嗅探到的 HLS / DASH / 直连资源。YouTube 走 HLS，可选择清晰度与（如有）音轨。较大的 HLS / DASH 任务可放到后台执行，由 **任务管理页** 统一管理——发起后台下载时该页会自动打开。

### 弹窗

工具栏弹窗刻意保持精简：**自动嗅探** 开关、**悬浮按钮常驻** 开关（关闭后会出现 **调出面板** 按钮，用于在当前页调出面板），以及本仓库的链接。

## 项目结构

<details>
<summary>点击展开</summary>

```text
PurrVid/
├─ manifest.json                 # Firefox 清单（主代码）
├─ bilibili-engine.js            # B 站解析 / 下载引擎（页面 MAIN world）
├─ universal-panel.js            # YouTube / 通用站点的页内面板
├─ popup.html / popup.js         # 精简的工具栏弹窗
├─ background/                   # Service worker（Chrome）/ 事件页（Firefox）
├─ content/                      # 加载器、媒体嗅探、中继、页面桥接
├─ lib/                          # ffmpeg 客户端/宿主、HLS/DASH、传输、工具
├─ tasks/                        # 下载任务管理页
├─ offscreen/                    # Chrome ffmpeg 宿主（offscreen 文档）
├─ vendor/ffmpeg/                # ffmpeg.wasm 运行时
├─ icon.png / icon-48 / icon-16  # 扩展图标（由 catgirl.png 生成）
├─ build.mjs                     # 同时生成 Firefox 与 Chrome 构建
├─ update.json                   # Firefox 自托管更新清单
└─ dist/                         # 生成的构建产物 —— 请勿手工修改
   ├─ PurrVid-firefox-v{version}/
   └─ PurrVid-chrome-v{version}/
```

</details>

## 工作原理

<details>
<summary>点击展开</summary>

- **共享核心 + 浏览器适配。** 所有逻辑都在仓库根目录。`build.mjs` 把它们复制到 `dist/` 并派生 Chrome 清单（`background.scripts` → `service_worker`，加入 `offscreen` 权限，去掉 Firefox 专属项）。
- **B 站引擎** 运行在页面 MAIN world。由于页面 CSP 禁止用扩展 URL 建 Worker，`ffmpeg.wasm` 通过 **blob: URL** 加载。
- **Chrome service worker 无法创建 Worker**，因此 ffmpeg 跑在 **offscreen 文档** 中，结果经 `BroadcastChannel` 回传给 worker；内容脚本中继与 worker 之间用 base64 分块 `Port` 通信。Firefox 则直接用结构化克隆消息。
- **HLS / DASH** 的解析与分片下载是共享库（`lib/m3u8.js`、`lib/mpd.js`、`lib/hls.js`）；后台凭借 host 权限处理跨域分片。

</details>

## 开发

```bash
# 修改共享核心后，刷新 Firefox 与 Chrome 两个构建
node build.mjs
```

- 只在仓库根目录改代码；`dist/` 每次构建都会重新生成，且已被 git 忽略。
- 产物目录命名为 `PurrVid-firefox-v{version}` 与 `PurrVid-chrome-v{version}`，版本号取自 `manifest.json`；构建同时刷新根目录的 `update.json`。
- 需要 Node.js（ESM）。无打包器、无框架，纯原生 ES 模块。
- 改完代码后，在浏览器中重新加载扩展即可测试。

## 限制与免责声明

> - 仅下载 **你有权保存** 的内容。
> - **不支持** 受 **DRM 保护** 的流（Widevine / PlayReady / FairPlay / SAMPLE-AES）与 **直播流**。
> - 本工具仅供个人与学习使用，请遵守版权法及各站点的服务条款。

## 开源协议

版权所有 © 2026 [snowtafir](https://github.com/snowtafir)。

本项目采用 **GNU 通用公共许可证 v3.0（GPL-3.0）** 授权，完整文本见 [LICENSE](LICENSE)。

你可以自由使用、修改与再分发本软件（包括商用），但任何分发的衍生作品或组合作品也必须以 GPL-3.0 开源，并提供对应源码。

> 内置的 `ffmpeg.wasm` 运行时（`vendor/ffmpeg/`）是 FFmpeg 的 **GPL 构建**（启用 `--enable-gpl`、libx264 / libx265），这也是整个项目采用 GPL-3.0 的原因。FFmpeg 是 Fabrice Bellard 的商标;本项目与 FFmpeg 官方无隶属或背书关系。第三方组件协议与对应源码详见 [NOTICE](NOTICE)。

---

<div align="center">

[GitHub 仓库](https://github.com/snowtafir/PurrVid) · [English](README.md)

</div>