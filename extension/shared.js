/* Shared by the service worker and the isolated content script. */
globalThis.LinkNewTab = (() => {
  const defaults = { enabled: true, active: true, excludedHosts: [] };

  function settings(value = {}) {
    return {
      enabled: value.enabled !== false,
      active: value.active !== false,
      excludedHosts: Array.isArray(value.excludedHosts)
        ? [...new Set(value.excludedHosts.filter(x => typeof x === 'string').map(x => x.toLowerCase()))]
        : []
    };
  }

  function webUrl(value, base) {
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  function hostname(value) {
    return webUrl(value)?.hostname || '';
  }

  function enabledOn(config, host) {
    return config.enabled && !config.excludedHosts.includes(host.toLowerCase());
  }

  return { defaults, settings, webUrl, hostname, enabledOn };
})();
