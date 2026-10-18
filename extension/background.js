importScripts('shared.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['GET_SETTINGS', 'OPEN_LINK'].includes(message.type)) return false;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) return false;

  (async () => {
    const settings = LinkNewTab.settings(await chrome.storage.local.get(LinkNewTab.defaults));
    const host = LinkNewTab.hostname(sender.tab.url) || LinkNewTab.hostname(message.topOrigin) || LinkNewTab.hostname(sender.url);

    if (message.type === 'GET_SETTINGS') return { ok: true, settings, host };

    const target = typeof message.url === 'string' ? LinkNewTab.webUrl(message.url) : null;
    if (!target) return { ok: false, error: 'invalid-url' };

    // Check again: settings may have changed since the content script read them.
    if (!LinkNewTab.enabledOn(settings, host)) return { ok: false, error: 'disabled' };

    await chrome.tabs.create({
      url: target.href,
      active: settings.active,
      windowId: sender.tab.windowId,
      index: sender.tab.index + 1
    });
    return { ok: true };
  })().then(sendResponse, () => sendResponse({ ok: false, error: 'open-failed' }));

  // Keep the message channel open while the service worker creates the tab.
  return true;
});
