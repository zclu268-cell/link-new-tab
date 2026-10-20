/* Shared by the service worker and the isolated content script. */
globalThis.LinkNewTab = (() => {
  const defaults = { enabled: true, active: true, videoAuto: false, excludedHosts: [] };

  function settings(value = {}) {
    return {
      enabled: value.enabled !== false,
      active: value.active !== false,
      videoAuto: value.videoAuto === true,
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

  function nativeLinksOn(host) {
    const name = host.toLowerCase().replace(/\.$/, "");
    return name === "chatgpt.com" || name.endsWith(".chatgpt.com") || name === "chat.openai.com";
  }

  function enabledOn(config, host) {
    return config.enabled && !nativeLinksOn(host) && !config.excludedHosts.includes(host.toLowerCase());
  }

  return { defaults, settings, webUrl, hostname, nativeLinksOn, enabledOn };
})();
