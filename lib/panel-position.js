// 悬浮按钮 / 面板的共享定位逻辑（B 站与通用面板宿主都是「48×48 按钮 ↔ 面板」
// 同一个元素变形，位置走内联 left/top）：
//   - 锚点 = 收起态悬浮按钮的左上角，存 localStorage.purrvid_pos，加载/拖拽时夹取在视口内；
//   - 展开方向按锚点所在象限反向：锚点在左半→面板向右展开，上半→向下展开，
//     再整体夹取回视口，避免按钮靠边/靠顶时面板被遮挡或出界；
//   - 展开动画的 transform-origin 随方向取面板靠近按钮的那个角；
//   - attachDrag 提供指针拖拽（移动超过阈值才算拖拽，不吞点击）。

const KEY = "purrvid_pos";
export const FAB_SIZE = 48;
export const FAB_MARGIN = 12;
export const PANEL_MARGIN = 8;
const DRAG_THRESHOLD = 5;
// 悬浮按钮 hover 提示条展开后的近似宽度：左侧余量不足时改向右展开，避免出界。
const FAB_TOOLTIP_WIDTH = 150;

export function clampAnchor(x, y) {
  const maxX = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN);
  const maxY = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN);
  return { x: Math.min(Math.max(x, FAB_MARGIN), maxX), y: Math.min(Math.max(y, FAB_MARGIN), maxY) };
}

// 默认右下角（与旧版 right/bottom 固定位一致）。
export function loadAnchor() {
  const fallback = { x: window.innerWidth - FAB_SIZE - FAB_MARGIN, y: window.innerHeight - FAB_SIZE - FAB_MARGIN };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampAnchor(saved.x, saved.y);
  } catch { /* 存储不可用时回退默认位 */ }
  return fallback;
}

export function saveAnchor(point) {
  try { localStorage.setItem(KEY, JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) })); } catch { /* 忽略隐私模式写入失败 */ }
}

export function attachDelayedHover(el, delay = 180) {
  let timer = null, suppressed = false, activePointer = null;
  const close = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    el.classList.remove("fab-hover");
  };
  el.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch" || suppressed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      el.classList.add("fab-hover");
    }, delay);
  });
  el.addEventListener("pointerleave", () => {
    if (activePointer === null) suppressed = false;
    close();
  });
  el.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    suppressed = true;
    activePointer = event.pointerId;
    close();
  });
  el.addEventListener("dragstart", event => event.preventDefault());
  const release = event => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    if (!el.matches(":hover")) suppressed = false;
  };
  el.ownerDocument.defaultView.addEventListener("pointerup", release);
  el.ownerDocument.defaultView.addEventListener("pointercancel", release);
}

export function panelOpenStartFrame(from, target, placement) {
  const scaleX = from.width / Math.max(target.width, 1);
  const scaleY = from.height / Math.max(target.height, 1);
  const originX = placement.toRight ? 0 : target.width;
  const originY = placement.toBottom ? 0 : target.height;
  const translateX = from.left - target.left - originX * (1 - scaleX);
  const translateY = from.top - target.top - originY * (1 - scaleY);
  return {
    transform: "translate(" + translateX + "px," + translateY + "px) scale(" + scaleX + "," + scaleY + ")",
    transformOrigin: placement.origin,
    opacity: 0.82
  };
}

// 返回面板左上角与动画原点；toRight/toBottom 供拖拽结束后反推锚点。
export function panelPlacement(anchor, panelW, panelH) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const toRight = anchor.x + FAB_SIZE / 2 <= vw / 2;
  const toBottom = anchor.y + FAB_SIZE / 2 <= vh / 2;
  let left = toRight ? anchor.x : anchor.x + FAB_SIZE - panelW;
  let top = toBottom ? anchor.y : anchor.y + FAB_SIZE - panelH;
  left = Math.min(Math.max(left, PANEL_MARGIN), Math.max(PANEL_MARGIN, vw - panelW - PANEL_MARGIN));
  top = Math.min(Math.max(top, PANEL_MARGIN), Math.max(PANEL_MARGIN, vh - panelH - PANEL_MARGIN));
  return { left, top, toRight, toBottom, origin: (toBottom ? "top" : "bottom") + " " + (toRight ? "left" : "right") };
}

// 拖拽结束后面板已不在派生位：按展开方向从面板矩形反推锚点，保证下次展开位置一致。
export function anchorFromPanel(rect, placement) {
  const x = placement.toRight ? rect.left : rect.right - FAB_SIZE;
  const y = placement.toBottom ? rect.top : rect.bottom - FAB_SIZE;
  return clampAnchor(x, y);
}

// hover 提示条展开方向：左侧放得下就向左展开（默认设计），按钮靠近左边缘时
// 改向右展开，避免提示条出界被遮挡。结果写宿主 data-fab-side，面板 CSS 用
// :host([data-fab-side]) 翻转 left/right 定位。
function fabSideFor(anchor) {
  const leftRoom = anchor.x + FAB_SIZE - FAB_MARGIN;
  const rightRoom = window.innerWidth - FAB_MARGIN - anchor.x;
  if (leftRoom >= FAB_TOOLTIP_WIDTH) return "left";
  if (rightRoom >= FAB_TOOLTIP_WIDTH) return "right";
  return leftRoom >= rightRoom ? "left" : "right";
}

