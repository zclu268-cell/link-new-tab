const http = require('node:http');
const assert = require('node:assert/strict');
const { delay, harness, listenLocal, report, sanitize } = require('./helpers.cjs');

const run = harness('links');
const results = [];
let context, worker, origin, crossOrigin;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.pathname === '/download.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="test.txt"' });
    return res.end('download test');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.pathname === '/target') return res.end('<!doctype html><title>Target</title><p id="destination">Target reached</p>');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Extension fixture</title></head><body>
  <a id="ordinary" href="/target?kind=ordinary">Ordinary</a>
  <a id="nested" href="/target?kind=nested"><span>Nested span</span></a>
  <a id="blank" target="_blank" href="/target?kind=blank">Blank target</a>
  <a id="spa" href="/target?kind=spa">SPA link</a>
  <a id="hash" href="#section">Same document hash</a><div id="section">Section</div>
  <a id="download" download href="/download.txt">Download</a>
  <a id="role" role="button" href="/target?kind=role">Action</a>
  <a id="inputlink" href="/target?kind=input"><input id="control" type="checkbox"></a>
  <a id="ignored" data-link-new-tab-ignore href="/target?kind=ignored">Explicit opt out</a>
  <div id="dynamic"></div><div id="shadow"></div>
  ${url.pathname === '/parent' ? `<iframe id="cross" src="${crossOrigin}/fixture"></iframe>` : ''}
  <script>
  window.fixtureClicks = 0; window.fixtureAuxClicks = 0; window.actions = 0;
  window.addEventListener('click', () => window.fixtureClicks++, true);
  window.addEventListener('auxclick', () => window.fixtureAuxClicks++, true);
  document.querySelector('#spa').addEventListener('click', e => { e.preventDefault(); window.actions++; history.pushState({}, '', '/spa-original'); });
  document.querySelector('#role').addEventListener('click', e => { e.preventDefault(); window.actions++; });
  document.querySelector('#inputlink').addEventListener('click', e => { e.preventDefault(); window.actions++; });
  document.querySelector('#dynamic').innerHTML = '<a id="late" href="/target?kind=dynamic">Dynamic link</a>';
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML = '<a id="shadowlink" href="/target?kind=shadow"><span>Shadow link</span></a>';
  </script></body></html>`);
});

async function settings(patch = {}) {
  await worker.evaluate(async values => chrome.storage.local.set(values), { enabled: true, active: true, excludedHosts: [], ...patch });
  await delay(100);
}
async function fixture(route = '/fixture', patch = {}) {
  const previousPages = context.pages();
  const page = await context.newPage();
  for (const previousPage of previousPages) await previousPage.close();
  await settings(patch);
  await page.goto(origin + route);
  await page.bringToFront();
  await delay(150);
  return page;
}
async function waitNewPage(action) {
  const pending = context.waitForEvent('page', {timeout: 5000});
  await action();
  const page = await pending;
  await page.waitForLoadState('domcontentloaded');
  await delay(150);
  return page;
}
async function activeTab() { return worker.evaluate(async () => (await chrome.tabs.query({active:true})).map(tab => ({id:tab.id,windowId:tab.windowId}))); }

// Inspect the browser's registered content-script listeners. The native-method
// counters additionally detect pointless remove/add cycles that leave count=1.
async function linkListenerProbe(page) {
  const session = await context.newCDPSession(page), worlds = [], scriptUrls = new Map();
  const extensionId = new URL(worker.url()).host;
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
    assert(!response.exceptionDetails, 'Listener probe failed: ' + JSON.stringify(response.exceptionDetails));
    return returnByValue ? response.result.value : response.result;
  };
  await evaluate(`(() => {
    const counts = globalThis.__linkBindings = { added:0, removed:0 };
    for (const [method, counter] of [['addEventListener','added'],['removeEventListener','removed']]) {
      const native = EventTarget.prototype[method];
      EventTarget.prototype[method] = function(type) {
        if (this === window && type === 'click') counts[counter]++;
        return Reflect.apply(native, this, arguments);
      };
    }
  })()`);
  return {
    evaluate,
    changes: () => evaluate('({...__linkBindings})'),
    count: async () => {
      const target = await evaluate('window', false);
      try {
        const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId:target.objectId });
        return listeners.filter(listener => listener.type === 'click' && listener.useCapture &&
          scriptUrls.get(listener.scriptId) === `chrome-extension://${extensionId}/content.js`).length;
      } finally { await session.send('Runtime.releaseObject', { objectId:target.objectId }); }
    },
    close: () => session.detach(),
  };
}

