const api = typeof browser !== "undefined" ? browser : chrome;
const REPO_URL = "https://github.com/snowtafir/PurrVid";

const sniffToggle = document.getElementById("sniff-toggle");
const floatingToggle = document.getElementById("floating-toggle");
const openPanelButton = document.getElementById("open-panel");
const statusEl = document.getElementById("status");
const copyButton = document.getElementById("copy-repo");
const versionEl = document.getElementById("app-version");

versionEl.textContent = "v" + api.runtime.getManifest().version;

function setStatus(text) {
  statusEl.textContent = text || "";
}

// 常驻关闭时才显示「调出面板」按钮。
function syncOpenPanel() {
  openPanelButton.hidden = floatingToggle.checked;
}

async function init() {
  try {
    const { sniffEnabled, floatingEnabled } = await api.storage.local.get({ sniffEnabled: true, floatingEnabled: true });
    sniffToggle.checked = sniffEnabled !== false;
    floatingToggle.checked = floatingEnabled !== false;
    syncOpenPanel();
  } catch {}
}

sniffToggle.addEventListener("change", async () => {
  try {
    await api.runtime.sendMessage({ type: "set-sniff-enabled", value: sniffToggle.checked });
    setStatus(sniffToggle.checked ? "自动嗅探已开启" : "自动嗅探已关闭");
  } catch {
    setStatus("设置失败，请重试");
  }
});

floatingToggle.addEventListener("change", async () => {
  syncOpenPanel();
  try {
    await api.runtime.sendMessage({ type: "set-floating-enabled", value: floatingToggle.checked });
    setStatus(floatingToggle.checked ? "悬浮按钮已常驻显示" : "悬浮按钮已隐藏，可用下方按钮调出面板");
  } catch {
    setStatus("设置失败，请重试");
  }
});

openPanelButton.addEventListener("click", async () => {
  try {
    await api.runtime.sendMessage({ type: "open-panel" });
    setStatus("已在当前页调出面板");
  } catch {
    setStatus("调出失败，请重试");
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(REPO_URL);
    copyButton.textContent = "已复制";
    setTimeout(() => { copyButton.textContent = "复制地址"; }, 1500);
  } catch {
    setStatus("复制失败");
  }
});

init();