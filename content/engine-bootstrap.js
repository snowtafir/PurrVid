// ============================================================================
// content/engine-bootstrap.js — 引擎加载器（MAIN world · document_start · 所有站点）
// ----------------------------------------------------------------------------
// 为什么需要它：
//   严格 CSP 站点（如 YouTube 的 require-trusted-types-for 'script'）会拦截
//   loader.js 通过 DOM <script> 注入引擎的方式。manifest 声明的 MAIN world
//   内容脚本豁免页面 CSP，因此这里用绝对扩展 URL 动态 import，以扩展主体加载。
//
// 注入时机（重要，勿改回全站点立即注入）：
//   - B站：立即兜底 import bilibili-engine.js（与 loader 的 DOM 注入靠模块缓存去重）。
//   - YouTube：立即 import universal-panel.js（bridge 的解析结果需要面板接收）。
//   - 其它站点：document_start 不做任何模块加载——过早的模块加载会使页面自身的
//     import map 失效（GitHub 等站点的 React 模块因此崩溃）。改为监听 relay 的
//     按需激活消息：嗅探到媒体（panel-activate → inject-panel）或 popup 调出
//     （open-panel）时才 import universal-panel.js。
//
// 契约：
//   - 读取 loader.js 写入的 dataset.purrvidBase；文件名须与 manifest 一致。
//   - window.postMessage：{ source:"purrvid-panel", from:"relay",
//     type:"inject-panel" | "open-panel" }（panel-relay.js 发出）。
// ============================================================================
(() => {
  const RELAY_SOURCE = "purrvid-panel";
  const MAX_TRIES = 150;     // 最多等待 150 × 20ms = 3s，等 loader 公布 base URL
  const RETRY_DELAY = 20;

  const hostname = location.hostname;
  const isBilibili = /(^|\.)bilibili\.com$/.test(hostname);
  const isYoutube = hostname === "youtube.com" || hostname.endsWith(".youtube.com")
    || hostname === "youtu.be" || hostname.endsWith(".youtube-nocookie.com");

  // 等 loader 公布 base URL 后执行加载（ISOLATED 与 MAIN 的执行顺序不保证）。
  function withBase(run) {
    let tries = 0;
    const tick = () => {
      const base = document.documentElement.dataset.purrvidBase;
      if (!base) {
        if (tries++ < MAX_TRIES) setTimeout(tick, RETRY_DELAY);
        return;
      }
      run(base);
    };
    tick();
  }

  const fail = error => console.error("[星喵助手] 引擎加载失败：", error);

  if (isBilibili) {
    withBase(base => import(base + "bilibili-engine.js").catch(fail));
    return;
  }
  if (isYoutube) {
    withBase(base => import(base + "universal-panel.js")
      .then(module => module.initUniversalPanel())
      .catch(fail));
    return;
  }

  // ---- 其它站点：按需激活 ----------------------------------------------------
  let panelPromise = null;
  let panelLoaded = false;

  function ensurePanel() {
    if (!panelPromise) {
      panelPromise = new Promise(resolve => {
        withBase(base => import(base + "universal-panel.js")
          .then(module => {
            module.initUniversalPanel();
            panelLoaded = true;
            resolve();
          })
          .catch(error => {
            fail(error);
            resolve();
          }));
      });
    }
    return panelPromise;
  }

  // 面板初始化可能等到 DOMContentLoaded；open 消息须在其监听注册后再投。
  function openWhenReady() {
    const post = () => window.postMessage({ source: RELAY_SOURCE, from: "relay", type: "open-panel" }, "*");
    if (document.body) post();
    else document.addEventListener("DOMContentLoaded", post, { once: true });
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || data.source !== RELAY_SOURCE || data.from !== "relay") return;
    if (data.type === "inject-panel") {
      ensurePanel();
    } else if (data.type === "open-panel" && !panelLoaded) {
      // 面板尚未注入：先注入，就绪后补投 open（已注入时由面板自己处理）。
      ensurePanel().then(openWhenReady);
    }
  });
})();