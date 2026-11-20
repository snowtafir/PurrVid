# 更新日志

本文件记录「PurrVid · 星喵助手」的所有重要改动。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.5 - 2026-11-20

### 变更

- **解析日志默认收起**：日志标题栏新增「展开 / 收起」按钮（B 站 / YouTube / 通用三面板共用同一日志控制台），默认收起只留标题栏，日志内容保留、随时可展开；收起态下「清空」仍可用。
- README（中英）版本徽章与功能描述同步至当前实际行为（后台跨域下载、面板内进度与取消）。

## 1.0.4 - 2026-11-20

> 仅上架 AMO；GitHub Release 跳过该标签，自托管渠道直接发布 1.0.5（含本版本全部改动）。

### 新增

- **通用面板跨域下载能力**：跨域直连媒体与 HLS（含主清单探测）改经后台扩展上下文下载，host_permissions 豁免页面 CORS / CSP——原本因缺 CORS 头或严格 `connect-src` 下不了的跨域资源现在可下。同源资源与 DASH 仍全程页内，行为与旧版一致；B 站 / YouTube 路径不变。
- **任务级 DNR Referer/Origin 补全**（`lib/request-headers.js`）：后台下载按任务注册临时会话规则，补真实页面 Referer（完整 URL）与 Origin；`initiatorDomains` 限定扩展自身域，只命中扩展后台请求，播放器自身请求不受影响；任务结束即移除，浏览器重启自动清空。
- **失败回退页内**：后台直连 / HLS 下载 / 清单探测遇网络或鉴权失败时自动回退现有页内路径，保证旧版能下的资源不回归；DRM / 直播为明确拒绝，不做无谓重试。
- **下载中原地取消**：点击下载后按钮原地切换为「取消下载」（复用同一元素），再点一次即取消——页内下载经 AbortController 立即中断，后台下载经 `cancel-download` 消息中断并即时释放按钮，迟到的后台结果直接丢弃；取消为终态，不触发回退重试。通用直连 / HLS / DASH、YouTube 与 B 站合并/分开下载均支持（B 站 CDN 下载中断后不重试备用链接，ffmpeg 合并阶段取消即时生效）。
- **HLS 清晰度预估大小**：清晰度选项显示「约 ××MB」（带宽 × 时长估算）；时长优先取资源自身（YouTube `lengthSeconds`），否则探测首个变体媒体清单累计时长。
- **字节级下载进度**：HLS 分片下载进度由「已完成段数」细化为实时字节数（如 `视频分段 1/120 · 3.20MB / 约 45.00MB`），页内与后台路径一致，200ms 节流刷新。

### 修复

- **取消无法中断进行中的分片下载**：`fetchWithRetry` 返回响应头后即解除外部取消信号绑定，body 流式读取阶段 abort 失效；`downloadBuffer` 现在在 body 阶段自行监听取消信号并中断读取、关闭流。
- **后台下载超时后任务仍在跑**：面板桥接 30 分钟超时原先只本地放弃，后台继续下载且面板回退页内造成重复下载；超时现在同步发送 `cancel-download` 中断后台任务。
- **YouTube 大文件分块下载进度回跳**：并发 Range 分块各自从 0 计字节并互相覆盖进度文本；改为汇总已完成块 + 在途块实时字节（200ms 节流），与 HLS 进度一致。

### 变更

- 后台新增 `direct-download` / `hls-probe` 消息与 `direct-progress` 进度；通用 HLS 复用 `hls-download`（附带 `pageUrl` 触发 DNR 防护与直播拒绝）。relay 同步转发新契约。
- 后台 HLS 下载对通用资源补直播（无 ENDLIST）拒绝，与页内判据一致。
- 构建产物随包附带 `LICENSE`（GPL-3.0 全文）与 `NOTICE`（第三方声明），满足 GPL 分发副本须附许可证的要求。
- **默认不再主动弹出下载面板**：嗅探到资源时只显示右下角悬浮按钮，不再自动展开面板打扰用户（B 站 / YouTube / 通用站点一致）。是否展开仍记住用户上次的手动选择（`localStorage.purrvid_show`），popup「调出面板」与悬浮按钮点击照常展开。
- **B 站面板改用 DOM API 构建**：标题、下载卡片、设置区不再拼接 `innerHTML`，全部 `createElement` / `textContent`，天然防 XSS 并兼容 Trusted Types CSP；加载动画由内联 SVG 改为 CSS spinner。
- **面板样式改用 constructable stylesheet**：B 站与通用面板的 Shadow DOM 样式优先经 `adoptedStyleSheets` 注入（不受页面 `style-src 'unsafe-inline'` 限制），不支持时回退 `<style>`。
- **B 站合并下载的 ffmpeg 迁至后台**：音视频合并改经 relay 委托后台扩展上下文执行（与 YouTube 同一通道），页面不再以 blob URL 建 ffmpeg Worker，规避页面 `worker-src` 收紧；playurl 解析与 CDN 字节下载仍留页内（保留正确的 bilibili Referer 与 Cookie 附带）。

## 1.0.3 - 2026-11-18

### 变更

- 优化Chrome/Edge版本构建的最小权限
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