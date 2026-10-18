(() => {
  // Independent from link handling: turning links off must not close a video.
  const videos = new Set();
  const visibleVideos = new Set();
  const playingVideos = new Set();
  const pendingRoots = new Set();
  const observedSizes = new Set();
  const mediaEvents = ['play', 'pause', 'ended', 'loadedmetadata', 'loadeddata', 'emptied', 'resize', 'enterpictureinpicture', 'leavepictureinpicture'];
  let layoutNodes = new Set();
  let selected = null;
  let host, button, status, panel;
  let busy = false;
  let discoveryTimer, positionFrame, refreshFrame, refreshTimer, highlightTimer;
  let lastRefresh = 0;
  let layoutListening = false;
  let attributesListening = false;
  let needsPrune = false;
  let disposed = false;
  let suspended = false;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRefresh) : null;
  const attributeObserver = new MutationObserver(scheduleRefresh);
  const intersectionObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (!isActive() || suspended || document.hidden) return;
    for (const entry of entries) {
      if (!videos.has(entry.target)) continue;
      if (entry.isIntersecting) visibleVideos.add(entry.target);
      else visibleVideos.delete(entry.target);
    }
    scheduleRefresh();
  }) : null;

  function isActive() {
    if (disposed) return false;
    try { if (chrome.runtime?.id) return true; } catch { /* Invalidated extension world. */ }
    dispose();
    return false;
  }

  function suspend() {
    suspended = true;
    observer.disconnect();
    attributeObserver.disconnect();
    attributesListening = false;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    observedSizes.clear();
    visibleVideos.clear();
    window.removeEventListener('resize', scheduleRefresh);
    window.removeEventListener('scroll', scheduleRefresh, true);
    document.removeEventListener('fullscreenchange', scheduleRefresh);
    layoutListening = false;
    clearTimeout(discoveryTimer);
    clearTimeout(refreshTimer);
    cancelAnimationFrame(refreshFrame);
    cancelAnimationFrame(positionFrame);
    discoveryTimer = refreshTimer = refreshFrame = positionFrame = null;
    pendingRoots.clear();
    needsPrune = false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    suspend();
    clearTimeout(highlightTimer);
    for (const video of videos) untrackVideo(video);
    layoutNodes.clear();
    playingVideos.clear();
    document.removeEventListener('visibilitychange', updateVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Already invalidated. */ }
    button?.removeEventListener('click', togglePictureInPicture);
    host?.remove();
    selected = host = button = status = panel = null;
    // Removing our controls must not interrupt native playback or Picture-in-Picture.
  }

  const messages = {
    'no-video': '当前页面没有找到视频，请先打开并播放一个视频。',
    'not-ready': '视频尚未加载画面，请先播放几秒，再点击小窗播放。',
    'disabled': '这个视频的网页设置禁止画中画，可尝试播放器自带的小窗功能。',
    'policy': '此页面或嵌入播放器不允许画中画。请打开视频原始网页后再试。',
    'not-supported': '当前浏览器或系统没有开放视频画中画。',
    'fullscreen': '请先退出全屏，再点击视频上的小窗播放。',
    'gesture': '请直接点击视频上的“小窗播放”按钮后重试。',
    'failed': '暂时无法打开视频小窗，请重新播放视频后再试。'
  };

  function reason(video) {
    if (!video) return 'no-video';
    if (typeof video.requestPictureInPicture !== 'function') return 'not-supported';
    if (!document.pictureInPictureEnabled) return 'policy';
    if (video.disablePictureInPicture) return 'disabled';
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return 'not-ready';
    if (document.fullscreenElement?.tagName === 'VIDEO') return 'fullscreen';
    return null;
  }

  function visibleArea(video, r = video.getBoundingClientRect()) {
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return 0;
    return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  }

  function chooseVideo(forceScan = false) {
    if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
    let best = null, bestArea = 0, bestPlaying = false;
    // The browser maintains viewport membership; off-screen feeds need no
    // synchronous layout reads on each scroll. Explicit popup requests can scan.
    const candidates = forceScan || !intersectionObserver ? videos : visibleVideos;
    for (const video of candidates) {
      if (!video.isConnected) continue;
      const area = visibleArea(video);
      if (!area) continue;
      const playing = playingVideos.has(video);
      if (!best || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) {
        best = video;
        bestArea = area;
        bestPlaying = playing;
      }
    }
    if (best) return best;
    for (const video of playingVideos) if (video.isConnected) return video;
    return null;
  }

  function setStatus(text = '') {
    if (!status) return;
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
  }

  function createControls() {
    if (host) return;
    host = document.createElement('link-new-tab-video-tools');
    host.setAttribute('data-link-new-tab-ignore', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;width:max-content!important;max-width:calc(100vw - 16px)!important;pointer-events:auto!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .panel { width: max-content; max-width: min(320px, calc(100vw - 16px)); text-align: right; font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; }
      button { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #ffffff70; border-radius: 8px; padding: 7px 11px; color: #fff; background: #17243deb; box-shadow: 0 2px 9px #0003; font: inherit; cursor: pointer; white-space: nowrap; }
      button:hover { background: #2563eb; }
      button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .7; }
      svg { width: 18px; height: 18px; }
      p { margin: 7px 0 0; padding: 10px 12px; border-radius: 8px; background: #fff; color: #172033; text-align: left; box-shadow: 0 2px 12px #0003; }
      p[hidden] { display: none; }
      .highlight button { background: #2563eb; outline: 3px solid #93c5fd; outline-offset: 3px; }
    `;
    panel = document.createElement('div');
    panel.className = 'panel';
    button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'pip';
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg><span>小窗播放</span>';
    status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    // Direct click -> requestPictureInPicture, with no async messaging before it.
    button.addEventListener('click', togglePictureInPicture);
    panel.append(button, status);
    shadow.append(style, panel);
  }

  function positionControls() {
    positionFrame = null;
    if (!isActive() || suspended || document.hidden || !host || !selected) return;
    const r = selected.getBoundingClientRect();
    const onScreen = visibleArea(selected, r) > 0;
    const panelRect = panel.getBoundingClientRect();
    const width = panelRect.width || 120;
    const height = panelRect.height || 36;
    const x = onScreen ? r.right - width - 12 : innerWidth - width - 20;
    const y = onScreen ? r.top + 12 : innerHeight - height - 20;
    const left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    const top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
    if (host.style.left !== left) host.style.setProperty('left', left, 'important');
    if (host.style.top !== top) host.style.setProperty('top', top, 'important');
  }

  function schedulePosition() {
    if (isActive() && !suspended && !document.hidden && !positionFrame) positionFrame = requestAnimationFrame(positionControls);
  }

  function scheduleRefresh() {
    if (!isActive() || suspended || document.hidden || (!videos.size && !selected) || refreshFrame || refreshTimer) return;
    // Scrolling and player animations can emit many events in one frame. Keep
    // video selection at most ten times per second, without a polling loop.
    const enqueue = () => {
      refreshTimer = null;
      if (!isActive() || suspended || document.hidden) return;
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = null;
        refresh();
      });
    };
    const wait = Math.max(0, 100 - (performance.now() - lastRefresh));
    if (wait) refreshTimer = setTimeout(enqueue, wait);
    else enqueue();
  }

  function refresh(forceScan = false) {
    if (!isActive() || suspended || document.hidden) return;
    lastRefresh = performance.now();
    const next = busy ? selected : chooseVideo(forceScan);
    if (!next) {
      selected = null;
      if (host) host.style.setProperty('display', 'none', 'important');
      return;
    }
    createControls();
    if (selected !== next) setStatus();
    selected = next;
    // Mount inside the fullscreen player wrapper when possible.
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    host.style.setProperty('display', fullscreen?.tagName === 'VIDEO' ? 'none' : 'block', 'important');
    const active = Boolean(document.pictureInPictureElement);
    const label = active ? '退出小窗' : '小窗播放';
    if (button.querySelector('span').textContent !== label) button.querySelector('span').textContent = label;
    button.setAttribute('aria-label', active ? '退出视频画中画小窗' : '在画中画小窗播放视频');
    button.title = active ? '返回原网页播放器' : '将视频放到独立悬浮窗口';
    button.disabled = busy;
    schedulePosition();
  }

  async function togglePictureInPicture(event) {
    if (!isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted || busy) return;
    const video = selected;
    const exiting = Boolean(document.pictureInPictureElement);
    const blocked = exiting ? null : reason(video);
    if (blocked) {
      setStatus(messages[blocked]);
      schedulePosition();
      return;
    }
    busy = true;
    button.disabled = true;
    setStatus();
    try {
      if (exiting) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (error) {
      if (!isActive()) return;
      const failure = error.name === 'NotAllowedError' ? 'gesture' :
        error.name === 'SecurityError' ? 'policy' :
        error.name === 'NotSupportedError' ? 'not-supported' : reason(video) || 'failed';
      setStatus(messages[failure]);
    } finally {
      busy = false;
      if (isActive()) refresh();
    }
  }

  function onVideoEvent(event) {
    if (!isActive()) return;
    updatePlaying(event.currentTarget);
    if (event.type === 'leavepictureinpicture') setStatus();
    scheduleRefresh();
  }

  function trackVideo(video) {
    if (videos.has(video)) return false;
    videos.add(video);
    for (const name of mediaEvents) video.addEventListener(name, onVideoEvent);
    updatePlaying(video);
    if (!suspended && !document.hidden) intersectionObserver?.observe(video);
    return true;
  }

  function updatePlaying(video) {
    if (!video.paused && !video.ended && video.readyState >= 2) playingVideos.add(video);
    else playingVideos.delete(video);
  }

  function untrackVideo(video) {
    for (const name of mediaEvents) video.removeEventListener(name, onVideoEvent);
    resizeObserver?.unobserve(video);
    intersectionObserver?.unobserve(video);
    observedSizes.delete(video);
    visibleVideos.delete(video);
    playingVideos.delete(video);
    videos.delete(video);
  }

  function sameNodes(a, b) {
    return a.size === b.size && [...a].every(node => b.has(node));
  }

  function syncLayoutTracking() {
    const nextLayoutNodes = new Set();
    for (const video of videos) {
      for (let node = video; node; node = node.parentElement) nextLayoutNodes.add(node);
    }
    const changed = !sameNodes(layoutNodes, nextLayoutNodes);
    layoutNodes = nextLayoutNodes;
    if (suspended || document.hidden) return changed;

    // Observe styles only on videos and their ancestors. A page-wide attribute
    // observer would wake up for unrelated animations and application updates.
    if (changed || !attributesListening) {
      attributeObserver.disconnect();
      for (const node of layoutNodes) {
        attributeObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disablepictureinpicture'] });
      }
      attributesListening = layoutNodes.size > 0;
    }

    const sizes = new Set(videos);
    if (videos.size && document.body) sizes.add(document.body);
    for (const node of observedSizes) {
      if (!sizes.has(node)) {
        resizeObserver?.unobserve(node);
        observedSizes.delete(node);
      }
    }
    for (const node of sizes) {
      if (!observedSizes.has(node)) {
        resizeObserver?.observe(node);
        observedSizes.add(node);
      }
    }
    const needed = videos.size > 0;
    if (layoutListening !== needed) {
      layoutListening = needed;
      const method = needed ? 'addEventListener' : 'removeEventListener';
      window[method]('resize', scheduleRefresh, { passive: true });
      window[method]('scroll', scheduleRefresh, { capture: true, passive: true });
      document[method]('fullscreenchange', scheduleRefresh);
    }
    return changed;
  }

  function pruneVideos() {
    let changed = false;
    for (const video of videos) {
      if (!video.isConnected) {
        untrackVideo(video);
        changed = true;
      }
    }
    return changed;
  }

  function discoverAddedVideos() {
    discoveryTimer = null;
    if (!isActive() || suspended || document.hidden) return;
    let changed = needsPrune && pruneVideos();
    needsPrune = false;
    let ancestryChanged = false;
    for (const root of pendingRoots) {
      if (!root.isConnected) continue;
      // The parser/framework may report both a new parent and its children.
      // Search the outermost added subtree once, never the whole document.
      let covered = false;
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (pendingRoots.has(parent)) { covered = true; break; }
      }
      if (covered) continue;
      if (root instanceof HTMLVideoElement) {
        changed = trackVideo(root) || changed;
        ancestryChanged = true;
      }
      for (const video of root.querySelectorAll('video')) {
        changed = trackVideo(video) || changed;
        ancestryChanged = true;
      }
    }
    pendingRoots.clear();
    const layoutChanged = (changed || ancestryChanged) && syncLayoutTracking();
    if (changed || layoutChanged) scheduleRefresh();
  }

  function onMutations(records) {
    if (!isActive() || suspended || document.hidden) return;
    let needsDiscovery = false;
    let layoutChanged = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node === host || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node instanceof HTMLVideoElement || node.childElementCount) {
          pendingRoots.add(node);
          needsDiscovery = true;
        }
      }
      // A removed video or one of its known ancestors requires reconciliation.
      // Removing an unrelated feed item must not walk every video's ancestors.
      if (videos.size && [...record.removedNodes].some(node => layoutNodes.has(node))) {
        needsPrune = true;
        needsDiscovery = true;
      }
      if (layoutNodes.has(record.target) && [...record.addedNodes, ...record.removedNodes].some(node => node !== host)) layoutChanged = true;
    }
    if (needsDiscovery && !discoveryTimer) discoveryTimer = setTimeout(discoverAddedVideos, 120);
    if (layoutChanged) scheduleRefresh();
  }

  function synchronizeVideos(forceScan = false) {
    if (!isActive() || suspended || document.hidden) return;
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
    pendingRoots.clear();
    needsPrune = false;
    pruneVideos();
    // A full search is only needed on startup, returning to a hidden tab, or
    // an explicit request from the extension popup.
    for (const video of document.querySelectorAll('video')) trackVideo(video);
    syncLayoutTracking();
    refresh(forceScan);
  }

  function onMessage(message, sender, sendResponse) {
    if (!isActive()) return false;
    if (sender.id !== chrome.runtime.id || message?.type !== 'PIP_SHOW_CONTROLS') return false;
    synchronizeVideos(true);
    const blocked = reason(selected);
    const result = { ok: !blocked, count: videos.size, reason: blocked };
    if (host && selected) {
      clearTimeout(highlightTimer);
      panel.classList.add('highlight');
      setStatus(blocked ? messages[blocked] : '点击上方“小窗播放”，视频会在独立窗口中播放。');
      schedulePosition();
      highlightTimer = setTimeout(() => {
        if (!isActive()) return;
        panel.classList.remove('highlight');
        setStatus();
        schedulePosition();
      }, 8000);
    }
    sendResponse(result);
    // Popup aggregates all frames, so an empty top frame cannot mask an embedded video.
    if (typeof message.requestId === 'string') {
      chrome.runtime.sendMessage({ type: 'PIP_CONTROL_RESULT', requestId: message.requestId, result }).catch(() => {});
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  const observer = new MutationObserver(onMutations);
  function updateVisibility() {
    if (!isActive()) return;
    if (!document.hidden) {
      suspended = false;
      observer.observe(document, { childList: true, subtree: true });
      for (const video of videos) {
        updatePlaying(video);
        intersectionObserver?.observe(video);
      }
      synchronizeVideos();
      return;
    }
    // Keep native media/PiP event listeners, but pause discovery and all layout
    // work for background tabs. Resume with one reconciliation when visible.
    suspend();
  }
  function onFocus() { isActive(); }
  function onPageHide(event) {
    if (!isActive()) return;
    if (event.persisted) suspend();
    else dispose();
  }
  function onPageShow(event) {
    if (!isActive()) return;
    if (event.persisted) updateVisibility();
  }
  document.addEventListener('visibilitychange', updateVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  updateVisibility();
})();
