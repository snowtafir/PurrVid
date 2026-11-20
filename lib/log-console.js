// Shared structured log console for all PurrVid in-page panels (Bilibili /
// YouTube / generic). One implementation keeps the three panels visually and
// behaviourally identical: sticky head + collapse toggle (collapsed by default)
// + clear button, id chips, colored section dots, copyable link cards,
// monospace break-all URLs, pink scrollbar.
//
// Only createElement / textContent are used (no innerHTML) so the console is
// safe under YouTube's Trusted Types policy and against injected titles/URLs.
//
// Usage:
//   const console_ = createLogConsole(rootEl, { title: "解析日志" });
//   console_.line("…"); console_.id({ av: 1 }); console_.heading("下载链接");
//   console_.section("音频", "audio"); console_.link("主链接", url);
// Inject LOG_CSS into the panel's <style> (or shadow root) alongside panel CSS.

export const LOG_CSS = `
.pv-logs {
  margin-top: 10px;
  max-height: 240px;
  overflow: auto;
  border: 1px solid rgba(227, 233, 242, .9);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(247, 249, 253, .92), rgba(240, 244, 251, .88));
  color: #65728a;
  font-size: 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(244, 90, 141, .55) rgba(227, 233, 242, .5);
}
.pv-logs::-webkit-scrollbar { width: 8px; }
.pv-logs::-webkit-scrollbar-track { background: rgba(227, 233, 242, .4); border-radius: 99px; }
.pv-logs::-webkit-scrollbar-thumb { background: rgba(244, 90, 141, .45); border-radius: 99px; }
.pv-logs::-webkit-scrollbar-thumb:hover { background: rgba(216, 63, 128, .7); }
.pv-logs-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: linear-gradient(180deg, rgba(247, 249, 253, .98), rgba(247, 249, 253, .9));
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(227, 233, 242, .8);
}
.pv-logs-head h4 { margin: 0; font-size: 11px; font-weight: 700; color: #863b5d; letter-spacing: .3px; }
.pv-logs-actions { display: flex; align-items: center; gap: 6px; }
.pv-logs-head button {
  padding: 2px 10px;
  border: 1px solid rgba(244, 90, 141, .3);
  border-radius: 99px;
  background: rgba(255, 255, 255, .7);
  color: #b73569;
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.pv-logs-head button:hover { background: #fff0f6; border-color: rgba(216, 63, 128, .5); }
.pv-logs.collapsed .pv-logs-body { display: none; }
.pv-logs.collapsed .pv-logs-head { border-bottom-color: transparent; }
.pv-logs-body { padding: 8px 10px 10px; display: grid; gap: 6px; }
.pv-logs .log-line { margin: 0; line-height: 1.5; word-break: break-all; }
.pv-logs .log-id { display: flex; flex-wrap: wrap; gap: 6px; }
.pv-logs .log-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid rgba(227, 233, 242, .9);
  border-radius: 99px;
  background: rgba(255, 255, 255, .8);
  font-size: 10px;
}
.pv-logs .log-chip b { color: #8994a8; font-weight: 600; }
.pv-logs .log-chip code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #465777; }
.pv-logs .log-heading {
  margin: 2px 0 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .6px;
  color: #8994a8;
}
.pv-logs .log-section { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; font-weight: 700; color: #465777; }
.pv-logs .log-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #8994a8; box-shadow: 0 0 0 3px rgba(137, 148, 168, .18); }
.pv-logs .log-section.audio .log-dot { background: #f45a8d; box-shadow: 0 0 0 3px rgba(244, 90, 141, .18); }
.pv-logs .log-section.video .log-dot { background: #5b8def; box-shadow: 0 0 0 3px rgba(91, 141, 239, .18); }
.pv-logs .log-section.segment .log-dot { background: #f5a623; box-shadow: 0 0 0 3px rgba(245, 166, 35, .18); }
.pv-logs .log-section.youtube .log-dot { background: #ff4e45; box-shadow: 0 0 0 3px rgba(255, 78, 69, .18); }
.pv-logs .log-section.hls .log-dot { background: #8b5cf6; box-shadow: 0 0 0 3px rgba(139, 92, 246, .18); }
.pv-logs .log-section.dash .log-dot { background: #14b8a6; box-shadow: 0 0 0 3px rgba(20, 184, 166, .18); }
.pv-logs .log-section.direct .log-dot { background: #2ea05a; box-shadow: 0 0 0 3px rgba(46, 160, 90, .18); }
.pv-logs .log-link {
  padding: 6px 8px;
  border: 1px solid rgba(227, 233, 242, .9);
  border-radius: 10px;
  background: rgba(255, 255, 255, .72);
  display: grid;
  gap: 4px;
}
.pv-logs .log-link-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pv-logs .log-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: 99px;
  background: rgba(137, 148, 168, .16);
  color: #68758e;
  font-size: 10px;
  font-weight: 700;
}
.pv-logs .log-tag.primary { background: linear-gradient(135deg, #f45a8d, #d83f80); color: #fff; }
.pv-logs .log-host {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8994a8;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.pv-logs .log-copy {
  flex: none;
  padding: 1px 9px;
  border: 1px solid rgba(244, 90, 141, .3);
  border-radius: 99px;
  background: rgba(255, 255, 255, .8);
  color: #b73569;
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.pv-logs .log-copy:hover { background: #fff0f6; }
.pv-logs .log-copy.ok { background: #e8f7ee; border-color: rgba(46, 160, 90, .4); color: #2ea05a; }
.pv-logs .log-url {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  line-height: 1.45;
  color: #6b7890;
  word-break: break-all;
  white-space: normal;
}
`;

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

