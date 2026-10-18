const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { delay, harness, listenLocal, report, sanitize } = require('./helpers.cjs');

const run = harness('lifecycle');
const extensionPath = path.resolve(__dirname, '../extension');
const hostSelector = 'link-new-tab-video-tools';
const buttonSelector = hostSelector + ' button[data-action="pip"]';
const results = [], measurements = {}, temporaryDirectories = [];
let context, origin, extensionId;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Video lifecycle fixture</title>
  <style>body{margin:20px;height:3000px}video{display:block;width:640px;height:360px;background:#17243d}#churn{height:100px;overflow:hidden}</style></head>
  <body><main id="videos"></main><aside id="churn"></aside><script>
  window.addVideo = async () => {
    const video = document.createElement('video');
    video.id = 'video'; video.muted = true; video.playsInline = true;
    document.querySelector('#videos').append(video);
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const paint = canvas.getContext('2d'); let count = 0;
    const draw = () => { paint.fillStyle = '#17243d'; paint.fillRect(0,0,640,360); paint.fillStyle = '#fff'; paint.fillRect(count++ % 600,100,40,40); };
    draw(); const timer = setInterval(draw, 50), stream = canvas.captureStream(20);
    video.srcObject = stream;
    window.stopFixture = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); };
    await video.play();
  };
  </script></body></html>`);
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(run.output(prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function workerNamed(filename) {
  return context.serviceWorkers().find(worker => worker.url().endsWith('/' + filename)) ||
    context.waitForEvent('serviceworker', { predicate: worker => worker.url().endsWith('/' + filename), timeout:15000 });
}

// Inspect native listener registrations, not source-level implementation state.
// Native DOM method wrappers count work only in this extension's isolated world.
async function instrument(page) {
  const session = await context.newCDPSession(page), worlds = [], scriptUrls = new Map();
  session.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
  session.on('Debugger.scriptParsed', script => scriptUrls.set(script.scriptId, script.url));
  await session.send('Runtime.enable');
  await session.send('Debugger.enable');
  let world;
  for (const candidate of worlds) {
    if (candidate.auxData?.isDefault) continue;
    const probe = await session.send('Runtime.evaluate', { contextId:candidate.id, expression:'globalThis.chrome?.runtime?.id', returnByValue:true });
    if (probe.result.value === extensionId) { world = candidate; break; }
  }
  assert(world, 'The real extension isolated world must be available');
  const evaluate = async (expression, returnByValue = true) => {
    const response = await session.send('Runtime.evaluate', { contextId:world.id, expression, returnByValue });
    assert(!response.exceptionDetails, 'Isolated-world probe failed: ' + JSON.stringify(response.exceptionDetails));
    return returnByValue ? response.result.value : response.result;
  };
  await evaluate(`(() => {
    const state = globalThis.__lifecycleProbe = { counts:{ videoRectReads:0, subtreeVideoQueries:0, documentVideoQueries:0, timerCallbacks:0, frameCallbacks:0 }, timers:new Set(), frames:new Set() };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() { if (this instanceof HTMLVideoElement) state.counts.videoRectReads++; return Reflect.apply(rect,this,arguments); };
    for (const [prototype, counter] of [[Element.prototype,'subtreeVideoQueries'],[Document.prototype,'documentVideoQueries']]) {
      const query = prototype.querySelectorAll;
      prototype.querySelectorAll = function(selector) { if (selector === 'video') state.counts[counter]++; return Reflect.apply(query,this,arguments); };
    }
    const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      if (typeof callback !== 'function') return timeout(callback, delay, ...args);
      const id = timeout(() => { state.timers.delete(id); state.counts.timerCallbacks++; callback(...args); }, delay);
      state.timers.add(id); return id;
    };
    globalThis.clearTimeout = function(id) { state.timers.delete(id); return clear(id); };
    const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = function(callback) {
      const id = raf(time => { state.frames.delete(id); state.counts.frameCallbacks++; callback(time); });
      state.frames.add(id); return id;
    };
    globalThis.cancelAnimationFrame = function(id) { state.frames.delete(id); return cancel(id); };
  })()`);
  return {
    evaluate,
    reset: () => evaluate('Object.keys(__lifecycleProbe.counts).forEach(key => __lifecycleProbe.counts[key] = 0)'),
    read: () => evaluate('({runtimeId:chrome.runtime.id || null, counts:{...__lifecycleProbe.counts}, pendingTimers:__lifecycleProbe.timers.size, pendingFrames:__lifecycleProbe.frames.size})'),
    listeners: async expression => {
      const target = await evaluate(expression, false);
      assert(target.objectId, 'Listener target must be an object');
      try {
        const response = await session.send('DOMDebugger.getEventListeners', { objectId:target.objectId });
        return response.listeners.filter(listener => scriptUrls.get(listener.scriptId) === `chrome-extension://${extensionId}/video.js`)
          .map(({ type, useCapture }) => ({ type, useCapture })).sort((a,b) => a.type.localeCompare(b.type));
      } finally { await session.send('Runtime.releaseObject', { objectId:target.objectId }); }
    },
    close: () => session.detach(),
  };
}

