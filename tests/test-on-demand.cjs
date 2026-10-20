const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { delay, harness, listenLocal, report, sanitize } = require('./helpers.cjs');

const run = harness('on-demand');
const sourceExtension = path.resolve(__dirname, '../extension');
const baselineIndex = process.argv.indexOf('--baseline-video');
const baselineFile = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
if (baselineIndex >= 0 && !baselineFile) throw Error('--baseline-video requires a saved video.js file');
const mode = baselineFile ? 'baseline' : 'current';
const hostSelector = 'link-new-tab-video-tools';
const buttonSelector = hostSelector + ' button[data-action="pip"]';
const results = [], measurements = {}, temporaryDirectories = [];
let context, worker, extensionId, origin, crossOrigin;

// This hook precedes video.js in a disposable copy. It counts only the actual
// extension world, including startup, while preserving native DOM operations.
const bootstrap = `(() => {
  const state = globalThis.__demandProbe = {
    counts:{ documentVideoQueries:0, subtreeVideoQueries:0, videoRectReads:0,
      observerCreated:0, observerCallbacks:0, mediaAdds:0, layoutAdds:0,
      timerCallbacks:0, frameCallbacks:0 },
    observers:new Map(), events:[], timers:new Set(), frames:new Set()
  };
  for (const [prototype, counter] of [[Document.prototype,'documentVideoQueries'], [Element.prototype,'subtreeVideoQueries']]) {
    const query = prototype.querySelectorAll;
    prototype.querySelectorAll = function(selector) {
      if (selector === 'video') state.counts[counter]++;
      return Reflect.apply(query,this,arguments);
    };
  }
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() {
    if (this instanceof HTMLVideoElement) state.counts.videoRectReads++;
    return Reflect.apply(rect,this,arguments);
  };
  for (const name of ['MutationObserver','ResizeObserver','IntersectionObserver']) {
    const Native = globalThis[name];
    if (!Native) continue;
    globalThis[name] = class extends Native {
      constructor(callback, ...args) {
        super((...values) => { state.counts.observerCallbacks++; callback(...values); }, ...args);
        state.counts.observerCreated++;
        state.observers.set(this,new Set());
      }
      observe(target,...args) { state.observers.get(this).add(target); return super.observe(target,...args); }
      disconnect() { state.observers.get(this).clear(); return super.disconnect(); }
      unobserve(target) { state.observers.get(this).delete(target); return super.unobserve(target); }
    };
  }
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const category = (target,type) => target instanceof HTMLVideoElement ? 'media' :
    ['scroll','resize','fullscreenchange'].includes(type) ? 'layout' :
    ['focus','visibilitychange','pagehide','pageshow'].includes(type) ? 'lifecycle' : null;
  const captureOf = options => typeof options === 'boolean' ? options : Boolean(options?.capture);
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    const kind = category(this,type), capture = captureOf(options);
    if (kind && !state.events.some(item => item.target === this && item.type === type && item.listener === listener && item.capture === capture)) {
      state.events.push({ target:this, type, listener, capture, kind });
      if (kind === 'media') state.counts.mediaAdds++;
      if (kind === 'layout') state.counts.layoutAdds++;
    }
    return Reflect.apply(add,this,arguments);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const capture = captureOf(options);
    state.events = state.events.filter(item => !(item.target === this && item.type === type && item.listener === listener && item.capture === capture));
    return Reflect.apply(remove,this,arguments);
  };
  const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = function(callback, delay, ...args) {
    if (typeof callback !== 'function') return timeout(callback,delay,...args);
    const id = timeout(() => { state.timers.delete(id); state.counts.timerCallbacks++; callback(...args); },delay);
    state.timers.add(id); return id;
  };
  globalThis.clearTimeout = function(id) { state.timers.delete(id); return clear(id); };
  const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = function(callback) {
    const id = raf(time => { state.frames.delete(id); state.counts.frameCallbacks++; callback(time); });
    state.frames.add(id); return id;
  };
  globalThis.cancelAnimationFrame = function(id) { state.frames.delete(id); return cancel(id); };
})();\n`;

