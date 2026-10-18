const http = require('node:http');
const assert = require('node:assert/strict');
const { delay, harness, listenLocal, report, sanitize } = require('./helpers.cjs');

const run = harness('pip');
const hostSelector = 'link-new-tab-video-tools';
const buttonSelector = hostSelector + ' button[data-action="pip"]';
const results = [];
let context, worker, origin, crossOrigin;

const server = http.createServer((req, res) => {
  const route = new URL(req.url, origin || 'http://127.0.0.1').pathname;
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (route === '/policy-denied') headers['Permissions-Policy'] = 'picture-in-picture=()';
  res.writeHead(200, headers);
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>PiP browser fixture</title>
  <style>body{margin:24px;font-family:Arial}video{display:block;background:#151b26;margin:12px}iframe{width:760px;height:540px;border:0}</style></head>
  <body><h1>Local video fixture</h1><div id="videos"></div>
  ${route === '/parent' ? `<iframe id="cross" src="${crossOrigin}/fixture" allow="picture-in-picture"></iframe>` : ''}
  <script>
  window.pipEvents = [];
  window.streamCleanups = [];
  window.addVideo = async function(options = {}) {
    const video = document.createElement('video');
    video.id = options.id || 'video';
    video.width = options.width || 640;
    video.height = options.height || 360;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    if (options.disabled) video.disablePictureInPicture = true;
    if (options.hidden) video.style.display = 'none';
    document.querySelector('#videos').append(video);
    video.addEventListener('enterpictureinpicture', () => pipEvents.push({type:'enter',id:video.id}));
    video.addEventListener('leavepictureinpicture', () => pipEvents.push({type:'leave',id:video.id}));
    if (options.unready) return;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const paint = () => { ctx.fillStyle = '#263c69'; ctx.fillRect(0,0,640,360); ctx.fillStyle = '#fff'; ctx.font = '30px Arial'; ctx.fillText(video.id + ' / frame ' + tick++, 36,180); };
    paint();
    const timer = setInterval(paint, 50);
    const stream = canvas.captureStream(20);
    video.srcObject = stream;
    streamCleanups.push(() => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); });
    await video.play();
    if (options.paused) video.pause();
    return video.id;
  };
  </script></body></html>`);
});

async function settings(patch = {}) {
  await worker.evaluate(async values => chrome.storage.local.set(values), { enabled: true, active: true, excludedHosts: [], ...patch });
  await delay(80);
}
async function fixture(route = '/fixture', patch = {}) {
  const oldPages = context.pages();
  const page = await context.newPage();
  for (const old of oldPages) await old.close();
  await settings(patch);
  await page.goto(origin + route);
  await page.bringToFront();
  return page;
}
async function addVideo(page, options = {}) {
  await page.evaluate(options => window.addVideo(options), options);
  if (!options.unready) await page.waitForFunction(id => document.getElementById(id).readyState >= 2, options.id || 'video');
  await delay(350);
}
async function pipId(page) { return page.evaluate(() => document.pictureInPictureElement?.id ?? null); }
async function fixtureHiddenState(page, hidden) {
  // Headless Chromium keeps its tabs visible. Simulate only the visibility
  // input in the extension world; native video and PiP APIs remain unchanged.
  const session = await context.newCDPSession(page);
  const worlds = [];
  session.on('Runtime.executionContextCreated', ({context: world}) => worlds.push(world));
  try {
    await session.send('Runtime.enable');
    for (const world of worlds) {
      if (world.auxData?.isDefault) continue;
      const probe = await session.send('Runtime.evaluate', {contextId:world.id,expression:'globalThis.chrome?.runtime?.id',returnByValue:true});
      if (probe.result.value !== new URL(worker.url()).host) continue;
      const expression = hidden
        ? "Object.defineProperty(document, 'hidden', {configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));"
        : "delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));";
      const result = await session.send('Runtime.evaluate', {contextId:world.id,expression});
      assert(!result.exceptionDetails,'Unable to simulate fixture visibility');
      return;
    }
    throw Error('Extension isolated world not found');
  } finally { await session.detach(); }
}
async function enter(page, expected = 'video') {
  await page.locator(buttonSelector).waitFor({ state:'visible', timeout:5000 });
  await page.locator(buttonSelector).click();
  await page.waitForFunction(id => document.pictureInPictureElement?.id === id, expected, { timeout:5000 });
}
async function leave(page) {
  await page.locator(buttonSelector).click();
  await page.waitForFunction(() => !document.pictureInPictureElement, null, { timeout:5000 });
}
async function test(name, run) {
  try { await run(); results.push({ name, passed:true }); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { results.push({ name, passed:false, error:sanitize(error.stack) }); process.stdout.write('FAIL ' + name + '\n' + sanitize(error.stack) + '\n'); }
}

(async () => {
  ({ origin, crossOrigin } = await listenLocal(server));
  context = await run.launch({
    viewport:{width:1100,height:850},
    args:['--autoplay-policy=no-user-gesture-required'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout:15000});
  const browserVersion = context.browser().version();
  process.stdout.write('Chromium ' + browserVersion + '; extension ' + worker.url() + '\n');

  await test('就绪视频：真实点击进入浏览器画中画，产生进入事件', async () => {
    const page = await fixture();
    await addVideo(page);
    await page.locator(buttonSelector).waitFor({state:'visible'});
    await page.screenshot({path:run.output('pip-controls-preview.png'),fullPage:true});
    assert.equal(await page.evaluate(() => document.pictureInPictureEnabled),true);
    await enter(page);
    assert.equal(await pipId(page),'video');
    assert.deepEqual(await page.evaluate(() => pipEvents),[{type:'enter',id:'video'}]);
    assert.match(await page.locator(buttonSelector).innerText(),/退出/);
  });
  await test('退出小窗：再次点击退出，产生退出事件并恢复按钮', async () => {
    const page = await fixture(); await addVideo(page); await enter(page); await leave(page);
    assert.equal(await pipId(page),null);
    assert.deepEqual(await page.evaluate(() => pipEvents),[{type:'enter',id:'video'},{type:'leave',id:'video'}]);
    assert.match(await page.locator(buttonSelector).innerText(),/小窗播放/);
  });
  await test('进入与退出画中画：原页面不导航、不新增标签页', async () => {
    const page = await fixture(); await addVideo(page); const before = page.url();
    await enter(page); assert.equal(page.url(),before); assert.equal(context.pages().length,1);
    await leave(page); assert.equal(page.url(),before); assert.equal(context.pages().length,1);
  });
  await test('暂停的视频：可进入画中画且不会强制恢复播放', async () => {
    const page = await fixture(); await addVideo(page,{paused:true}); await enter(page);
    assert.equal(await page.locator('#video').evaluate(video => video.paused),true);
    await leave(page);
    assert.equal(await page.locator('#video').evaluate(video => video.paused),true);
  });
  await test('播放状态：进入小窗后暂停不被扩展恢复', async () => {
    const page = await fixture(); await addVideo(page); await enter(page);
    await page.locator('#video').evaluate(video => video.pause()); await delay(300);
    assert.equal(await pipId(page),'video');
    assert.equal(await page.locator('#video').evaluate(video => video.paused),true);
  });
  await test('动态插入视频：无刷新即可发现并进入画中画', async () => {
    const page = await fixture(); await delay(400); await addVideo(page,{id:'dynamic'}); await enter(page,'dynamic');
  });
  await test('同一个视频移除再插回：恢复发现、尺寸跟随和画中画', async () => {
    const page = await fixture(); await addVideo(page,{id:'reused'}); await enter(page,'reused'); await leave(page);
    await page.evaluate(() => { window.savedVideo = document.querySelector('#reused'); savedVideo.remove(); });
    await page.locator(buttonSelector).waitFor({state:'hidden'});
    await page.evaluate(() => { document.querySelector('#videos').append(savedVideo); savedVideo.style.width='400px'; savedVideo.style.height='225px'; });
    await page.locator(buttonSelector).waitFor({state:'visible'});
    await page.waitForFunction(() => {
      const video = document.querySelector('#reused').getBoundingClientRect();
      const button = document.querySelector('link-new-tab-video-tools').shadowRoot.querySelector('button').getBoundingClientRect();
      return Math.abs(button.right - video.right + 12) < 2;
    });
    await enter(page,'reused');
  });
  await test('播放器祖先样式隐藏再显示：恢复暂停视频的入口', async () => {
    const page = await fixture(); await addVideo(page,{paused:true});
    await page.locator(buttonSelector).waitFor({state:'visible'});
    await page.locator('#videos').evaluate(wrapper => { wrapper.style.display='none'; });
    await page.locator(buttonSelector).waitFor({state:'hidden'});
    await page.locator('#videos').evaluate(wrapper => { wrapper.style.display='block'; });
    await enter(page);
  });
  await test('模拟后台可见性状态：恢复后发现替换播放器并进入真实画中画', async () => {
    const page = await fixture(); await addVideo(page,{id:'before-hidden',paused:true});
    await fixtureHiddenState(page,true);
    await page.evaluate(() => document.querySelector('#before-hidden').remove());
    await addVideo(page,{id:'after-hidden',paused:true});
    await fixtureHiddenState(page,false);
    await enter(page,'after-hidden');
  });
  await test('SPA 视频更换：退出后删除旧视频并换路由，选中新视频', async () => {
    const page = await fixture(); await addVideo(page,{id:'old'}); await enter(page,'old'); await leave(page);
    await page.evaluate(() => { document.querySelector('#old').remove(); history.pushState({},'', '/watch?v=second'); });
    await addVideo(page,{id:'replacement'}); await enter(page,'replacement');
    assert.equal(new URL(page.url()).pathname,'/watch');
  });
  await test('链接功能全局关闭：视频画中画仍然可用', async () => {
    const page = await fixture('/fixture',{enabled:false}); await addVideo(page); await enter(page);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled),false);
  });
  await test('链接网站例外：当前网站停用链接新开时仍可画中画', async () => {
    const page = await fixture('/fixture',{excludedHosts:['127.0.0.1']}); await addVideo(page); await enter(page);
  });
  await test('多个视频：优先选择播放中的视频而非更大的暂停视频', async () => {
    const page = await fixture(); await addVideo(page,{id:'large-paused',width:700,height:390,paused:true});
    await addVideo(page,{id:'playing',width:380,height:220}); await enter(page,'playing');
  });
  await test('多个播放视频：选择面积较大的主视频，不选择小预览', async () => {
    const page = await fixture(); await addVideo(page,{id:'preview',width:160,height:90});
    await addVideo(page,{id:'main',width:640,height:360}); await enter(page,'main');
  });
  await test('隐藏视频：选择可见的视频而非隐藏播放器', async () => {
    const page = await fixture(); await addVideo(page,{id:'hidden',width:700,height:390,hidden:true});
    await addVideo(page,{id:'visible',width:480,height:270}); await enter(page,'visible');
  });
  await test('滚动切换：两个暂停视频中，滚到第二个后小窗打开当前可见视频', async () => {
    const page = await fixture(); await addVideo(page,{id:'upper',paused:true});
    await addVideo(page,{id:'lower',paused:true});
    await page.locator('#lower').evaluate(video => { video.style.marginTop = '900px'; });
    await delay(250);
    await page.locator('#lower').evaluate(video => video.scrollIntoView({block:'center'}));
    await page.waitForFunction(() => document.querySelector('#upper').getBoundingClientRect().bottom < 0);
    await delay(200); await enter(page,'lower');
    assert.equal(await page.locator('#lower').evaluate(video => video.paused),true);
  });
  await test('可见视频优先：隐藏且正在播放的视频不能抢占可见暂停视频', async () => {
    const page = await fixture(); await addVideo(page,{id:'hidden-playing',hidden:true});
    await addVideo(page,{id:'visible-paused',paused:true}); await enter(page,'visible-paused');
    assert.equal(await page.locator('#hidden-playing').evaluate(video => video.paused),false);
    assert.equal(await page.locator('#visible-paused').evaluate(video => video.paused),true);
  });
  await test('播放器尺寸变化：没有窗口缩放时按钮跟随视频右上角', async () => {
    const page = await fixture(); await addVideo(page);
    const before = await page.locator(buttonSelector).boundingBox();
    await page.locator('#video').evaluate(video => { video.style.width = '400px'; video.style.height = '225px'; });
    await page.waitForFunction(() => {
      const video = document.querySelector('#video').getBoundingClientRect();
      const button = document.querySelector('link-new-tab-video-tools').shadowRoot.querySelector('button[data-action="pip"]').getBoundingClientRect();
      return Math.abs(button.right - (video.right - 12)) < 2 && Math.abs(button.top - (video.top + 12)) < 2;
    });
    const after = await page.locator(buttonSelector).boundingBox();
    assert.ok(Math.abs((after.x - before.x) + 240) < 2,'button follows the 240px decrease in video width');
    assert.ok(Math.abs(after.y - before.y) < 2,'button remains at the same video top edge');
    await enter(page);
  });
  await test('尚未加载的视频：不产生画中画，不改变原页', async () => {
    const page = await fixture(); await addVideo(page,{unready:true}); const before = page.url();
    const button = page.locator(buttonSelector);
    if (await button.isVisible() && await button.isEnabled()) { await button.click(); await delay(150); }
    assert.equal(await pipId(page),null); assert.equal(page.url(),before); assert.equal(context.pages().length,1);
    assert.equal(await page.locator('#video').evaluate(video => video.readyState),0);
  });
  await test('网站禁止画中画：保留 disablePictureInPicture，不能进入', async () => {
    const page = await fixture(); await addVideo(page,{disabled:true});
    const button = page.locator(buttonSelector);
    if (await button.isVisible() && await button.isEnabled()) { await button.click(); await delay(150); }
    assert.equal(await pipId(page),null);
    assert.equal(await page.locator('#video').evaluate(video => video.disablePictureInPicture),true);
  });
  await test('Permissions Policy 禁止：不进入画中画，不绕过策略', async () => {
    const page = await fixture('/policy-denied'); await addVideo(page);
    assert.equal(await page.evaluate(() => document.pictureInPictureEnabled),false);
    const button = page.locator(buttonSelector);
    if (await button.isVisible() && await button.isEnabled()) { await button.click(); await delay(150); }
    assert.equal(await pipId(page),null);
    assert.equal(await page.evaluate(() => document.pictureInPictureEnabled),false);
  });
  await test('跨域 iframe：iframe 内真实点击进入和退出画中画，顶层原页保留', async () => {
    const page = await fixture('/parent');
    await page.frameLocator('#cross').locator('h1').waitFor();
    const frame = page.frames().find(frame => frame.url().startsWith(crossOrigin));
    await addVideo(frame,{id:'framed',width:600,height:340}); const before = page.url();
    await enter(frame,'framed');
    assert.equal(await pipId(frame),'framed'); assert.equal(page.url(),before); assert.equal(context.pages().length,1);
    await leave(frame); assert.equal(await pipId(frame),null);
  });
  await test('无视频网页：不显示可点击的画中画按钮，也不新建窗口', async () => {
    const page = await fixture(); await delay(500);
    const button = page.locator(buttonSelector);
    assert.equal(await button.isVisible(),false);
    assert.equal(await pipId(page),null); assert.equal(context.pages().length,1);
  });
  await test('显示控制按钮的扩展消息：只显示页面入口，不自动申请画中画', async () => {
    const page = await fixture(); await addVideo(page); const before = page.url();
    const response = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({active:true});
      const tab = tabs[0];
      if (!tab) throw Error('Test fixture tab not found');
      return chrome.tabs.sendMessage(tab.id,{type:'PIP_SHOW_CONTROLS'});
    });
    assert.ok(response && typeof response === 'object','content script responds to the message');
    assert.equal(await pipId(page),null); assert.equal(page.url(),before);
    await enter(page); assert.equal(await pipId(page),'video');
  });

  const { passed, json, markdown } = report(results, browserVersion, '视频画中画：实际浏览器验收结果',
    '视频源：仅监听本机 127.0.0.1 的 HTTP 页面上的 canvas.captureStream() 实时视频，无外部网络视频依赖。使用真实点击，验证 document.pictureInPictureElement 与进入/退出事件；未替换 requestPictureInPicture。\n\n' +
    'headless 验收确认浏览器画中画 API 与扩展交互工作正常，不代表已目视确认桌面悬浮窗。跨域 iframe 使用 127.0.0.1 与 localhost 两个主机名。显示入口消息通过扩展 service worker 发送；真实工具栏弹出面板的 activeTab 授权流程未在此脚本验收。\n\n' +
    '后台恢复一项在扩展隔离环境模拟 document.hidden 与 visibilitychange，以验证暂停与恢复调度；headless 不能代表实际桌面标签切换，画中画 API 仍为真实调用。\n\n' +
    '未验证：YouTube 实时网站、所有第三方播放器、浏览器内置 PDF/Chrome 内部页面、操作系统窗口置顶表现、用户日常 Chrome 的实际安装。');
  run.writeText('report.md', markdown);
  run.writeJson('report.json', json);
  process.stdout.write(`RESULT ${passed}/${results.length}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch(error => {
  const errorText = sanitize(error.stack || String(error));
  run.writeJson('report.json', { status: 'failed', testedAt: new Date().toISOString(), error: errorText, results });
  run.writeText('report.md', '# 画中画测试未完成\n\n```\n' + errorText + '\n```\n');
  console.error(errorText);
  process.exitCode = 1;
}).finally(async () => {
  try { await run.cleanup(context, server); }
  catch (error) { console.error(sanitize(error.stack || String(error))); process.exitCode = 1; }
});
