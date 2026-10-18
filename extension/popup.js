"use strict";

const DEFAULTS = { enabled: true, active: true, excludedHosts: [] };
const enabledInput = document.getElementById("enabled");
const activeInput = document.getElementById("active");
const siteInput = document.getElementById("site-enabled");
const summary = document.getElementById("summary");
const siteName = document.getElementById("site-name");
const siteHelp = document.getElementById("site-help");
const feedback = document.getElementById("feedback");
const error = document.getElementById("error");
const videoButton = document.getElementById("show-video-controls");
const videoFeedback = document.getElementById("video-feedback");
let hostname = null;
let tabId = null;
let settings = { ...DEFAULTS };
let ready = false;
let videoPending = false;
const pending = new Set();

function normalizeSettings(value) {
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    active: typeof value.active === "boolean" ? value.active : true,
    excludedHosts: Array.isArray(value.excludedHosts)
      ? value.excludedHosts.filter((host) => typeof host === "string")
      : [],
  };
}

function render() {
  enabledInput.checked = settings.enabled;
  activeInput.checked = settings.active;
  siteInput.checked = Boolean(hostname && !settings.excludedHosts.includes(hostname));
  enabledInput.disabled = !ready || pending.has("enabled");
  activeInput.disabled = !ready || pending.has("active");
  siteInput.disabled = !ready || !hostname || pending.has("excludedHosts");
  videoButton.disabled = !ready || !hostname || !Number.isInteger(tabId) || videoPending;
  summary.textContent = !settings.enabled
    ? "已暂停，链接按网页原有方式打开"
    : hostname && settings.excludedHosts.includes(hostname)
      ? "已开启，当前网站除外"
      : "保留当前页面，继续探索";
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  feedback.textContent = "";
}

function identifySite(tab) {
  tabId = Number.isInteger(tab?.id) ? tab.id : null;
  let url;
  try {
    url = new URL(tab?.url || "");
  } catch {
    siteName.textContent = "无法读取当前页面";
    siteHelp.textContent = "请打开普通网页，再点击扩展图标。";
    videoFeedback.textContent = "请先打开普通 HTTP / HTTPS 网页并播放视频。";
    return;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    siteName.textContent = "此页面不支持扩展";
    siteHelp.textContent = "仅适用于 HTTP / HTTPS 网页；浏览器内部页面不支持。";
    videoFeedback.textContent = "浏览器内部页面等特殊页面不支持视频小窗。";
    return;
  }

  siteName.textContent = url.hostname;
  if (url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))) {
    siteHelp.textContent = "Chrome 网上应用店不允许此扩展修改链接行为。";
    videoFeedback.textContent = "Chrome 网上应用店不允许此扩展运行。";
    return;
  }
  hostname = url.hostname;
}

const VIDEO_ERRORS = {
  "no-video": "没有找到可用的视频。请先在网页上打开视频，再重试。",
  "not-ready": "视频尚未加载好，请先播放几秒钟，再重试。",
  "fullscreen": "请先退出全屏，再点击视频上的“小窗播放”。",
  "disabled": "此视频已被网站禁用画中画，扩展不会绕过网站限制。",
  "policy": "此网页或内嵌视频的权限策略不允许画中画，扩展不会绕过网站限制。",
  "not-supported": "此视频或网页不允许画中画，也可能是浏览器不支持。扩展不会绕过网站限制。",
  "no-access": "暂时无法访问此页面。请刷新网页，并检查扩展的网站访问权限。",
};

