// ============================================================================
// build.mjs — 由根目录共享核心组装 Firefox 与 Chrome 两个扩展产物
// ----------------------------------------------------------------------------
// 共享核心即本目录（根）：manifest.json lib/ content/ tasks/ background/
//   universal-panel.js bilibili-engine.js popup.* icon*.png vendor/ offscreen/。
// 本脚本把上述文件复制到 dist/ 下按版本命名的目录：
//   dist/PurrVid-firefox-v{version}  —— Firefox 公开（listed）版：清单去掉 gecko.update_url
//     （AMO 公开渠道上传校验禁止 update_url，仅自托管渠道允许）
//   dist/PurrVid-chrome-v{version}   —— 由根 manifest.json 派生 Chrome 清单：
//     background.scripts → background.service_worker
//     去掉 downloads.open（仅 Firefox 有）与未使用的 scripting/activeTab（商店最小权限要求），
//     去掉 gecko 设置；加入 offscreen 权限与 minimum_chrome_version。
// 版本号取自根 manifest.json，并据此同步生成根 update.json（自托管更新清单）。
//
// 用法：
//   node build.mjs             常规构建：listed 版 Firefox + Chrome，update.json 指向 listed 版
//   node build.mjs --unlisted  额外生成 Firefox 自托管（unlisted）变体，update.json 改指向它：
//     dist/PurrVid-firefox-v{version}.1 —— 清单版本号追加第四段 .1。AMO 要求同一附加组件
//       跨渠道版本号唯一且只允许纯数字，故自托管版用 {version}.1 与公开版 {version} 区分。
//       上传 AMO 选自托管渠道签名后，xpi 改名 PurrVid-firefox-v{version}-R.xpi，
//       发布到 GitHub Release 标签 v{version}-R（update.json 的 update_link 即指向它）。
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
const UNLISTED = process.argv.includes("--unlisted");

// ---- Firefox 公开（listed）产物：去掉 update_url（AMO 公开渠道校验禁止该字段） ----
const firefoxOut = path.join(DIST, `PurrVid-firefox-v${version}`);
prepareOut(firefoxOut);
const listedManifest = JSON.parse(JSON.stringify(manifest));
delete listedManifest.browser_specific_settings?.gecko?.update_url;
fs.writeFileSync(path.join(firefoxOut, "manifest.json"), JSON.stringify(listedManifest, null, 2) + "\n");

// ---- Chrome 产物：由 Firefox 清单派生 ----
const chromeOut = path.join(DIST, `PurrVid-chrome-v${version}`);
prepareOut(chromeOut);
const chromeManifest = JSON.parse(JSON.stringify(manifest));
chromeManifest.background = { service_worker: manifest.background.scripts[0], type: "module" };
// Chrome/Edge 商店要求最小权限：downloads.open 仅 Firefox 存在；scripting/activeTab
// 本扩展从未调用（面板经静态内容脚本 + MAIN world 动态 import 注入），声明会被商店拒绝。
const CHROME_DROP_PERMISSIONS = ["downloads.open", "scripting", "activeTab"];
chromeManifest.permissions = manifest.permissions.filter(name => !CHROME_DROP_PERMISSIONS.includes(name));
if (!chromeManifest.permissions.includes("offscreen")) chromeManifest.permissions.push("offscreen");
delete chromeManifest.browser_specific_settings;
chromeManifest.minimum_chrome_version = "116";
fs.writeFileSync(path.join(chromeOut, "manifest.json"), JSON.stringify(chromeManifest, null, 2) + "\n");

// ---- Firefox 自托管（unlisted）变体：仅 --unlisted 时生成 ----
// AMO 版本号只允许纯数字且同一附加组件跨渠道唯一：公开版用 {version}，
// 自托管版追加第四段 .1（如 1.0.2 → 1.0.2.1）。与 listed 版的另一区别：
// 保留根清单的 gecko.update_url（自托管更新必需，listed 校验则禁止该字段）。
let unlistedVersion = "";
if (UNLISTED) {
  if (version.split(".").length >= 4) {
    throw new Error(`根 manifest 版本 ${version} 已含第四段，无法再追加 .1 生成 unlisted 变体`);
  }
  unlistedVersion = `${version}.1`;
  const unlistedOut = path.join(DIST, `PurrVid-firefox-v${unlistedVersion}`);
  prepareOut(unlistedOut);
  const unlistedManifest = JSON.parse(JSON.stringify(manifest));
  unlistedManifest.version = unlistedVersion;
  fs.writeFileSync(path.join(unlistedOut, "manifest.json"), JSON.stringify(unlistedManifest, null, 2) + "\n");
  console.log("已生成 Firefox 自托管变体:", unlistedOut);
}

// ---- 根 update.json：自托管更新清单，只保留最新版本指向 ----
// 参考 https://extensionworkshop.com/documentation/manage/updating-your-extension/
// update_link 为 HTTPS，故 update_hash 可选；签名后可补充 sha256:/sha512: 哈希。
// listed 扩展的更新走 AMO、update_url 被忽略，故 update.json 实际只服务自托管安装：
//   常规模式指向 listed 版同名 Release（兼容旧约定）；
//   --unlisted 模式指向自托管版：version 必须与 xpi 内部版本（{version}.1）一致，
//   下载链接用带 -R 尾缀的标签与文件名（发布时把签名 xpi 改名上传即可）。
const updateVersion = UNLISTED ? unlistedVersion : version;
const updateTag = UNLISTED ? `v${version}-R` : `v${version}`;
const updateFile = UNLISTED ? `PurrVid-firefox-v${version}-R.xpi` : `PurrVid-firefox-v${version}.xpi`;
const updateManifest = {
  addons: {
    [gecko.id]: {
      updates: [
        {
          version: updateVersion,
          update_link: `https://github.com/snowtafir/PurrVid/releases/download/${updateTag}/${updateFile}`,
          applications: { gecko: { strict_min_version: gecko.strict_min_version ?? "140.0" } }
        }
      ]
    }
  }
};
fs.writeFileSync(path.join(ROOT, "update.json"), JSON.stringify(updateManifest, null, 2) + "\n");

console.log("已生成 Firefox 扩展:", firefoxOut);
console.log("已生成 Chrome 扩展:", chromeOut);
console.log("已同步 update.json:", `v${updateVersion}`, gecko.id, "→", `${updateTag}/${updateFile}`);
console.log("Chrome 清单背景:", JSON.stringify(chromeManifest.background));
console.log("Chrome 权限:", chromeManifest.permissions.join(", "));