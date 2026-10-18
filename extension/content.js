(() => {
  let config = LinkNewTab.settings();
  let ready = false;
  let host = '';
  let settingsRevision = 0;
  let notice;
  const topOrigin = location.ancestorOrigins?.length
    ? location.ancestorOrigins[location.ancestorOrigins.length - 1]
    : location.origin;

  async function initialize() {
    const revision = settingsRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS', topOrigin });
      if (!response?.ok) return;
      if (revision === settingsRevision) config = LinkNewTab.settings(response.settings);
      else config = LinkNewTab.settings(await chrome.storage.local.get(LinkNewTab.defaults));
      host = response.host;
      ready = true;
    } catch {
      // If Chrome has unloaded the extension, leave the page's native behavior alone.
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    settingsRevision++;
    const updated = { ...config };
    for (const key of Object.keys(LinkNewTab.defaults)) {
      if (key in changes) updated[key] = changes[key].newValue ?? LinkNewTab.defaults[key];
    }
    config = LinkNewTab.settings(updated);
  });

  const actionRoles = new Set(['button', 'tab', 'checkbox', 'radio', 'switch', 'option']);

  function destination(event) {
    if (!event.isTrusted || event.button !== 0 || event.defaultPrevented || !event.cancelable ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;

    // composedPath also finds links inside open shadow roots and clicked SVG icons.
    let anchor;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node.isContentEditable || actionRoles.has(node.getAttribute('role')?.toLowerCase()) ||
          node.matches('button, input, select, textarea, [aria-disabled="true"], [data-link-new-tab-ignore]')) return null;
      if (node.matches('a[href], area[href]')) {
        anchor = node;
        break;
      }
    }
    if (!anchor || anchor.hasAttribute('download') || anchor.isContentEditable) return null;
    const raw = anchor.getAttribute('href')?.trim();
    if (!raw) return null;
    const url = LinkNewTab.webUrl(raw, anchor.baseURI);
    if (!url) return null;

    // Preserve hash navigation (including hash-based SPA routes) in the same document.
    const current = LinkNewTab.webUrl(location.href);
    if (current && raw.includes('#') && url.origin === current.origin &&
        url.pathname === current.pathname && url.search === current.search) return null;

    return url.href;
  }

  function showFailure(url) {
    notice?.remove();
    notice = document.createElement('div');
    notice.setAttribute('data-link-new-tab-ignore', '');
    const shadow = notice.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:340px;padding:16px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#172033;font:14px/1.6 system-ui;box-shadow:0 8px 30px #0003';
    const message = document.createElement('p');
    message.style.margin = '0 0 8px';
    message.textContent = '链接新开：未能打开标签页。请刷新页面后重试，或使用下方链接。';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '打开链接 ↗';
    link.style.cssText = 'color:#2563eb;margin-right:20px';
    const close = document.createElement('button');
    close.textContent = '关闭提示';
    close.addEventListener('click', () => notice?.remove());
    box.append(message, link, close);
    shadow.append(box);
    (document.body || document.documentElement).append(notice);
  }

  window.addEventListener('click', event => {
    if (!ready || !LinkNewTab.enabledOn(config, host) || !chrome.runtime?.id) return;
    const url = destination(event);
    if (!url) return;
    let pending;
    try {
      pending = chrome.runtime.sendMessage({ type: 'OPEN_LINK', url, topOrigin });
    } catch {
      // A synchronous failure has not cancelled the original click.
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    pending.then(response => {
      if (!response?.ok) showFailure(url);
    }, () => showFailure(url));
  }, { capture: true, passive: false });

  void initialize();
})();
