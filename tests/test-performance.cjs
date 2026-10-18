const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { delay, harness, listenLocal, report, sanitize } = require('./helpers.cjs');

const root = path.resolve(__dirname, '..');
const run = harness('performance');
const baselineIndex = process.argv.indexOf('--baseline-video');
const baselineFile = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
if (baselineIndex >= 0 && !baselineFile) throw Error('--baseline-video requires a saved video.js file');
const mode = baselineFile ? 'baseline' : 'current';
const results = [];
const measurements = {};
const temporaryDirectories = [];
const rounds = 12;
let context;

// This fixture uses no remote resources. Its fixed-size churn area prevents
// unrelated DOM changes from resizing the video or the document body.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Performance fixture</title>
  <style>body{margin:20px;height:1700px}#churn{height:160px;width:600px;overflow:hidden;contain:strict}
  video{display:block;width:640px;height:360px;background:#17243d}#stable{height:20px;overflow:hidden}</style></head>
  <body><div id="player"></div><div id="churn"></div><div id="stable">${'<span>text</span>'.repeat(12000)}</div></body></html>`);
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(run.output(prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// Instrument the actual extension isolated world, not the page world and not a
// reimplementation of video.js. Native DOM calls still run with their original
// arguments/receivers. Only calls made by the content scripts are counted.
async function instrument(page, extensionId) {
  const session = await context.newCDPSession(page);
  const worlds = [];
  session.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
  await session.send('Runtime.enable');
  let world;
  for (const candidate of worlds) {
    if (candidate.auxData?.isDefault) continue;
    const response = await session.send('Runtime.evaluate', {
      contextId: candidate.id,
      expression: 'globalThis.chrome?.runtime?.id',
      returnByValue: true,
    });
    if (response.result.value === extensionId) { world = candidate; break; }
  }
  assert(world, 'The real extension content-script isolated world must exist');
  const evaluate = async expression => {
    const response = await session.send('Runtime.evaluate', { contextId: world.id, expression, returnByValue: true });
    assert(!response.exceptionDetails, 'Instrumentation failed: ' + JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await evaluate(`(() => {
    const counts = {
      documentVideoQueries:0, subtreeVideoQueries:0, videoRectReads:0, offscreenVideoRectReads:0,
      videoStyleReads:0, videoParentReads:0, videoConnectionReads:0, parentElementReads:0, documentQueryMs:0
    };
    globalThis.__linkNewTabPerformance = counts;
    globalThis.__linkNewTabLastMeasuredVideo = '';
    const documentQuery = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(selector) {
      if (selector !== 'video') return Reflect.apply(documentQuery, this, arguments);
      counts.documentVideoQueries++;
      const start = performance.now();
      try { return Reflect.apply(documentQuery, this, arguments); }
      finally { counts.documentQueryMs += performance.now() - start; }
    };
    const elementQuery = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function(selector) {
      if (selector === 'video') counts.subtreeVideoQueries++;
      return Reflect.apply(elementQuery, this, arguments);
    };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      const value = Reflect.apply(rect, this, arguments);
      if (this instanceof HTMLVideoElement) {
        counts.videoRectReads++;
        globalThis.__linkNewTabLastMeasuredVideo = this.id;
        if (value.bottom <= 0 || value.top >= innerHeight || value.right <= 0 || value.left >= innerWidth) counts.offscreenVideoRectReads++;
      }
      return value;
    };
    const computedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = function(element) {
      if (element instanceof HTMLVideoElement) counts.videoStyleReads++;
      return Reflect.apply(computedStyle, this, arguments);
    };
    // Video parent reads expose rebuilding every tracked video's ancestor chain
    // even when no layout method is called. Preserve the native getter exactly.
    const parent = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement');
    Object.defineProperty(Node.prototype, 'parentElement', { ...parent, get() {
      counts.parentElementReads++;
      if (this instanceof HTMLVideoElement) counts.videoParentReads++;
      return Reflect.apply(parent.get, this, []);
    } });
    const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected');
    Object.defineProperty(Node.prototype, 'isConnected', { ...connected, get() {
      if (this instanceof HTMLVideoElement) counts.videoConnectionReads++;
      return Reflect.apply(connected.get, this, []);
    } });
  })()`);
  return {
    read: () => evaluate('({...globalThis.__linkNewTabPerformance, lastMeasuredVideo:globalThis.__linkNewTabLastMeasuredVideo})'),
    reset: () => evaluate("Object.keys(globalThis.__linkNewTabPerformance).forEach(key => globalThis.__linkNewTabPerformance[key] = 0); globalThis.__linkNewTabLastMeasuredVideo = ''"),
  };
}

async function test(name, action) {
  try { await action(); results.push({ name, passed:true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed:false, error:sanitize(error.stack) }); console.log('FAIL ' + name + '\n' + sanitize(error.stack)); }
}

async function collect(counter, name, action) {
  await counter.reset();
  await action();
  await delay(500); // Let scheduled work settle before reading operation counts.
  const value = await counter.read();
  measurements[name] = value;
  console.log(name + ' ' + JSON.stringify(value));
  return value;
}

async function churn(page, kind = 'children') {
  await page.evaluate(async ({ rounds, kind }) => {
    const area = document.getElementById('churn');
    for (let round = 0; round < rounds; round++) {
      if (kind === 'children') {
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 100; index++) {
          const row = document.createElement('span');
          row.textContent = round + ':' + index;
          fragment.append(row);
        }
        area.replaceChildren(fragment);
      } else if (kind === 'nested') {
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 15; index++) {
          const component = document.createElement('article');
          component.innerHTML = '<header><span>Title</span></header><div><p><b>Content</b></p><button>Action</button></div>';
          component.dataset.tick = round + ':' + index;
          fragment.append(component);
        }
        area.replaceChildren(fragment);
      } else {
        area.style.color = round % 2 ? 'red' : 'blue';
        area.className = 'unrelated-' + round;
        area.dataset.tick = String(round);
      }
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  }, { rounds, kind });
}

(async () => {
  const { origin } = await listenLocal(server);
  let extensionPath = path.join(root, 'extension');
  if (baselineFile) {
    const source = fs.readFileSync(path.resolve(baselineFile), 'utf8');
    const copy = temporaryDirectory('extension-');
    fs.cpSync(extensionPath, copy, { recursive:true });
    fs.writeFileSync(path.join(copy, 'video.js'), source);
    extensionPath = copy;
  }
  context = await chromium.launchPersistentContext(temporaryDirectory('profile-'), {
    channel:'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath:process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    headless:true,
    viewport:{ width:1100, height:850 },
    args:['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout:15000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(origin);
  await page.bringToFront();
  await delay(700);
  const counter = await instrument(page, extensionId);
  const browserVersion = context.browser().version();

  await test('计数仅覆盖真实扩展 isolated world，不计网页自己的查询', async () => {
    const stats = await collect(counter, 'instrumentationIsolation', () => page.evaluate(() => {
      for (let index = 0; index < 10; index++) document.querySelectorAll('video');
    }));
    assert.equal(stats.documentVideoQueries, 0);
  });
  await test('无视频页面的 1200 个动态节点不触发整页视频重扫', async () => {
    const stats = await collect(counter, 'noVideoDomChurn', () => churn(page));
    if (!baselineFile) assert.equal(stats.documentVideoQueries, 0, 'Unrelated DOM changes must not rescan the whole document');
    assert.equal(stats.videoRectReads, 0);
  });
  await test('无视频页面滚动不读取视频布局，也不重扫页面', async () => {
    const stats = await collect(counter, 'noVideoScroll', () => page.evaluate(async () => {
      for (let index = 0; index < 30; index++) {
        window.scrollTo(0, index % 2 ? 300 : 0);
        await new Promise(requestAnimationFrame);
      }
    }));
    assert.equal(stats.documentVideoQueries, 0);
    assert.equal(stats.videoRectReads, 0);
  });
  await test('动态新增嵌套视频仍显示小窗按钮', async () => {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.getElementById('player').innerHTML = '<section><video id="video"></video></section>';
    });
    await page.locator('link-new-tab-video-tools button[data-action="pip"]').waitFor({ state:'visible', timeout:5000 });
    await delay(700);
    const stats = await counter.read();
    assert(stats.videoRectReads > 0, 'Instrumentation must observe actual video layout reads');
  });
  await test('视频旁的动态内容不反复查询整页或读取视频布局', async () => {
    const stats = await collect(counter, 'videoUnrelatedDomChurn', () => churn(page));
    if (!baselineFile) {
      assert.equal(stats.documentVideoQueries, 0);
      assert.equal(stats.videoRectReads, 0, 'Unrelated fixed-size DOM changes must not refresh the video overlay');
      assert.equal(stats.videoStyleReads, 0);
    }
  });
  await test('无关节点的样式与 class 变化不读取视频布局', async () => {
    const stats = await collect(counter, 'videoUnrelatedStyleChurn', () => churn(page, 'styles'));
    if (!baselineFile) {
      assert.equal(stats.documentVideoQueries, 0);
      assert.equal(stats.videoRectReads, 0);
      assert.equal(stats.videoStyleReads, 0);
    }
  });
  await test('嵌套无视频组件替换只检查新增子树，不重建已有视频祖先追踪', async () => {
    const stats = await collect(counter, 'nestedComponentReplacement', () => churn(page, 'nested'));
    if (!baselineFile) {
      assert.equal(stats.documentVideoQueries, 0);
      assert.equal(stats.videoRectReads, 0);
      assert.equal(stats.videoStyleReads, 0);
      assert.equal(stats.videoParentReads, 0, 'Unrelated nested components must not rebuild the existing video ancestor chain');
      assert(stats.subtreeVideoQueries <= rounds * 15, 'Each newly inserted outer component should be searched at most once');
    }
  });
  await test('纯无关节点移除不重建视频祖先追踪或重新读取视频布局', async () => {
    await page.evaluate(() => {
      const area = document.getElementById('churn');
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 120; index++) {
        const component = document.createElement('section');
        component.innerHTML = '<p><span>Removable content</span></p>';
        fragment.append(component);
      }
      area.replaceChildren(fragment);
    });
    await delay(700);
    const stats = await collect(counter, 'unrelatedSubtreeRemoval', () => page.evaluate(async rounds => {
      const area = document.getElementById('churn');
      for (let round = 0; round < rounds; round++) {
        for (let index = 0; index < 10; index++) area.firstElementChild.remove();
        await new Promise(resolve => setTimeout(resolve, 220));
      }
    }, rounds));
    if (!baselineFile) {
      assert.equal(stats.documentVideoQueries, 0);
      assert.equal(stats.subtreeVideoQueries, 0, 'Removing unrelated nodes does not require video discovery');
      assert.equal(stats.videoParentReads, 0, 'Unrelated removal must not rebuild video ancestor tracking');
      assert.equal(stats.videoRectReads, 0);
    }
  });
  await test('多个视频持续滚动时布局读取有界，停止滚动后不持续刷新', async () => {
    await page.evaluate(() => {
      for (let index = 0; index < 2; index++) {
        const video = document.createElement('video');
        video.style.cssText = 'width:320px;height:180px';
        document.getElementById('player').append(video);
      }
    });
    await delay(700);
    const stats = await collect(counter, 'threeVideoScroll', () => page.evaluate(async () => {
      for (let index = 0; index < 60; index++) {
        window.scrollTo(0, index % 2 ? 320 : 0);
        await new Promise(requestAnimationFrame);
      }
    }));
    assert.equal(stats.documentVideoQueries, 0);
    assert(stats.videoRectReads > 0, 'Real scrolling should update the visible video overlay');
    // Broad operation ceiling detects runaway work without imposing a machine-
    // dependent frame-rate threshold. Before/after counts show throttling gains.
    assert(stats.videoRectReads <= 60 * 20, 'Scrolling must not trigger unbounded layout work');
    const settled = await collect(counter, 'afterVideoScrollIdle', () => delay(500));
    assert.equal(settled.videoRectReads, 0, 'A static page must stop refreshing after scroll settles');
  });
  await test('移除最后一个视频后停止布局读取并隐藏按钮', async () => {
    await page.evaluate(() => document.getElementById('player').replaceChildren());
    await page.locator('link-new-tab-video-tools button[data-action="pip"]').waitFor({ state:'hidden', timeout:5000 });
    await delay(500);
    const stats = await collect(counter, 'removedVideoDomChurn', () => churn(page));
    if (!baselineFile) assert.equal(stats.documentVideoQueries, 0);
    assert.equal(stats.videoRectReads, 0);
    assert.equal(stats.videoStyleReads, 0);
  });
  await test('长列表滚动只测量可见候选，按钮跟随当前可见视频', async () => {
    const videoCount = 120;
    const positions = [7, 0, 23, 65, 117, 4, 91, 37, 115, 58, 16, 106];
    await page.evaluate(count => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < count; index++) {
        const row = document.createElement('section');
        row.style.height = '900px';
        const video = document.createElement('video');
        video.id = 'long-video-' + index;
        row.append(video);
        fragment.append(row);
      }
      document.getElementById('player').replaceChildren(fragment);
      window.scrollTo(0, 0);
    }, videoCount);
    await delay(900);
    const stats = await collect(counter, 'longVideoListScroll', async () => {
      for (const index of positions) {
        await page.evaluate(index => window.scrollTo(0, index * 900), index);
        // The last isolated-world rectangle read must belong to the selected
        // on-screen video, preventing a cheap-but-stale overlay from passing.
        const deadline = Date.now() + 5000;
        let phase;
        do {
          await delay(40);
          phase = await counter.read();
        } while (phase.lastMeasuredVideo !== 'long-video-' + index && Date.now() < deadline);
        assert.equal(phase.lastMeasuredVideo, 'long-video-' + index, 'The overlay must follow the visible candidate after scrolling');
        await page.waitForFunction(id => {
          const video = document.getElementById(id);
          const host = document.querySelector('link-new-tab-video-tools');
          if (!host || getComputedStyle(host).display === 'none') return false;
          const videoRect = video.getBoundingClientRect();
          return videoRect.top >= 0 && videoRect.bottom <= innerHeight && Math.abs(host.getBoundingClientRect().top - videoRect.top - 12) < 2;
        }, 'long-video-' + index, { timeout:5000 });
      }
    });
    if (!baselineFile) {
      assert.equal(stats.documentVideoQueries, 0);
      // One viewport contains at most one full video. Twelve reads per step
      // allow stale observer entries and multiple settling frames, while still
      // rejecting remeasurement of all 120 tracked videos on every scroll.
      assert(stats.videoRectReads <= positions.length * 12, 'Offscreen paused videos must not be measured on every scroll');
      assert(stats.offscreenVideoRectReads <= positions.length * 4, 'Only a few stale viewport candidates may require an offscreen check');
      assert(stats.videoStyleReads <= positions.length * 12);
    }
  });

  const summary = report(results, browserVersion, '内容脚本性能回归',
    '通过 CDP 在真实扩展的 isolated world 包装原生 DOM 方法与 getter，记录视频查询、布局读取及祖先读取次数。' +
    '固定尺寸容器在 12000 个静态节点旁进行 12 轮动态更新，并覆盖嵌套组件替换、无关子树移除和 120 个视频的长列表滚动；断言操作次数，不用不稳定的墙钟耗时作为通过标准。' +
    '这验证本地可重复的性能回归，不代表所有真实网站的加载加速比。' +
    (baselineFile ? ' 本次为旧版采样，性能阈值不作为失败条件。' : ''));
  run.writeJson(mode + '.json', { ...summary.json, mode, rounds, staticNodes:12000, measurements });
  run.writeText(mode + '.md', summary.markdown);
  if (summary.passed !== results.length) process.exitCode = 1;
})().catch(error => { console.error(sanitize(error.stack)); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const outputDirectory = fs.realpathSync(path.dirname(run.output('unused')));
  for (const directory of temporaryDirectories) {
    const resolved = fs.realpathSync(directory);
    const relative = path.relative(outputDirectory, resolved);
    if (path.isAbsolute(relative) || relative.includes(path.sep) || !/^(?:profile|extension)-/.test(relative)) {
      throw Error('Refusing to remove a temporary directory outside performance test output');
    }
    fs.rmSync(resolved, { recursive:true, force:true, maxRetries:5, retryDelay:200 });
  }
});