async function fixture() {
  const page = await context.newPage();
  await page.goto(origin); await page.bringToFront(); await delay(250);
  const probe = await instrument(page);
  await page.evaluate(() => window.addVideo());
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);
  await page.locator(buttonSelector).waitFor({ state:'visible', timeout:5000 });
  await delay(250);
  await probe.evaluate('globalThis.__lifecycleVideo = document.querySelector("#video")');
  return { page, probe };
}

async function exercise(page) {
  await page.evaluate(async () => {
    for (let index = 0; index < 6; index++) {
      document.querySelector('#churn').innerHTML = '<section><span>' + index + '</span></section>';
      window.scrollTo(0, index % 2 ? 120 : 0);
      window.dispatchEvent(new Event('resize'));
      document.querySelector('#video').dispatchEvent(new Event('loadedmetadata'));
      await new Promise(resolve => setTimeout(resolve, 160));
    }
  });
  await delay(350);
}

async function assertDisposed(page, probe, label, runtimeInvalid = true) {
  // Liveness checks are event-driven. A static old page may keep inert controls
  // until its next DOM/media/layout/visibility event; no permanent poll is needed.
  await exercise(page);
  await page.waitForFunction(() => !document.querySelector('link-new-tab-video-tools'), null, { timeout:5000 });
  const detachedState = await probe.read();
  assert.equal(detachedState.runtimeId, runtimeInvalid ? null : extensionId,
    runtimeInvalid ? 'The old world must actually have lost its extension context' : 'A pagehide input does not invalidate the extension itself');
  assert.equal(detachedState.pendingTimers, 0, 'Pending content-script timers must be cancelled');
  assert.equal(detachedState.pendingFrames, 0, 'Pending content-script animation frames must be cancelled');
  assert.deepEqual(await probe.listeners('__lifecycleVideo'), [], 'Video media event listeners must be removed');
  assert.deepEqual(await probe.listeners('window'), [], 'Window layout/focus listeners must be removed');
  assert.deepEqual(await probe.listeners('document'), [], 'Document lifecycle listeners must be removed');
  await probe.reset();
  await exercise(page);
  const settled = await probe.read();
  measurements[label] = { detachedState, settled };
  assert.deepEqual(settled.counts, { videoRectReads:0, subtreeVideoQueries:0, documentVideoQueries:0, timerCallbacks:0, frameCallbacks:0 },
    'A disposed old world must do no further video discovery/layout/timer/frame work');
  assert.equal(await page.locator(hostSelector).count(), 0);
}

async function test(name, action) {
  try { await action(); results.push({ name, passed:true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed:false, error:sanitize(error.stack) }); console.log('FAIL ' + name + '\n' + sanitize(error.stack)); }
}