async function requestVideoControls(targetTabId) {
  const requestId = crypto.randomUUID();
  let timer;
  let receive;
  try {
    return await new Promise((resolve) => {
      const results = [];
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const accept = (result) => {
        if (settled || typeof result?.ok !== "boolean") return;
        results.push(result);
        if (result.ok) finish(result);
      };
      receive = (message, sender) => {
        if (message?.type !== "PIP_CONTROL_RESULT" || message.requestId !== requestId ||
            sender.id !== chrome.runtime.id || sender.tab?.id !== targetTabId) return;
        accept(message.result);
      };
      // A tab broadcast only returns one frame's direct response. Collect the
      // explicit replies too, so a video inside an iframe can win over no-video.
      chrome.runtime.onMessage.addListener(receive);
      timer = setTimeout(() => {
        const priority = ["fullscreen", "not-ready", "disabled", "policy", "not-supported", "no-video", "no-access"];
        const reason = priority.find((value) => results.some((result) => result.reason === value));
        finish({ ok: false, reason: reason || "no-access" });
      }, 500);
      chrome.tabs.sendMessage(targetTabId, { type: "PIP_SHOW_CONTROLS", requestId })
        .then(accept)
        .catch(() => {
          // Another frame can still answer through runtime messaging. Wait for
          // the collection deadline before treating the page as inaccessible.
        });
    });
  } finally {
    clearTimeout(timer);
    if (receive) chrome.runtime.onMessage.removeListener(receive);
  }
}

videoButton.addEventListener("click", async () => {
  if (videoPending || !hostname || !Number.isInteger(tabId)) return;
  videoPending = true;
  videoFeedback.dataset.state = "";
  videoFeedback.textContent = "正在查找网页视频…";
  render();
  try {
    const response = await requestVideoControls(tabId);
    if (response?.ok) {
      videoFeedback.dataset.state = "success";
      videoFeedback.textContent = "请回到网页，点击视频上的“小窗播放”。";
    } else {
      videoFeedback.dataset.state = "error";
      videoFeedback.textContent = VIDEO_ERRORS[response?.reason] ||
        "暂时无法显示按钮。安装或更新后，请先刷新网页再重试。";
    }
  } catch {
    videoFeedback.dataset.state = "error";
    videoFeedback.textContent = "未能连接到网页。安装或更新后，请先刷新网页；若仍无效，请检查扩展的网站访问权限。";
  } finally {
    videoPending = false;
    render();
  }
});

async function save(key, value) {
  if (pending.has(key)) return;
  pending.add(key);
  error.hidden = true;
  feedback.textContent = "正在保存…";
  render();
  try {
    await chrome.storage.local.set({ [key]: value });
    settings = normalizeSettings({ ...settings, [key]: value });
    feedback.textContent = "已保存";
  } catch {
    showError("保存失败，请关闭面板后重试。");
  } finally {
    pending.delete(key);
    render();
  }
}

enabledInput.addEventListener("change", () => save("enabled", enabledInput.checked));
activeInput.addEventListener("change", () => save("active", activeInput.checked));
siteInput.addEventListener("change", async () => {
  if (!hostname || pending.has("excludedHosts")) return;
  const enableSite = siteInput.checked;
  pending.add("excludedHosts");
  siteInput.disabled = true;
  error.hidden = true;
  feedback.textContent = "正在保存…";
  try {
    // Read the current list before changing only this site's entry.
    const latest = normalizeSettings(await chrome.storage.local.get(DEFAULTS));
    const hosts = new Set(latest.excludedHosts);
    if (enableSite) hosts.delete(hostname);
    else hosts.add(hostname);
    const excludedHosts = [...hosts];
    await chrome.storage.local.set({ excludedHosts });
    settings.excludedHosts = excludedHosts;
    feedback.textContent = "已保存";
  } catch {
    showError("保存失败，请关闭面板后重试。");
  } finally {
    pending.delete("excludedHosts");
    render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULTS)) {
    if (changes[key]) settings[key] = changes[key].newValue ?? DEFAULTS[key];
  }
  settings = normalizeSettings(settings);
  if (ready) render();
});

async function initialize() {
  try {
    const [stored, tabs] = await Promise.all([
      chrome.storage.local.get(DEFAULTS),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    settings = normalizeSettings(stored);
    identifySite(tabs[0]);
    ready = true;
    render();
  } catch {
    summary.textContent = "暂时无法读取设置";
    siteName.textContent = "当前网站不可用";
    showError("初始化失败，请关闭面板后重试。");
  }
}

initialize();
