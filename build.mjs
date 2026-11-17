// ============================================================================
// build.mjs — 由根目录共享核心组装 Firefox 与 Chrome 两个扩展产物
// ----------------------------------------------------------------------------
// 共享核心即本目录（根）：manifest.json lib/ content/ tasks/ background/
//   universal-panel.js bilibili-engine.js popup.* icon*.png vendor/ offscreen/。
// 本脚本把上述文件复制到 dist/ 下两个按版本命名的目录：
//   dist/PurrVid-firefox-v{version}  —— 原样复制，Firefox 可直接加载
//   dist/PurrVid-chrome-v{version}   —— 由根 manifest.json 派生 Chrome 清单：
//     background.scripts → background.service_worker
//     去掉 downloads.open 权限与 gecko 设置；加入 offscreen 权限与 minimum_chrome_version。
// 版本号取自根 manifest.json，并据此同步生成根 update.json（自托管更新清单）。
//
// 用法：node build.mjs
// 维护：只改根目录的共享核心，再跑一次本脚本刷新 dist/（生成产物，每次构建清空重建，
//   请勿在其中手工改代码）。dist/ 已被 .gitignore 忽略。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");

// 需要复制到两个产物的共享核心（目录整体复制；manifest.json 单独处理）。
const INCLUDE = [
  "popup.html", "popup.js", "icon.png", "icon-16.png", "icon-48.png",
  "bilibili-engine.js", "universal-panel.js",
  "background", "content", "tasks", "lib", "vendor", "offscreen"
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 清空并重建某个输出目录，再复制共享核心。
// Windows 下资源管理器/杀毒/已加载的浏览器可能持有目录句柄导致 rmdir EBUSY：
// 保留顶层目录，仅尽力清理子项，随后覆盖复制，避免整次构建失败。
function prepareOut(out) {
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(out)) {
    try {
      fs.rmSync(path.join(out, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("清理被占用的旧产物（将覆盖）:", path.join(out, entry), error.code);
    }
  }
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      console.warn("跳过缺失项:", item);
      continue;
    }
    copyRecursive(src, path.join(out, item));
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const gecko = manifest.browser_specific_settings?.gecko ?? {};

// ---- Firefox 产物：清单原样保留 ----
const firefoxOut = path.join(DIST, `PurrVid-firefox-v${version}`);
prepareOut(firefoxOut);
fs.copyFileSync(path.join(ROOT, "manifest.json"), path.join(firefoxOut, "manifest.json"));

// ---- Chrome 产物：由 Firefox 清单派生 ----
const chromeOut = path.join(DIST, `PurrVid-chrome-v${version}`);
prepareOut(chromeOut);
const chromeManifest = JSON.parse(JSON.stringify(manifest));
chromeManifest.background = { service_worker: manifest.background.scripts[0], type: "module" };
chromeManifest.permissions = manifest.permissions.filter(name => name !== "downloads.open");
if (!chromeManifest.permissions.includes("offscreen")) chromeManifest.permissions.push("offscreen");
delete chromeManifest.browser_specific_settings;
chromeManifest.minimum_chrome_version = "116";
fs.writeFileSync(path.join(chromeOut, "manifest.json"), JSON.stringify(chromeManifest, null, 2) + "\n");

// ---- 根 update.json：自托管更新清单，只保留最新版本指向 ----
// 参考 https://extensionworkshop.com/documentation/manage/updating-your-extension/
// update_link 为 HTTPS，故 update_hash 可选；签名后可补充 sha256:/sha512: 哈希。
const updateManifest = {
  addons: {
    [gecko.id]: {
      updates: [
        {
          version,
          update_link: `https://github.com/snowtafir/PurrVid/releases/download/v${version}/PurrVid-firefox-v${version}.xpi`,
          applications: { gecko: { strict_min_version: gecko.strict_min_version ?? "140.0" } }
        }
      ]
    }
  }
};
fs.writeFileSync(path.join(ROOT, "update.json"), JSON.stringify(updateManifest, null, 2) + "\n");

console.log("已生成 Firefox 扩展:", firefoxOut);
console.log("已生成 Chrome 扩展:", chromeOut);
console.log("已同步 update.json:", `v${version}`, gecko.id);
console.log("Chrome 清单背景:", JSON.stringify(chromeManifest.background));
console.log("Chrome 权限:", chromeManifest.permissions.join(", "));