async function expectNew(selector, kind, patch = {}, sourceFrame = null) {
  const page = await fixture(sourceFrame ? '/parent' : '/fixture', patch);
  const oldUrl = page.url();
  const sourceTab = (await activeTab())[0];
  const clickSource = sourceFrame ? page.frameLocator('#cross') : page;
  const next = await waitNewPage(() => clickSource.locator(selector).click());
  assert.equal(context.pages().length, 2, 'exactly one new tab');
  assert.equal(page.url(), oldUrl, 'source page URL unchanged');
  assert.equal(new URL(next.url()).searchParams.get('kind'), kind);
  const tabs = await activeTab();
  if (patch.active === false) assert.equal(tabs[0].id, sourceTab.id, 'source tab remains active');
  else assert.notEqual(tabs[0].id, sourceTab.id, 'new tab becomes active');
  assert.equal(await next.evaluate(() => window.opener === null), true, 'new tab has no window.opener');
  return {page,next};
}
async function test(name, run) {
  try { await run(); results.push({ name, passed:true }); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { results.push({name, passed:false, error:sanitize(error.stack)}); process.stdout.write('FAIL ' + name + '\n' + sanitize(error.stack) + '\n'); }
}

(async () => {
  ({ origin, crossOrigin } = await listenLocal(server));
  context = await run.launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout:15000});
  await worker.evaluate(() => {
    globalThis.testObservedMessages = [];
    chrome.runtime.onMessage.addListener((message,sender) => {
      if (message.type === 'GET_SETTINGS') testObservedMessages.push({senderTabUrl:sender.tab?.url ?? null,senderUrl:sender.url,topOrigin:message.topOrigin});
    });
  });
  const browserVersion = context.browser().version();
  process.stdout.write('Chromium ' + browserVersion + '; extension ' + worker.url() + '\n');
  await test('普通链接：新开一页，保留原页，自动切换', () => expectNew('#ordinary','ordinary'));
  await test('嵌套元素链接：点击 span 可新开', () => expectNew('#nested span','nested'));
  await test('动态插入链接：可新开', () => expectNew('#late','dynamic'));
  await test('Shadow DOM 链接：可新开', () => expectNew('#shadowlink span','shadow'));
  await test('SPA 链接：新开目标 URL，原页路由不变', async () => {
    const {page} = await expectNew('#spa','spa');
    assert.equal(await page.evaluate(() => window.actions), 0);
  });
  await test('target=_blank：仅新开一个标签页', () => expectNew('#blank','blank'));
  await test('后台模式：新页打开，原页保持激活', () => expectNew('#ordinary','ordinary',{active:false}));
  await test('页内 hash：原页滚动/导航，无新增标签页', async () => {
    const page = await fixture(); await page.locator('#hash').click(); await delay(200);
    assert.equal(new URL(page.url()).hash,'#section'); assert.equal(context.pages().length,1);
    assert.equal(await page.evaluate(() => window.fixtureClicks),1);
  });
  await test('下载链接：原生下载，无新增标签页', async () => {
    const page = await fixture();
    const download = page.waitForEvent('download'); await page.locator('#download').click();
    assert.equal((await download).suggestedFilename(),'test.txt'); await delay(200);
    assert.equal(context.pages().length,1); assert.equal(await page.evaluate(() => window.fixtureClicks),1);
  });
  await test('role=button：执行原有动作，无新增标签页', async () => {
    const page = await fixture(); await page.locator('#role').click(); await delay(200);
    assert.equal(context.pages().length,1); assert.equal(await page.evaluate(() => window.actions),1);
  });
  await test('链接内输入控件：保留页面事件，无新增标签页', async () => {
    const page = await fixture(); await page.locator('#control').click(); await delay(200);
    assert.equal(context.pages().length,1); assert.equal(await page.evaluate(() => window.actions),1);
  });
  await test('页面显式忽略标记：保留原生当前页导航', async () => {
    const page = await fixture(); await page.locator('#ignored').click(); await page.waitForURL('**/target?kind=ignored');
    assert.equal(context.pages().length,1);
  });
  for (const [label, options, countName] of [['Ctrl / Command', {modifiers:['ControlOrMeta']}, 'fixtureClicks'],['Shift',{modifiers:['Shift']},'fixtureClicks'],['中键',{button:'middle'},'fixtureAuxClicks']]) {
    await test(label + ' 点击：保留原生事件与浏览器行为', async () => {
      const page = await fixture(); const oldUrl = page.url();
      const next = await waitNewPage(() => page.locator('#ordinary').click(options));
      assert.equal(context.pages().length,2); assert.equal(page.url(),oldUrl);
      assert.equal(new URL(next.url()).searchParams.get('kind'),'ordinary');
      assert.equal(await page.evaluate(name => window[name], countName),1, 'page still receives the native event');
    });
  }
  await test('全局关闭：普通链接在当前页原生导航', async () => {
    const page = await fixture('/fixture',{enabled:false}); await page.locator('#ordinary').click();
    await page.waitForURL('**/target?kind=ordinary'); assert.equal(context.pages().length,1);
  });
  await test('已打开页面实时关闭开关：下一次点击原生导航', async () => {
    const page = await fixture(); await settings({enabled:false}); await page.locator('#ordinary').click();
    await page.waitForURL('**/target?kind=ordinary'); assert.equal(context.pages().length,1);
  });
  await test('真实 click 监听：全局关闭和网站例外卸载，反复恢复只保留一份', async () => {
    const page = await fixture('/fixture', { enabled:false });
    const probe = await linkListenerProbe(page);
    try {
      assert.equal(await probe.count(), 0, 'A page initialized with links disabled must have no click listener');
      await settings();
      assert.equal(await probe.count(), 1);
      await settings({ excludedHosts:['127.0.0.1'] });
      assert.equal(await probe.count(), 0, 'Excluding the current website must remove the actual listener');
      await settings();
      assert.equal(await probe.count(), 1);
      for (let index = 0; index < 3; index++) {
        await settings({ enabled:false });
        assert.equal(await probe.count(), 0);
        await settings();
        assert.equal(await probe.count(), 1);
      }
      const next = await waitNewPage(() => page.locator('#ordinary').click());
      assert.equal(context.pages().length, 2, 'Re-enabling must still open exactly one tab');
      assert.equal(new URL(next.url()).searchParams.get('kind'), 'ordinary');
    } finally { await probe.close(); }
  });
  await test('视频偏好和前后台偏好变化不重复注册链接 click 监听', async () => {
    const page = await fixture();
    const probe = await linkListenerProbe(page);
    try {
      assert.equal(await probe.count(), 1);
      await worker.evaluate(() => chrome.storage.local.set({ videoAuto:true }));
      await delay(100);
      await worker.evaluate(() => chrome.storage.local.set({ videoAuto:false, active:false }));
      await delay(100);
      assert.equal(await probe.count(), 1);
      assert.deepEqual(await probe.changes(), { added:0, removed:0 }, 'Unrelated preferences must not cycle the click registration');
      const before = (await activeTab())[0];
      await waitNewPage(() => page.locator('#ordinary').click());
      assert.equal((await activeTab())[0].id, before.id, 'The new background-tab preference must still take effect');
    } finally {
      await probe.close();
      await worker.evaluate(() => chrome.storage.local.set({ videoAuto:false }));
    }
  });
  await test('当前网站排除：普通链接在当前页原生导航', async () => {
    const page = await fixture('/fixture',{excludedHosts:['127.0.0.1']}); await page.locator('#ordinary').click();
    await page.waitForURL('**/target?kind=ordinary'); assert.equal(context.pages().length,1);
  });
  await test('跨域 iframe：普通链接新开，顶层页面保留', () => expectNew('#ordinary','ordinary',{},true));
  await test('跨域 iframe：按顶层网站排除，frame 原生导航', async () => {
    const page = await fixture('/parent',{excludedHosts:['127.0.0.1']});
    const oldUrl = page.url(); const frame = page.frames().find(f => f.url().startsWith(crossOrigin));
    await frame.locator('#ordinary').click(); await frame.waitForURL('**/target?kind=ordinary');
    assert.equal(context.pages().length,1); assert.equal(page.url(),oldUrl);
  });
  await test('跨域 iframe：仅排除 iframe 域名时，顶层网站仍生效', () => expectNew('#ordinary','ordinary',{excludedHosts:['localhost']},true));

  await test('ChatGPT 来源规则：覆盖新旧域名和子域，不误伤其他网站', async () => {
    const results = await worker.evaluate(() => {
      const config = LinkNewTab.settings({ excludedHosts:[] });
      return Object.fromEntries(['chatgpt.com','www.chatgpt.com','CHATGPT.COM.','chat.openai.com','notchatgpt.com','chatgpt.com.example.org','platform.openai.com','example.org'].map(host => [host,LinkNewTab.enabledOn(config,host)]));
    });
    for (const host of ['chatgpt.com','www.chatgpt.com','CHATGPT.COM.','chat.openai.com']) assert.equal(results[host],false,host);
    for (const host of ['notchatgpt.com','chatgpt.com.example.org','platform.openai.com','example.org']) assert.equal(results[host],true,host);
  });
  await test('ChatGPT 页面与跨域 iframe 保留原生导航且没有链接捕获监听', async () => {
    // These HTTPS hosts are fulfilled entirely by local fixture HTML, never by
    // a logged-in ChatGPT session or the public service.
    const reply = async route => route.fulfill({contentType:'text/html',body:
      '<!doctype html><a id="spa" href="/c/next">Conversation</a><a id="ordinary" href="/target">Ordinary</a>' +
      (route.request().url().includes('chatgpt.com') ? '<iframe src="https://player.example.test/frame"></iframe>' : '') +
      '<script>document.querySelector("#spa").onclick=e=>{e.preventDefault();history.pushState({},"","/c/next");};</script>'});
    await context.route('https://chatgpt.com/**',reply);
    await context.route('https://player.example.test/**',reply);
    const page = await fixture();
    try {
      await page.goto('https://chatgpt.com/c/current'); await delay(200);
      const probe = await linkListenerProbe(page);
      try { assert.equal(await probe.count(),0); } finally { await probe.close(); }
      await page.locator('#spa').click();
      assert.equal(new URL(page.url()).pathname,'/c/next'); assert.equal(context.pages().length,1);
      const frame = page.frames().find(frame=>frame.url().startsWith('https://player.example.test/')); assert(frame);
      await frame.locator('#ordinary').click(); await frame.waitForURL('**/target');
      assert.equal(context.pages().length,1); assert.equal(new URL(page.url()).pathname,'/c/next');
      await page.locator('#ordinary').click(); await page.waitForURL('https://chatgpt.com/target');
      assert.equal(context.pages().length,1);
    } finally {
      await context.unroute('https://chatgpt.com/**',reply);
      await context.unroute('https://player.example.test/**',reply);
    }
  });

  const observedMessages = await worker.evaluate(() => globalThis.testObservedMessages);
  run.writeJson('observed-extension-messages.json', observedMessages);

  await test('扩展设置页：实际渲染且未报告脚本异常', async () => {
    await fixture(); const popup = await context.newPage(); const errors = [];
    popup.on('pageerror', error => errors.push(String(error)));
    await popup.setViewportSize({width:380,height:620});
    await popup.goto(worker.url().replace('background.js','popup.html'));
    await popup.locator('#enabled:not([disabled])').waitFor();
    assert.equal(await popup.locator('h1').innerText(),'链接新开');
    assert.equal(await popup.locator('#enabled').isChecked(),true);
    assert.equal(await popup.locator('#active').isChecked(),true);
    assert.equal(await popup.locator('#site-enabled').isDisabled(),true);
    assert.deepEqual(errors,[]);
    await popup.screenshot({path:run.output('popup-preview.png'),fullPage:true});
  });
  await test('扩展设置页：全局开关真实保存到 storage', async () => {
    const popup = context.pages().find(page => page.url().endsWith('/popup.html'));
    await popup.locator('#enabled').uncheck();
    await popup.locator('#feedback').filter({hasText:'已保存'}).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled),false);
    assert.match(await popup.locator('#summary').innerText(),/已暂停/);
    await popup.locator('#enabled').check();
    await popup.locator('#enabled:not([disabled])').waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('enabled')).enabled),true);
  });
  await test('扩展设置页：前后台偏好保存，重开页面保持', async () => {
    const popup = context.pages().find(page => page.url().endsWith('/popup.html'));
    await popup.locator('#active').uncheck(); await popup.locator('#active:not([disabled])').waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('active')).active),false);
    await popup.reload(); await popup.locator('#active:not([disabled])').waitFor();
    assert.equal(await popup.locator('#active').isChecked(),false);
  });
  await test('ChatGPT 面板显示原生链接例外，网站开关关闭且不影响视频入口', async () => {
    const popup = context.pages().find(page=>page.url().endsWith('/popup.html'));
    // Supply tab metadata to the real rendering functions; toolbar activeTab
    // grants are outside this fixture's scope.
    await popup.evaluate(()=>{identifySite({id:123,url:'https://chatgpt.com/c/test'});render();});
    assert.equal(await popup.locator('#site-enabled').isChecked(),false);
    assert.equal(await popup.locator('#site-enabled').isDisabled(),true);
    assert.match(await popup.locator('#site-help').innerText(),/ChatGPT 已排除/);
    assert.equal(await popup.locator('#enabled').isEnabled(),true);
    assert.equal(await popup.locator('#show-video-controls').isEnabled(),true);
    await popup.screenshot({path:run.output('chatgpt-exception-preview.png'),fullPage:true});
  });
  await test('真实 runtime.reload：旧页下一次点击卸载失效监听，恢复原生导航', async () => {
    const page = await fixture();
    const probe = await linkListenerProbe(page);
    try {
      assert.equal(await probe.count(), 1);
      try { await worker.evaluate(() => chrome.runtime.reload()); }
      catch (error) { if (!/closed|destroyed/i.test(error.message)) throw error; }
      await delay(300);
      assert.equal(await probe.evaluate('chrome.runtime.id || null'), null, 'The old world must really have lost its extension context');
      await page.locator('#hash').click();
      assert.equal(new URL(page.url()).hash, '#section');
      assert.equal(await probe.count(), 0, 'An invalidated script must remove its listener on the first click');
      assert.equal(await page.evaluate(() => window.fixtureClicks), 1, 'The invalidated handler must preserve the native event');
    } finally { await probe.close(); }
    await page.locator('#ordinary').click();
    await page.waitForURL('**/target?kind=ordinary');
    assert.equal(context.pages().length, 1);
  });

  const { passed, json, markdown } = report(results, browserVersion, '链接新开：实际浏览器验收结果',
    '测试页面：仅监听本机 127.0.0.1 的 HTTP 服务，以 127.0.0.1 和 localhost 两个主机名验证跨域 iframe；使用真实浏览器点击。\n\n' +
    '新标签页用浏览器 tab ID 验证激活状态，并验证 window.opener 为 null。设置面板以扩展页面直接打开测试；真实工具栏弹出面板触发的 activeTab 授权与当前网站识别未纳入本次自动验收。\n\n' +
    '通过 CDP 检查真实内容脚本的原生 click 监听注册，验证全局关闭、网站例外、无关偏好变化及真实 runtime.reload 后的卸载；没有替换扩展运行时 API。\n\n' +
    '未验证：Chrome 商店发布、所有第三方网站兼容性、用户日常 Chrome 中的实际安装。');
  run.writeText('report.md', markdown);
  run.writeJson('report.json', json);
  process.stdout.write(`RESULT ${passed}/${results.length}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch(error => {
  const errorText = sanitize(error.stack || String(error));
  run.writeJson('report.json', { status: 'failed', testedAt: new Date().toISOString(), error: errorText, results });
  run.writeText('report.md', '# 链接测试未完成\n\n```\n' + errorText + '\n```\n');
  console.error(errorText);
  process.exitCode = 1;
}).finally(async () => {
  try { await run.cleanup(context, server); }
  catch (error) { console.error(sanitize(error.stack || String(error))); process.exitCode = 1; }
});
