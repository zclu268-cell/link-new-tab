(() => {
  // Independent from link handling: turning links off must not close a video.
  let videos = [];
  const watched = new WeakSet();
  let selected = null;
  let host, button, status, panel;
  let busy = false;
  let scanTimer, positionFrame, refreshFrame, highlightTimer;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRefresh) : null;

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

  function visibleArea(video) {
    const r = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return 0;
    return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  }

  function chooseVideo() {
    if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
    const candidates = videos.filter(video => video.isConnected).map(video => ({
      video, area: visibleArea(video), playing: !video.paused && !video.ended && video.readyState >= 2
    })).filter(item => item.area > 0 || item.playing);
    const visible = candidates.filter(item => item.area > 0);
    const pool = visible.length ? visible : candidates;
    pool.sort((a, b) => Number(b.playing) - Number(a.playing) || b.area - a.area);
    return pool[0]?.video || null;
  }

  function setStatus(text = '') {
    if (!status) return;
    status.textContent = text;
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
    if (!host || !selected) return;
    const r = selected.getBoundingClientRect();
    const onScreen = visibleArea(selected) > 0;
    const panelRect = panel.getBoundingClientRect();
    const width = panelRect.width || 120;
    const height = panelRect.height || 36;
    const x = onScreen ? r.right - width - 12 : innerWidth - width - 20;
    const y = onScreen ? r.top + 12 : innerHeight - height - 20;
    host.style.setProperty('left', `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`, 'important');
    host.style.setProperty('top', `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`, 'important');
  }

  function schedulePosition() {
    if (!positionFrame) positionFrame = requestAnimationFrame(positionControls);
  }

  function scheduleRefresh() {
    if (!refreshFrame) refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null;
      refresh();
    });
  }

  function refresh() {
    const next = busy ? selected : chooseVideo();
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
    button.querySelector('span').textContent = active ? '退出小窗' : '小窗播放';
    button.setAttribute('aria-label', active ? '退出视频画中画小窗' : '在画中画小窗播放视频');
    button.title = active ? '返回原网页播放器' : '将视频放到独立悬浮窗口';
    button.disabled = busy;
    schedulePosition();
  }

  async function togglePictureInPicture(event) {
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
      const failure = error.name === 'NotAllowedError' ? 'gesture' :
        error.name === 'SecurityError' ? 'policy' :
        error.name === 'NotSupportedError' ? 'not-supported' : reason(video) || 'failed';
      setStatus(messages[failure]);
    } finally {
      busy = false;
      refresh();
    }
  }

  function scan() {
    scanTimer = null;
    for (const video of videos) {
      if (!video.isConnected) resizeObserver?.unobserve(video);
    }
    videos = [...document.querySelectorAll('video')];
    for (const video of videos) {
      resizeObserver?.observe(video);
      if (watched.has(video)) continue;
      watched.add(video);
      for (const name of ['play', 'pause', 'ended', 'loadedmetadata', 'loadeddata', 'emptied', 'resize', 'enterpictureinpicture', 'leavepictureinpicture']) {
        video.addEventListener(name, () => {
          if (name === 'leavepictureinpicture') setStatus();
          refresh();
        });
      }
    }
    refresh();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 150);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'PIP_SHOW_CONTROLS') return false;
    scan();
    const blocked = reason(selected);
    const result = { ok: !blocked, count: videos.length, reason: blocked };
    if (host && selected) {
      clearTimeout(highlightTimer);
      panel.classList.add('highlight');
      setStatus(blocked ? messages[blocked] : '点击上方“小窗播放”，视频会在独立窗口中播放。');
      schedulePosition();
      highlightTimer = setTimeout(() => { panel.classList.remove('highlight'); setStatus(); schedulePosition(); }, 8000);
    }
    sendResponse(result);
    // Popup aggregates all frames, so an empty top frame cannot mask an embedded video.
    if (typeof message.requestId === 'string') {
      chrome.runtime.sendMessage({ type: 'PIP_CONTROL_RESULT', requestId: message.requestId, result }).catch(() => {});
    }
    return false;
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'hidden', 'disablepictureinpicture'] });
  window.addEventListener('resize', scheduleScan, { passive: true });
  window.addEventListener('scroll', scheduleRefresh, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
  // Detect resizing players and SPA layout changes without inspecting every DOM node.
  if (resizeObserver) {
    const watchDocumentSize = () => { if (document.body) resizeObserver.observe(document.body); };
    if (document.body) watchDocumentSize();
    else document.addEventListener('DOMContentLoaded', watchDocumentSize, { once: true });
  }
  scan();
})();