export function createLogConsole(root, { title = "解析日志" } = {}) {
  root.replaceChildren();
  // 默认收起：日志属于排障信息，不打扰正常下载操作。
  root.classList.add("collapsed");
  const head = document.createElement("div");
  head.className = "pv-logs-head";
  const h4 = document.createElement("h4");
  h4.textContent = title;
  const actions = document.createElement("div");
  actions.className = "pv-logs-actions";
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "pv-logs-toggle";
  toggleBtn.textContent = "展开";
  toggleBtn.setAttribute("aria-expanded", "false");
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "pv-logs-clear";
  clearBtn.textContent = "清空";
  actions.append(toggleBtn, clearBtn);
  head.append(h4, actions);
  const body = document.createElement("div");
  body.className = "pv-logs-body";
  root.append(head, body);

  const scroll = () => { root.scrollTop = root.scrollHeight; };
  const append = (el) => { body.appendChild(el); scroll(); return el; };
  const setCollapsed = (collapsed) => {
    root.classList.toggle("collapsed", collapsed);
    toggleBtn.textContent = collapsed ? "展开" : "收起";
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) scroll();
  };

  const api = {
    el: root,
    clear() { body.replaceChildren(); },
    line(text) {
      const p = document.createElement("p");
      p.className = "log-line";
      p.textContent = String(text);
      return append(p);
    },
    id(pairs) {
      const p = document.createElement("p");
      p.className = "log-line log-id";
      for (const [key, value] of Object.entries(pairs)) {
        const chip = document.createElement("span");
        chip.className = "log-chip";
        const b = document.createElement("b");
        b.textContent = key;
        const code = document.createElement("code");
        code.textContent = String(value);
        chip.append(b, code);
        p.appendChild(chip);
      }
      return append(p);
    },
    heading(text) {
      const p = document.createElement("p");
      p.className = "log-heading";
      p.textContent = String(text);
      return append(p);
    },
    section(label, kind) {
      const div = document.createElement("div");
      div.className = "log-section" + (kind ? " " + kind : "");
      const dot = document.createElement("span");
      dot.className = "log-dot";
      const span = document.createElement("span");
      span.textContent = String(label);
      div.append(dot, span);
      return append(div);
    },
    link(label, url) {
      const text = String(url || "");
      const card = document.createElement("div");
      card.className = "log-link";
      const headRow = document.createElement("div");
      headRow.className = "log-link-head";
      const tag = document.createElement("span");
      tag.className = "log-tag" + (/主|master|primary/i.test(String(label)) ? " primary" : "");
      tag.textContent = String(label);
      const host = document.createElement("span");
      host.className = "log-host";
      try { host.textContent = new URL(text).hostname; } catch { host.textContent = ""; }
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "log-copy";
      copy.textContent = "复制";
      copy.dataset.copy = text;
      headRow.append(tag, host, copy);
      const code = document.createElement("code");
      code.className = "log-url";
      code.textContent = text;
      card.append(headRow, code);
      return append(card);
    },
  };

  root.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".pv-logs-toggle")) { setCollapsed(!root.classList.contains("collapsed")); return; }
    if (target.closest(".pv-logs-clear")) { api.clear(); return; }
    const copyBtn = target.closest(".log-copy");
    if (!copyBtn) return;
    const text = copyBtn.dataset.copy || "";
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) ok = fallbackCopy(text);
    copyBtn.textContent = ok ? "已复制" : "复制失败";
    copyBtn.classList.toggle("ok", ok);
    setTimeout(() => { copyBtn.textContent = "复制"; copyBtn.classList.remove("ok"); }, 1200);
  });

  return api;
}