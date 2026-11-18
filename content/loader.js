// ============================================================================
// content/loader.js — 引擎注入器（ISOLATED world · document_start · 所有站点）
// ----------------------------------------------------------------------------
// 职责：
//   1. 向页面公布扩展根 URL（dataset.purrvidBase），供 MAIN world 的
//      engine-bootstrap.js 拼出绝对 import 地址（MAIN world 没有 runtime.getURL）。
//   2. 仅 B站：以 <script type="module"> 注入 B站引擎，使其 import.meta.url 与
//      相对导入都落在扩展域内；修正 /s/video/ 短链；全屏时压低面板 z-index。
//
// 为什么非 B站不在这里注入：document_start 的模块加载会先于页面自身的
//   import map 解析（如 GitHub），按规范使 import map 失效、页面模块崩溃。
//   非 B站的面板改由 engine-bootstrap.js 在嗅探到媒体或用户调出时按需注入。
//
// 契约（跨文件，勿改）：
//   - dataset.purrvidBase  ← engine-bootstrap.js 读取
//   - #purrvid-host   ← 引擎 / universal-panel.js 创建的面板宿主 id
//   - 引擎文件名 ENGINE_FILE  ← 与 manifest.web_accessible_resources 一致
// ============================================================================
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const ENGINE_FILE = "bilibili-engine.js";
  const PANEL_HOST_ID = "purrvid-host";

  // 公布扩展根 URL，供 MAIN world bootstrap 使用（所有站点都需要）。
  document.documentElement.dataset.purrvidBase = api.runtime.getURL("");

  const isBilibili = /(^|\.)bilibili\.com$/.test(location.hostname);
  if (!isBilibili) return;

  // B站短链 /s/video/av... 重定向到标准观看页。
  if (location.href.includes("bilibili.com/s/video/")) {
    location.replace(location.href.replace("/s/", "/"));
    return;
  }

  const injectionPoint = document.head || document.documentElement;

  // B站全屏播放时，让面板宿主让位给播放器控件。
  const fullscreenStyle = document.createElement("style");
  fullscreenStyle.textContent =
    `[class*="fullscreen"] #${PANEL_HOST_ID},[class*="webscreen-fix"] #${PANEL_HOST_ID} {z-index: 9!important;}`;
  injectionPoint.appendChild(fullscreenStyle);

  // 以模块脚本注入引擎（绝对扩展 URL，保证相对导入正确解析）。
  const script = document.createElement("script");
  script.type = "module";
  script.src = api.runtime.getURL(ENGINE_FILE);
  injectionPoint.appendChild(script);
})();