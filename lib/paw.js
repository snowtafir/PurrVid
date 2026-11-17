// ============================================================================
// lib/paw.js — 悬浮按钮图标：粉色猫爪（简约 SVG · 透明背景）
// ----------------------------------------------------------------------------
// 单一来源：bilibili-engine.js 与 universal-panel.js 的悬浮按钮 / 折叠按钮共用。
// 以 data URL 内嵌，规避页面 CSP img-src 限制（YouTube 严格 CSP 亦可用）。
// 根目录 paw.svg 为同源预览副本，便于直接查看；改图标请改本文件的 PAW_SVG。
// ============================================================================

export const PAW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="#F45A8D"><ellipse cx="11" cy="27" rx="5.5" ry="7.5" transform="rotate(-25 11 27)"/><ellipse cx="23" cy="15" rx="6" ry="8.5" transform="rotate(-10 23 15)"/><ellipse cx="41" cy="15" rx="6" ry="8.5" transform="rotate(10 41 15)"/><ellipse cx="53" cy="27" rx="5.5" ry="7.5" transform="rotate(25 53 27)"/><path d="M32 30C23 30 15 37 15 45C15 51.5 20 55.5 25.5 55.5C28.5 55.5 30 54 32 54C34 54 35.5 55.5 38.5 55.5C44 55.5 49 51.5 49 45C49 37 41 30 32 30Z"/></svg>`;

export const PAW_URL = "data:image/svg+xml," + encodeURIComponent(PAW_SVG);