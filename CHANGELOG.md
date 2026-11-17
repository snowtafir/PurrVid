# 更新日志

本文件记录「PurrVid · 星喵助手」的所有重要改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0 - 2026-11-16

首个以 **PurrVid · 星喵助手** 品牌发布的版本（一只帮你保存网页视频的星空猫娘）。

### 新增

- **页内面板 + 悬浮按钮**：下载面板整合到视频页右下角悬浮按钮，点击展开；popup 提供「自动嗅探」开关。
- **悬浮按钮常驻开关**：popup 新增「悬浮按钮常驻」开关（默认开启）。关闭后页面不再显示悬浮按钮，并出现「调出面板」按钮，可在当前标签页直接展开下载面板。
- **通用站点嗅探**：自动嗅探 HLS / DASH / 直连媒体资源并在面板列出。
- **B 站下载**：支持投稿视频与番剧、多 P 分集，提供合并下载（`ffmpeg.wasm` 本地合并音视频）、分开下载、浏览器下载三种方式；清晰度跟随播放器，切换清晰度或分集自动刷新。
- **YouTube 下载**：走 HLS，可选择清晰度与（如有）独立音轨。
- **后台下载任务页**：独立任务管理，支持并发控制与断点恢复，覆盖 HLS / DASH / YouTube / 直连四类资源。
- **跨浏览器共享核心**：仓库根目录同一份源码适配 Firefox（事件页）与 Chrome（service worker + offscreen 文档）；`build.mjs` 同时生成 `dist/PurrVid-firefox-v{version}` 与 `dist/PurrVid-chrome-v{version}`。
- **自托管更新**：根目录 `update.json` 指向仓库最新 Release，Firefox 清单配置 `gecko.update_url`。
- **猫娘图标**：以 `catgirl.png` 生成 16 / 48 / 128 多尺寸图标。
- Firefox 清单声明 `data_collection_permissions`（`required: ["none"]`），不向扩展/本地浏览器之外传输任何数据。
- 采用 **GPL-3.0** 开源协议（`LICENSE` 与第三方声明 `NOTICE`），与内置 GPL 构建的 ffmpeg.wasm（FFmpeg n6.0）保持一致。

### 安全

- 面板标题、下载链接与解析日志改用 HTML 转义 / `textContent` 渲染，降低 `innerHTML` 注入风险。
- 悬浮按钮常驻开关切换后即时生效，无需刷新视频页（后台用 `tabs.sendMessage` 下发到所有已打开标签页）。

### 约束

- 仅下载你有权保存的内容；不支持 DRM（Widevine / PlayReady / FairPlay / SAMPLE-AES）与直播流。
- 所有解析与合并均在本地完成，不经过任何服务器。
- Firefox 最低版本 **140**（桌面）/ **142**（Android）；Chrome 最低版本 **116**。