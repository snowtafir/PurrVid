<div align="center">

<img src="icon.png" alt="PurrVid logo" width="96" height="96">

# PurrVid · 星喵助手

**A cute catgirl extension that helps you save playable videos on web pages.**

A lightweight, dependency-free Manifest V3 extension with an in-page download panel.

English · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)
![ffmpeg.wasm](https://img.shields.io/badge/ffmpeg-wasm-007808?logo=ffmpeg&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

</div>

---

## Overview

PurrVid is a starry-sky catgirl who lives in the corner of your video pages. She adds a small floating button to the bottom-right corner; click it to open an in-page panel that parses the current video and lets you pick a quality and download — no extra tab, no copy-pasting URLs. She sniffs standard **HLS / DASH / direct** media on any site, with dedicated handling for **Bilibili** and **YouTube**.

The whole project is plain ES modules (no bundler, no framework). One shared codebase at the repository root ships to both Firefox and Chrome.

## Features

- **In-page panel** — a persistent floating button with a smooth expand / collapse animation; nothing leaves the page.
- **Generic sites** — automatic media sniffing surfaces HLS / DASH / direct links in the same panel.
- **Bilibili** — videos and bangumi (anime), multi-part pages, quality follows the player. Three download modes: merge, separate, or hand off to the browser.
- **YouTube** — HLS streams with quality / audio-track selection.
- **Background downloads** — a dedicated tasks page with concurrency control for HLS / DASH / YouTube / direct resources.
- **Muxing in the browser** — audio + video are merged locally with `ffmpeg.wasm`; no server involved.
- **Cross-browser** — Firefox (event page) and Chrome (service worker + offscreen document) from a single source.

## Installation

> Requires **Firefox 140+** or **Chrome 116+**.

### Firefox

**Option 1: Install from AMO (recommended)**

Visit [星喵助手 – Firefox Add-on](https://addons.mozilla.org/zh-CN/firefox/addon/%E5%B0%8F%E7%A0%B4%E7%AB%99%E5%8A%A9%E6%89%8B/) and click **Add to Firefox**.

**Option 2: Install from GitHub Releases**

Go to the [Releases page](https://github.com/snowtafir/PurrVid/releases), download the Firefox build (`.xpi`), and open it in Firefox to install.

### Chrome

Go to the [Releases page](https://github.com/snowtafir/PurrVid/releases), download the Chrome build (`.zip`), and unzip it. Then:

1. Open `chrome://extensions` and enable **Developer mode** (top-right).
2. Click **Load unpacked** and select the extracted `PurrVid-chrome-v{version}/` folder.

### Load from source (developers)

- **Firefox**: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select the root `manifest.json`. The repository root is the source of truth and needs no build step.
- **Chrome**: run `node build.mjs` to generate `dist/PurrVid-chrome-v{version}/` (see [Development](#development)), then load it unpacked as above.

## Usage

1. **Play the video first** so the extension can parse the available streams.
2. Click the **floating button** at the bottom-right of the page to open the panel.
3. Pick a quality / track and download.

> You can turn off **Always show floating button** in the extension popup to hide the page button; then use **Open panel** in the popup to open the panel on the current page.

### Bilibili download modes

| Mode | What it does |
| --- | --- |
| **Merge** | Muxes audio + video into a single MP4 locally (`ffmpeg.wasm`). |
| **Separate** | Saves audio and video as independent files. |
| **Browser** | Hands the stream to the browser's own downloader — lowest memory use. |

> Quality always follows the Bilibili player. Switching quality or episodes refreshes the panel automatically. While a merge / separate download is running, do not refresh or close the page.

### YouTube & generic sites

The same panel lists the sniffed HLS / DASH / direct resources. YouTube uses HLS; pick the quality and (when available) the audio track. Larger HLS / DASH jobs can run in the background and are managed on the **tasks page**, which opens automatically when a background download starts.

### Popup

The toolbar popup is intentionally minimal: an **auto-sniff** toggle, an **always-show floating button** toggle (when off, an **Open panel** button appears to summon the panel on the current page), and a link to this repository.

## Project structure

<details>
<summary>Click to expand</summary>

```text
PurrVid/
├─ manifest.json                 # Firefox manifest (source of truth)
├─ bilibili-engine.js            # Bilibili parser / downloader (page MAIN world)
├─ universal-panel.js            # In-page panel for YouTube / generic sites
├─ popup.html / popup.js         # Minimal toolbar popup
├─ background/                   # Service worker (Chrome) / event page (Firefox)
├─ content/                      # Loader, media sniffer, relay, page bridges
├─ lib/                          # ffmpeg client/host, HLS/DASH, transport, utils
├─ tasks/                        # Download tasks manager page
├─ offscreen/                    # Chrome ffmpeg host (offscreen document)
├─ vendor/ffmpeg/                # ffmpeg.wasm runtime
├─ icon.png / icon-48 / icon-16  # Extension icons (from catgirl.png)
├─ build.mjs                     # Generates both Firefox and Chrome builds
├─ update.json                   # Self-hosted Firefox update manifest
└─ dist/                         # Generated builds — do not edit by hand
   ├─ PurrVid-firefox-v{version}/
   └─ PurrVid-chrome-v{version}/
```

</details>

## How it works

<details>
<summary>Click to expand</summary>

- **Shared core + browser adapters.** All logic lives at the repository root. `build.mjs` copies it into `dist/` and derives a Chrome manifest (`background.scripts` → `service_worker`, adds the `offscreen` permission, drops Firefox-only bits).
- **Bilibili engine** runs in the page's MAIN world. Because page CSP forbids extension-URL Workers, `ffmpeg.wasm` is loaded through **blob: URLs**.
- **Chrome service workers cannot create Workers**, so ffmpeg runs in an **offscreen document**; results return to the worker over a `BroadcastChannel`. The content-script relay talks to the worker via a base64, chunked `Port`. Firefox uses structured-clone messaging directly.
- **HLS / DASH** parsing and segment downloading are shared libraries (`lib/m3u8.js`, `lib/mpd.js`, `lib/hls.js`); the background handles cross-origin segments with host permissions.

</details>

## Development

```bash
# Regenerate both Firefox and Chrome builds after editing the shared core
node build.mjs
```

- Edit code only at the repository root; `dist/` is regenerated on every build and is git-ignored.
- Output folders are named `PurrVid-firefox-v{version}` and `PurrVid-chrome-v{version}`, with the version read from `manifest.json`. The build also refreshes the root `update.json`.
- Requires Node.js (ESM). No bundler or framework — just vanilla ES modules.
- After changing code, reload the extension in the browser to test.

## Limitations & disclaimer

> - Only download content **you have the right to save**.
> - **DRM-protected** streams (Widevine / PlayReady / FairPlay / SAMPLE-AES) and **live streams** are **not supported**.
> - This tool is provided for personal and educational use. Respect copyright law and each site's terms of service.

## License

Copyright © 2026 [snowtafir](https://github.com/snowtafir).

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for the full text.

You are free to use, modify, and redistribute this software (including commercially), provided that any distributed derivative or combined work is also released under GPL-3.0 together with its corresponding source code.

> The bundled `ffmpeg.wasm` runtime (`vendor/ffmpeg/`) is a **GPL build** of FFmpeg (configured with `--enable-gpl`, libx264 / libx265), which is why the project as a whole is GPL-3.0. FFmpeg is a trademark of Fabrice Bellard; this project is not affiliated with or endorsed by the FFmpeg project. Third-party licenses and corresponding source are detailed in [NOTICE](NOTICE).

---

<div align="center">

[GitHub repository](https://github.com/snowtafir/PurrVid) · [简体中文](README.zh-CN.md)

</div>