(async () => {
  ({ origin } = await listenLocal(server));
  // This helper exists only inside the isolated test profile. The product
  // manifest never receives management permission or helper source files.
  const managerPath = temporaryDirectory('manager-');
  fs.writeFileSync(path.join(managerPath, 'manifest.json'), JSON.stringify({ manifest_version:3, name:'Lifecycle test controller', version:'1.0.0', permissions:['management'], background:{ service_worker:'manager.js' } }));
  fs.writeFileSync(path.join(managerPath, 'manager.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
  const loadedExtensions = extensionPath + ',' + managerPath;
  context = await chromium.launchPersistentContext(temporaryDirectory('profile-'), {
    channel:'chromium', headless:true, viewport:{ width:1100, height:850 },
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath:process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args:['--disable-extensions-except=' + loadedExtensions, '--load-extension=' + loadedExtensions, '--autoplay-policy=no-user-gesture-required'],
  });
  let worker = await workerNamed('background.js');
  const manager = await workerNamed('manager.js');
  extensionId = new URL(worker.url()).host;
  const browserVersion = context.browser().version();
  let current = await fixture();

  await test('有效扩展：动态视频的真实点击仍可进入并退出原生画中画', async () => {
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => document.pictureInPictureElement?.id === 'video', null, { timeout:5000 });
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => !document.pictureInPictureElement, null, { timeout:5000 });
    const counts = (await current.probe.read()).counts;
    assert(counts.videoRectReads > 0, 'Instrumentation must observe actual video work');
  });

  await test('移除的视频释放媒体监听；反复插回同一节点不重复注册监听', async () => {
    const initial = await current.probe.listeners('__lifecycleVideo');
    assert(initial.length > 0, 'Native CDP inspection must observe real extension video listeners');
    assert.equal(new Set(initial.map(listener => listener.type)).size, initial.length, 'Each media event should have one handler');
    for (let round = 0; round < 3; round++) {
      await current.page.evaluate(() => { window.savedVideo = document.querySelector('#video'); savedVideo.remove(); });
      await current.page.locator(buttonSelector).waitFor({ state:'hidden', timeout:5000 });
      await delay(200);
      assert.deepEqual(await current.probe.listeners('__lifecycleVideo'), [], 'Detached video must release its handlers');
      await current.page.evaluate(() => document.querySelector('#videos').append(savedVideo));
      await current.page.locator(buttonSelector).waitFor({ state:'visible', timeout:5000 });
      assert.deepEqual(await current.probe.listeners('__lifecycleVideo'), initial, 'Reinsertion must restore exactly one set of handlers');
    }
    measurements.videoListeners = initial;
  });

  await test('模拟 BFCache persisted 事件：暂停视频任务，pageshow 后恢复尺寸跟随和真实画中画', async () => {
    // This tests lifecycle input handling, not whether Chromium actually chooses
    // to store a page containing live media in its back/forward cache.
    await current.page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:true }));
      document.querySelector('#video').style.cssText = 'width:400px;height:225px';
    });
    await current.probe.reset();
    await exercise(current.page);
    const suspended = await current.probe.read();
    assert.equal(suspended.counts.videoRectReads, 0);
    assert.equal(suspended.counts.subtreeVideoQueries, 0);
    assert.equal(suspended.counts.documentVideoQueries, 0);
    await current.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true })));
    await current.page.waitForFunction(() => {
      const video = document.querySelector('#video').getBoundingClientRect();
      const button = document.querySelector('link-new-tab-video-tools')?.shadowRoot.querySelector('button')?.getBoundingClientRect();
      return button && Math.abs(button.right - video.right + 12) < 2;
    });
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => document.pictureInPictureElement?.id === 'video', null, { timeout:5000 });
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => !document.pictureInPictureElement, null, { timeout:5000 });
    measurements.persistedInput = { suspended, restored:await current.probe.read() };
  });

  await test('模拟非 persisted pagehide：页面退出时永久释放视频任务和控件', async () => {
    const navigating = await fixture();
    try {
      await navigating.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:false })));
      await assertDisposed(navigating.page, navigating.probe, 'pagehideInput', false);
    } finally {
      await navigating.probe.close(); await navigating.page.close();
      await current.page.bringToFront();
    }
  });

  await test('真实 runtime.reload：旧网页移除控件、解绑事件，并停止视频任务', async () => {
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
      await chrome.tabs.sendMessage(tab.id, { type:'PIP_SHOW_CONTROLS' });
    });
    assert((await current.probe.read()).pendingTimers > 0, 'The highlight timeout must really be pending before reload');
    try { await worker.evaluate(() => chrome.runtime.reload()); }
    catch (error) { if (!/closed|destroyed/i.test(error.message)) throw error; }
    await delay(300);
    await assertDisposed(current.page, current.probe, 'reload');
  });

  await current.probe.close(); await current.page.close();
  // Reloaded MV3 workers need not restart until the next extension event.
  // New-page content scripts can initialize without a running service worker.
  measurements.afterReload = await manager.evaluate(async id => {
    const info = await chrome.management.get(id);
    return { enabled:info.enabled, disabledReason:info.disabledReason || null, version:info.version, mayEnable:info.mayEnable };
  }, extensionId);
  // Some Chromium command-line unpacked-extension environments leave a reloaded
  // extension disabled. Record that real state instead of assuming a new worker
  // starts; the controller explicitly re-enables it only after cleanup passed.
  measurements.explicitlyReenabledAfterReload = !measurements.afterReload.enabled;
  if (!measurements.afterReload.enabled) {
    await manager.evaluate(id => chrome.management.setEnabled(id, true), extensionId);
  }
  current = await fixture();
  await test('重载后确认启用（必要时显式重新启用）：新网页恢复视频入口和一组媒体监听', async () => {
    const listeners = await current.probe.listeners('__lifecycleVideo');
    assert(listeners.length > 0);
    assert.equal(new Set(listeners.map(listener => listener.type)).size, listeners.length);
    assert.equal((await current.probe.read()).runtimeId, extensionId);
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => document.pictureInPictureElement?.id === 'video', null, { timeout:5000 });
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => !document.pictureInPictureElement, null, { timeout:5000 });
  });

  await test('真实 management 停用：旧网页解绑全部视频监听并停止后续工作', async () => {
    await current.page.locator(buttonSelector).click();
    await current.page.waitForFunction(() => document.pictureInPictureElement?.id === 'video', null, { timeout:5000 });
    const enabled = await manager.evaluate(async id => {
      await chrome.management.setEnabled(id, false);
      return (await chrome.management.get(id)).enabled;
    }, extensionId);
    assert.equal(enabled, false, 'Chrome must report the target extension disabled');
    await assertDisposed(current.page, current.probe, 'disable');
    assert.equal(await current.page.evaluate(() => document.pictureInPictureElement?.id), 'video', 'Cleanup must preserve native Picture-in-Picture');
    await current.page.evaluate(() => document.exitPictureInPicture());
  });
  await current.probe.close();

  const summary = report(results, browserVersion, '视频内容脚本生命周期回归',
    '在真实 Chromium 临时配置中验证动态视频画中画、移除/复用节点的原生监听器注册，以及真实 runtime.reload 和辅助测试扩展 chrome.management.setEnabled(false) 后的清理。' +
    'pagehide/pageshow 使用明确模拟的 PageTransitionEvent persisted 输入，验证暂停/恢复和页面退出逻辑，不代表浏览器实际命中 BFCache。' +
    '重载后通过 management 读取真实启用状态；若命令行加载环境将扩展留在停用状态，先完成旧 world 清理断言，再显式重新启用以独立测试新网页恢复和下一次真实停用。' +
    '失效检测由下一次页面事件触发；不使用轮询，也不承诺静止页面立即清除控件。通过 CDP 读取原始内容脚本 world 的原生事件监听和 DOM/计时/帧回调计数。' +
    'management 权限只存在于临时测试辅助扩展；不修改产品权限，也不使用用户 Chrome 配置。');
  run.writeJson('results.json', { ...summary.json, measurements });
  run.writeText('results.md', summary.markdown);
  if (summary.passed !== results.length) process.exitCode = 1;
})().catch(error => { console.error(sanitize(error.stack)); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const outputDirectory = fs.realpathSync(path.dirname(run.output('unused')));
  for (const directory of temporaryDirectories) {
    const resolved = fs.realpathSync(directory), relative = path.relative(outputDirectory, resolved);
    if (path.isAbsolute(relative) || relative.includes(path.sep) || !/^(?:manager|profile)-/.test(relative)) {
      throw Error('Refusing to remove a temporary directory outside lifecycle test output');
    }
    fs.rmSync(resolved, { recursive:true, force:true, maxRetries:5, retryDelay:200 });
  }
});
