// ============================================================================
// content/engine-bootstrap.js — 引擎加载兜底（MAIN world · document_start · 所有站点）
// ----------------------------------------------------------------------------
// 为什么需要它：
//   严格 CSP 站点（如 YouTube 的 require-trusted-types-for 'script'）会拦截
//   loader.js 通过 DOM <script> 注入引擎的方式。manifest 声明的 MAIN world
//   内容脚本豁免页面 CSP，因此这里用绝对扩展 URL 动态 import 引擎，以扩展
//   主体加载。模块缓存会与 loader 的 DOM 注入去重，引擎只会执行一次。
//
// 契约：读取 loader.js 写入的 dataset.purrvidBase；引擎文件名须与 manifest 一致。
// ============================================================================
(() => {
  const ENGINE_FILE = "bilibili-engine.js";
  const MAX_TRIES = 150;     // 最多等待 150 × 20ms = 3s，等 loader 公布 base URL
  const RETRY_DELAY = 20;

  let tries = 0;
  const load = () => {
    const base = document.documentElement.dataset.purrvidBase;
    if (!base) {
      if (tries++ < MAX_TRIES) setTimeout(load, RETRY_DELAY);
      return;
    }
    import(base + ENGINE_FILE).catch(error => {
      console.error("[星喵助手] 引擎加载失败：", error);
    });
  };
  load();
})();