// 指针拖拽：onStart 越过阈值时触发一次，onMove 收到相对 pointerdown 的累计位移，
// onEnd 仅在真拖拽后触发，并吞掉随之而来的 click（避免拖完误开/误关面板）。
export function attachDrag(el, { onStart, onMove, onEnd, ignore }) {
  let base = null;
  el.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (ignore && ignore(event)) return;
    base = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  el.addEventListener("pointermove", event => {
    if (!base || event.pointerId !== base.id) return;
    const dx = event.clientX - base.x, dy = event.clientY - base.y;
    if (!base.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      base.moved = true;
      // 合成指针事件（测试）下 pointerId 可能无效，捕获失败不影响拖拽本身。
      try { el.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }
      onStart?.();
    }
    event.preventDefault();
    onMove(dx, dy);
  });
  const finish = event => {
    if (!base || event.pointerId !== base.id) return;
    const moved = base.moved;
    base = null;
    if (!moved) return;
    swallowClick(el);
    onEnd?.();
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", () => { base = null; });
}

function swallowClick(el) {
  const stop = event => { event.stopPropagation(); event.preventDefault(); };
  el.addEventListener("click", stop, { capture: true, once: true });
  // click 在 pointerup 后同步派发，定时器兜底移除，不会误吞下一次正常点击。
  setTimeout(() => el.removeEventListener("click", stop, { capture: true }), 0);
}

// 面板定位控制器：host = 变形宿主（收起 48×48 ↔ 展开面板），handle = 展开态拖拽
// 手柄（标题栏）。收起态拖 host、展开态拖 handle，结束写回 localStorage；
// resize 时重新夹取。两个面板各持一个实例，行为与记忆键完全一致。
export function createPositionController(host, handle) {
  let anchor = null, placement = null, open = false, dragBase = null;
  const current = () => anchor || (anchor = loadAnchor());
  const apply = (x, y) => { host.style.left = x + "px"; host.style.top = y + "px"; };
  const syncFabSide = () => { host.dataset.fabSide = fabSideFor(current()); };

  attachDrag(host, {
    ignore: () => open,
    onStart: () => { dragBase = current(); },
    onMove: (dx, dy) => {
      anchor = clampAnchor(dragBase.x + dx, dragBase.y + dy);
      apply(anchor.x, anchor.y);
      syncFabSide();
    },
    onEnd: () => saveAnchor(current())
  });
  attachDrag(handle, {
    ignore: event => event.target.closest("button"),
    onStart: () => { dragBase = host.getBoundingClientRect(); },
    onMove: (dx, dy) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      apply(
        Math.min(Math.max(dragBase.left + dx, PANEL_MARGIN), Math.max(PANEL_MARGIN, vw - dragBase.width - PANEL_MARGIN)),
        Math.min(Math.max(dragBase.top + dy, PANEL_MARGIN), Math.max(PANEL_MARGIN, vh - dragBase.height - PANEL_MARGIN))
      );
    },
    onEnd: () => {
      // 面板已被拖离派生位：按展开方向从面板矩形反推锚点，保证下次展开落点一致。
      if (placement) anchor = anchorFromPanel(host.getBoundingClientRect(), placement);
      saveAnchor(current());
    }
  });
  const reposition = () => {
    if (host.style.display === "none") return;
    if (open && placement) {
      placement = panelPlacement(current(), host.offsetWidth, host.offsetHeight);
      apply(placement.left, placement.top);
    } else if (!open) {
      // 重读存储而非夹取内存值：初始化时视口可能尚未稳定（小窗夹取过），
      // 视口恢复后应回到记忆位置，而不是留在被夹取的角落。
      anchor = loadAnchor();
      apply(anchor.x, anchor.y);
      syncFabSide();
    }
  };
  window.addEventListener("resize", reposition);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", reposition);
  // BFCache restores can change the visible viewport without dispatching window.resize.
  window.addEventListener("pageshow", () => window.requestAnimationFrame(reposition));
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(reposition);
    observer.observe(host);
    const content = host.shadowRoot && host.shadowRoot.getElementById("content");
    if (content) observer.observe(content);
  }

  return {
    // 收起态内联定位片段（替换旧版固定 right/bottom）。
    collapsedPosition() {
      open = false;
      const a = current();
      syncFabSide();
      return "left:" + a.x + "px;top:" + a.y + "px;right:auto;bottom:auto;";
    },
    // 展开态：量好面板宽高后调用，应用落点并返回含动画 origin 的 placement。
    placePanel(width, height) {
      open = true;
      placement = panelPlacement(current(), width, height);
      apply(placement.left, placement.top);
      return placement;
    }
  };
}
