// ============================================================================
// lib/request-headers.js — 后台下载的任务级 DNR 请求头规则（共享库，仅后台使用）
// ----------------------------------------------------------------------------
// 后台 fetch 丢失页面 Referer/Origin，部分 CDN 防盗链会 403。这里按下载任务
// 注册临时会话规则补回真实页面的 Referer（完整 URL）与 Origin：
//   - initiatorDomains 限定为扩展自身域 → 只命中扩展后台发出的请求，
//     页面播放器自身的请求完全不受影响（爆炸半径归零）；
//   - requestDomains 限定为本次任务的媒体主机；
//   - 任务结束（成功或失败）即移除；会话规则浏览器重启自动清空，无残留。
// 个别浏览器不支持 initiatorDomains 时退化为「仅媒体主机 + 短生命周期」规则：
// 补的值就是真实页面 Referer，对播放器自身请求近似无操作。
// ============================================================================

const api = typeof browser !== "undefined" ? browser : chrome;

// 会话规则 id 段：1001 已被 googlevideo 固定规则占用，任务规则从 2000 起自增。
let nextRuleId = 2000;

// 为 urls 涉及的主机注册 Referer/Origin 补全规则，返回 cleanup（务必在 finally 调用）。
// pageUrl 传面板所在文档的完整 URL（iframe 嗅探时即 iframe 的 URL）。
export async function acquireHeaderRules(pageUrl, urls) {
  const noop = () => {};
  if (!api.declarativeNetRequest?.updateSessionRules) return noop;
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return noop;
  }
  if (!["http:", "https:"].includes(page.protocol)) return noop;
  const hosts = [...new Set((urls || []).map(url => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean))];
  if (!hosts.length) return noop;

  const ruleId = nextRuleId++;
  // 扩展自身域：Chrome 为 runtime.id，Firefox 为内部 UUID（≠ addon id），
  // 统一从 getURL 取 hostname 才能两浏览器都命中 initiatorDomains。
  const selfHost = new URL(api.runtime.getURL("")).hostname;
  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: page.href },
        { header: "Origin", operation: "set", value: page.origin }
      ]
    },
    condition: {
      requestDomains: hosts,
      initiatorDomains: [selfHost],
      resourceTypes: ["xmlhttprequest", "media", "other"]
    }
  };
  const remove = () => api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  try {
    await api.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  } catch {
    // initiatorDomains 不被支持时退化：仅按媒体主机匹配（值仍是真实页面 Referer）。
    try {
      delete rule.condition.initiatorDomains;
      await api.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    } catch {
      return noop;
    }
  }
  return remove;
}