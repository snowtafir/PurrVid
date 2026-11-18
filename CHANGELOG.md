# 更新日志

本文件记录「PurrVid · 星喵助手」的所有重要改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.3 - 2026-11-18

### 变更

- 发布流程调整（功能与 1.0.2 相同）：构建按 AMO 双渠道分包——公开（listed）版清单移除 `gecko.update_url` 以通过上传校验；自托管（unlisted）版版本号追加第四段 `.1` 并保留 `update_url`，`node build.mjs --unlisted` 一键生成，update.json 同步指向 GitHub 带 `-R` 尾缀的 Release。

## 1.0.2 - 2026-11-18

### 修复

- **扩展破坏部分站点页面（如 GitHub）的问题**：引擎模块原先在所有站点 `document_start` 注入，模块加载先于页面自身 import map 解析，按规范使 import map 失效、页面模块（Releases 标签等 React 组件）加载失败。现通用站点 `document_start` 零模块加载，面板改为嗅探到媒体或用户调出时按需注入。
- **悬浮按钮在所有网站显示的问题**：面板与悬浮按钮现在只出现在 B 站、YouTube、嗅探到媒体资源的页面，以及从 popup 主动调出面板的页面。
- 无媒体站点内容脚本与后台的多余消息往返（onMessage 异步响应报错的来源之一）：relay 不再在非视频站点加载时主动拉取资源。

### 变更

- 注入时机分层：B 站立即、YouTube 立即、其它站点按需；新增 `panel-activate` / `inject-panel` 消息契约（后台记录到媒体 → relay → MAIN world bootstrap 注入面板）。

## 1.0.1 - 2026-11-18

### 新增

- **统一结构化解析日志**：抽取共享 `lib/log-console.js`，B 站 / 通用 / YouTube 面板共用同款日志控制台；日志含清晰度 / 音轨 / 时长等信息块与可一键复制的清单链接。

### 修复

- B 站与通用面板长标题被截断的问题，标题完整换行显示。
- B 站下载按钮右侧超出面板边界的问题（统一 `border-box`）。
- 标题与「下载方式」设置区、下载按钮区间距不一致的问题。
- 合并下载提示文本错位、合并按钮排列别扭的问题，状态与保存链接跟随按钮行内显示。
- B 站 DASH 音视频大小一直显示「未知大小」：先按码率 × 时长估算（标注「约」），再以 HEAD 请求实测 `Content-Length` 覆盖。

### 变更

- 自托管更新清单 `gecko.update_url` 改用 jsDelivr 加速链接（`cdn.jsdelivr.net/gh/snowtafir/PurrVid@main/update.json`）。
- README 的 Firefox 安装链接更新为 AMO 上架页 `addons.mozilla.org/zh-CN/firefox/addon/purrvid/`。
- 图标以透明底新版 `catgirl.png` 重新生成 16 / 48 / 128 三个尺寸。

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