const server = http.createServer((req, res) => {
  const route = new URL(req.url, origin || 'http://127.0.0.1').pathname;
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>On-demand video fixture</title>
  <style>body{margin:20px;height:2200px}video{display:block;width:640px;height:360px;background:#17243d}#churn{height:100px;overflow:hidden;contain:strict}iframe{width:760px;height:500px;border:0}</style></head>
  <body><main id="videos">${route === '/video' ? '<video id="video" muted playsinline></video>' : ''}</main><aside id="churn"></aside>
  ${route === '/parent' ? `<iframe id="empty" src="${crossOrigin}/empty"></iframe><iframe id="player" src="${crossOrigin}/video" allow="picture-in-picture"></iframe>` : ''}
  <script>
  window.startVideo = async () => {
    let video = document.getElementById('video');
    if (!video) { video = document.createElement('video'); video.id='video'; document.getElementById('videos').append(video); }
    video.muted=true; video.playsInline=true;
    const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=360;
    const paint=canvas.getContext('2d'); let count=0;
    const draw=()=>{paint.fillStyle='#17243d';paint.fillRect(0,0,640,360);paint.fillStyle='#fff';paint.fillRect(count++%600,100,40,40);};
    draw(); const timer=setInterval(draw,50), stream=canvas.captureStream(20);
    video.srcObject=stream; await video.play();
    window.stopFixture=()=>{clearInterval(timer);stream.getTracks().forEach(track=>track.stop());};
  };
  </script></body></html>`);
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(run.output(prefix));
  temporaryDirectories.push(directory); return directory;
}
async function probeFrames(page) {
  const sessions = [], probes = [];
  async function collect(target) {
    const session = await context.newCDPSession(target), worlds = [];
    sessions.push(session);
    session.on('Runtime.executionContextCreated', ({ context:world }) => worlds.push(world));
    await session.send('Runtime.enable');
    for (const world of worlds) {
      if (world.auxData?.isDefault) continue;
      const result = await session.send('Runtime.evaluate', { contextId:world.id, expression:'globalThis.chrome?.runtime?.id', returnByValue:true });
      if (result.result.value !== extensionId) continue;
      const evaluate = async expression => {
        const response = await session.send('Runtime.evaluate', { contextId:world.id, expression, returnByValue:true, awaitPromise:true });
        assert(!response.exceptionDetails, 'Probe failed: ' + JSON.stringify(response.exceptionDetails));
        return response.result.value;
      };
      const url = await evaluate('location.href');
      if (probes.some(probe => probe.url === url)) continue;
      probes.push({
        url, evaluate,
        reset:() => evaluate('Object.keys(__demandProbe.counts).forEach(key => __demandProbe.counts[key]=0)'),
        read:() => evaluate(`({ counts:{...__demandProbe.counts}, activeObservers:[...__demandProbe.observers.values()].filter(items=>items.size).length,
          mediaListeners:__demandProbe.events.filter(item=>item.kind==='media').length,
          layoutListeners:__demandProbe.events.filter(item=>item.kind==='layout').length,
          lifecycleListeners:__demandProbe.events.filter(item=>item.kind==='lifecycle').length,
          timers:__demandProbe.timers.size, frames:__demandProbe.frames.size })`),
      });
    }
  }
  await collect(page);
  // Out-of-process iframes have separate targets. The fixture uses a distinct
  // URL for every frame so absence of a probe cannot silently reduce coverage.
  for (const frame of page.frames()) {
    if (!probes.some(probe => probe.url === frame.url())) await collect(frame);
    assert(probes.some(probe => probe.url === frame.url()), 'Missing frame probe: ' + frame.url());
  }
  assert(probes.length, 'The loaded extension isolated world must exist');
  return { probes, close:() => Promise.all(sessions.map(session => session.detach())) };
}
async function fixture(route = '/video') {
  for (const page of context.pages()) await page.close();
  await worker.evaluate(() => chrome.storage.local.set({ videoAuto:false }));
  const page = await context.newPage();
  await page.goto(origin + route); await page.bringToFront(); await delay(350);
  const instrumentation = await probeFrames(page);
  const probe = instrumentation.probes.find(probe => probe.url === page.url());
  assert(probe, 'Top-frame instrumentation must exist');
  return { page, probe, ...instrumentation };
}
async function command(page, type) {
  await page.bringToFront();
  return worker.evaluate(async type => {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if (!tab) throw Error('Fixture tab unavailable');
    return chrome.tabs.sendMessage(tab.id,{ type });
  },type);
}
async function popupFor(page) {
  // The disposable test copy has tabs permission solely to identify the active
  // fixture. Product permissions stay unchanged. This exercises actual popup
  // handlers and cross-frame messaging, not the toolbar's activeTab grant.
  const popup = await context.newPage();
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#show-video-controls:not([disabled])').waitFor({ timeout:5000 });
  return popup;
}
async function churn(page) {
  await page.evaluate(async () => {
    for (let round=0; round<5; round++) {
      document.getElementById('churn').innerHTML='<section>'+('<p><b>dynamic</b></p>'.repeat(100))+'</section>';
      window.scrollTo(0,round%2?90:0); window.dispatchEvent(new Event('resize'));
      document.getElementById('video')?.dispatchEvent(new Event('loadedmetadata'));
      await new Promise(resolve=>setTimeout(resolve,170));
    }
  });
  await delay(200);
}
function assertResting(stats, label) {
  assert.equal(stats.activeObservers,0,label+' must disconnect observers');
  assert.equal(stats.mediaListeners,0,label+' must remove media listeners');
  assert.equal(stats.layoutListeners,0,label+' must remove scroll/resize/fullscreen listeners');
  assert.equal(stats.lifecycleListeners,0,label+' must remove page lifecycle listeners');
  assert.equal(stats.timers,0,label+' must cancel timers');
  assert.equal(stats.frames,0,label+' must cancel animation frames');
}
function assertNoWork(stats, label) {
  assertResting(stats,label);
  assert.deepEqual(stats.counts,Object.fromEntries(Object.keys(stats.counts).map(key=>[key,0])),label+' must do no video work');
}
async function test(name, action) {
  let current;
  try { current=await action(); results.push({name,passed:true}); console.log('PASS '+name); }
  catch(error) { results.push({name,passed:false,error:sanitize(error.stack)}); console.log('FAIL '+name+'\n'+sanitize(error.stack)); }
  finally { if(current?.close) await current.close(); }
}

(async()=>{
  ({origin,crossOrigin}=await listenLocal(server));
  const extensionPath=temporaryDirectory('extension-');
  fs.cpSync(sourceExtension,extensionPath,{recursive:true});
  fs.writeFileSync(path.join(extensionPath,'video.js'),bootstrap+fs.readFileSync(baselineFile ? path.resolve(baselineFile) : path.join(extensionPath,'video.js'),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(extensionPath,'manifest.json'),'utf8'));
  manifest.permissions.push('tabs');
  fs.writeFileSync(path.join(extensionPath,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(temporaryDirectory('profile-'),{
    channel:'chromium',headless:true,viewport:{width:1100,height:850},
    ...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),
    args:['--disable-extensions-except='+extensionPath,'--load-extension='+extensionPath,'--host-resolver-rules=MAP localhost 127.0.0.1','--autoplay-policy=no-user-gesture-required'],
  });
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  extensionId=new URL(worker.url()).host;
  const browserVersion=context.browser().version();

  await test(baselineFile ? '基线对照采样：记录含视频页面启动和动态变化的开销' :
    '默认按需：含视频页面启动和动态变化均无视频扫描、观察器、媒体或布局工作',async()=>{
    const f=await fixture();
    const startup=await f.probe.read(); measurements.defaultStartup=startup;
    if (!baselineFile) assertNoWork(startup,'Initial dormant page');
    await f.probe.reset();
    await churn(f.page);
    const stats=await f.probe.read(); measurements.defaultVideoPage=stats;
    if (!baselineFile) {
      assertNoWork(stats,'Dormant page after DOM/scroll/media events');
      assert.equal(await f.page.locator(hostSelector).count(),0);
    }
    console.log(mode+' defaultStartup '+JSON.stringify(startup));
    console.log(mode+' defaultVideoPage '+JSON.stringify(stats));
    return f;
  });
  if (!baselineFile) {
  await test('无视频手动请求只扫描一次，后续新增视频仍保持休眠',async()=>{
    const f=await fixture('/empty');
    const response=await command(f.page,'PIP_SHOW_CONTROLS');
    assert.equal(response.reason,'no-video');
    const before=await f.probe.read(); measurements.noVideoRequest=before;
    assert.equal(before.counts.documentVideoQueries,1);
    assert.equal(before.counts.observerCreated,0);
    assertResting(before,'Empty frame after request');
    await f.probe.reset(); await f.page.evaluate(()=>window.startVideo()); await churn(f.page);
    assertNoWork(await f.probe.read(),'Empty-request frame after adding a video');
    assert.equal(await f.page.locator(hostSelector).count(),0);
    return f;
  });
  await test('真实设置页面：默认自动开关关闭，手动显示后可点击进入原生画中画',async()=>{
    const f=await fixture(); await f.page.evaluate(()=>window.startVideo());
    const popup=await popupFor(f.page);
    assert.equal(await popup.locator('#video-auto').isChecked(),false);
    await popup.setViewportSize({width:380,height:600});
    measurements.popupLayout=await popup.evaluate(()=>({
      viewportWidth:innerWidth,viewportHeight:innerHeight,
      scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
      videoActionsBottom:document.getElementById('hide-video-controls').getBoundingClientRect().bottom,
    }));
    assert.equal(measurements.popupLayout.scrollWidth,380,'Popup must fit without horizontal scrolling');
    assert(measurements.popupLayout.videoActionsBottom <= 600,'Video actions must be visible within the popup height');
    await popup.screenshot({path:run.output('popup-default.png'),fullPage:true});
    await popup.locator('#show-video-controls').click();
    await popup.locator('#video-feedback[data-state="success"]').waitFor({timeout:5000});
    await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    assert.equal(await f.page.evaluate(()=>document.pictureInPictureElement),null);
    await popup.close(); await f.page.bringToFront(); await f.page.locator(buttonSelector).click();
    await f.page.waitForFunction(()=>document.pictureInPictureElement?.id==='video',null,{timeout:5000});
    const stats=await f.probe.read(); assert(stats.mediaListeners>0); assert(stats.activeObservers>0);
    return f;
  });
  await test('停止本页按钮释放监听与任务，已进入的原生画中画继续播放',async()=>{
    const f=await fixture(); await f.page.evaluate(()=>window.startVideo()); await command(f.page,'PIP_SHOW_CONTROLS');
    await f.page.locator(buttonSelector).click();
    await f.page.waitForFunction(()=>document.pictureInPictureElement?.id==='video');
    const popup=await popupFor(f.page); await popup.locator('#hide-video-controls').click();
    await f.page.locator(hostSelector).waitFor({state:'detached',timeout:5000}); await delay(200);
    assert.equal(await f.page.evaluate(()=>document.pictureInPictureElement?.id),'video');
    assertResting(await f.probe.read(),'Stopped page');
    await f.probe.reset(); await churn(f.page);
    const stats=await f.probe.read(); measurements.stoppedNativePip=stats; assertNoWork(stats,'Stopped page during native PiP');
    await f.page.evaluate(()=>document.exitPictureInPicture());
    return f;
  });
  await test('自动开关支持动态视频；关闭自动立即停止所有已激活页面',async()=>{
    const f=await fixture('/empty'); const popup=await popupFor(f.page);
    await popup.locator('#video-auto').check();
    await popup.locator('#video-auto:not([disabled])').waitFor();
    await f.page.evaluate(()=>window.startVideo());
    await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    const second=await context.newPage(); await second.goto(origin+'/video');
    await second.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    await popup.locator('#video-auto').uncheck();
    await f.page.locator(hostSelector).waitFor({state:'detached',timeout:5000});
    await second.locator(hostSelector).waitFor({state:'detached',timeout:5000});
    assertResting(await f.probe.read(),'Auto mode disabled');
    await f.probe.reset(); await churn(f.page); assertNoWork(await f.probe.read(),'After auto mode disabled');
    await command(f.page,'PIP_SHOW_CONTROLS');
    await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    return f;
  });
  await test('自动模式停止本页后保持休眠，其他页面仍能自动检测',async()=>{
    const f=await fixture(); await worker.evaluate(()=>chrome.storage.local.set({videoAuto:true}));
    await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    await command(f.page,'PIP_HIDE_CONTROLS'); await delay(200); await f.probe.reset();
    await churn(f.page); assertNoWork(await f.probe.read(),'Automatic page manually stopped');
    const other=await context.newPage(); await other.goto(origin+'/video');
    await other.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    assert.equal(await f.page.locator(hostSelector).count(),0);
    return f;
  });
  await test('跨域视频请求：空frame只扫描一次保持休眠，视频frame显示入口并进入原生画中画',async()=>{
    const f=await fixture('/parent');
    assert.equal(f.probes.length,3,'Top frame and both cross-origin iframe worlds must be inspected');
    const player=f.page.frames().find(frame=>frame.url()===crossOrigin+'/video'); assert(player);
    await player.evaluate(()=>window.startVideo());
    const popup=await popupFor(f.page); await popup.locator('#show-video-controls').click();
    await popup.locator('#video-feedback[data-state="success"]').waitFor({timeout:5000});
    for(const probe of f.probes.filter(probe=>probe.url!==crossOrigin+'/video')) {
      const stats=await probe.read(); assert.equal(stats.counts.documentVideoQueries,1); assert.equal(stats.counts.observerCreated,0); assertResting(stats,'Empty broadcast frame');
    }
    await popup.close(); await f.page.bringToFront(); await player.locator(buttonSelector).click();
    await player.waitForFunction(()=>document.pictureInPictureElement?.id==='video',null,{timeout:5000});
    return f;
  });
  await test('手动会话移除最后视频后休眠，再插入视频不自行重启',async()=>{
    const f=await fixture(); await command(f.page,'PIP_SHOW_CONTROLS');
    await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    await f.page.evaluate(()=>{window.savedVideo=document.getElementById('video');savedVideo.remove();});
    await f.page.locator(hostSelector).waitFor({state:'detached',timeout:5000}); await delay(250);
    assertResting(await f.probe.read(),'Manual session with last video removed');
    await f.probe.reset(); await f.page.evaluate(()=>document.getElementById('videos').append(savedVideo)); await churn(f.page);
    assertNoWork(await f.probe.read(),'Manual session after reinsertion');
    await command(f.page,'PIP_SHOW_CONTROLS'); await f.page.locator(buttonSelector).waitFor({state:'visible',timeout:5000});
    return f;
  });
  await test('进入画中画的异步完成发生在停止之后，不重新创建控件或跟踪任务',async()=>{
    const f=await fixture(); await f.page.evaluate(()=>window.startVideo()); await command(f.page,'PIP_SHOW_CONTROLS');
    // Keep the real native request and user gesture; delay only its Promise
    // completion to deterministically exercise a stop-while-awaiting race.
    await f.probe.evaluate(`(() => {
      const request=HTMLVideoElement.prototype.requestPictureInPicture;
      HTMLVideoElement.prototype.requestPictureInPicture=function(...args) {
        return Reflect.apply(request,this,args).then(value=>new Promise(resolve=>{globalThis.__finishNativeRequest=()=>resolve(value);}));
      };
    })()`);
    await f.page.locator(buttonSelector).click();
    await f.page.waitForFunction(()=>document.pictureInPictureElement?.id==='video',null,{timeout:5000});
    await command(f.page,'PIP_HIDE_CONTROLS'); await delay(100); await f.probe.reset();
    await f.probe.evaluate('__finishNativeRequest()'); await delay(250);
    assertNoWork(await f.probe.read(),'Late native PiP completion');
    assert.equal(await f.page.locator(hostSelector).count(),0);
    assert.equal(await f.page.evaluate(()=>document.pictureInPictureElement?.id),'video');
    await f.page.evaluate(()=>document.exitPictureInPicture());
    return f;
  });

  }

  const summary=report(results,browserVersion,baselineFile ? '视频检测基线对照采样' : '按需视频检测与休眠性能回归',
    '在真实 Chromium 的临时独立配置中加载扩展副本，先于 video.js 插装原生 DOM、观察器、监听器和调度计数。页面自己的查询与播放计时器在另一个 world，不计入结果。计数验证默认休眠及显式停止后的工作量，不等同整机CPU、网页加载速度或日常浏览器卡顿测量。'+
    '设置面板作为真实扩展页面运行并使用实际消息；仅临时测试副本增加 tabs 权限，供面板识别当前测试标签，产品清单权限不变。未验收真实工具栏 activeTab 授权或操作系统悬浮窗外观。'+
    '画中画调用使用原生API与真实点击；异步竞态一项仅延迟真实API Promise完成，以验证停止后不会重新创建控件。');
  run.writeJson(mode+'-report.json',{...summary.json,mode,measurements}); run.writeText(mode+'-report.md',summary.markdown);
  console.log(`RESULT ${summary.passed}/${results.length}`); if(summary.passed!==results.length)process.exitCode=1;
})().catch(error=>{console.error(sanitize(error.stack));process.exitCode=1;}).finally(async()=>{
  if(context)await context.close();
  if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const outputDirectory=fs.realpathSync(path.dirname(run.output('unused')));
  for(const directory of temporaryDirectories){
    const resolved=fs.realpathSync(directory),relative=path.relative(outputDirectory,resolved);
    if(path.isAbsolute(relative)||relative.includes(path.sep)||!/^(?:extension|profile)-/.test(relative))throw Error('Refusing to remove a directory outside on-demand test output');
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
