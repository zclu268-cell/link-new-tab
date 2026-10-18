// Optional live integration test. This script is deliberately outside `npm test`.
// Network, consent, login and bot restrictions are reported as unverified (2).
const { harness, sanitize } = require('./helpers.cjs');

const run = harness('youtube');
const targetUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const result = { targetUrl, testedAt: new Date().toISOString(), platform: process.platform, mode: 'isolated headless Chromium, real unmodified Picture-in-Picture API', status: 'incomplete', step: 'launch' };
let context;
let page;
let deadline;
const budget = (limit) => Math.max(1, Math.min(limit, deadline - Date.now()));

(async () => {
  context = await run.launch({
    viewport: { width: 1280, height: 900 },
  });
  result.browserVersion = context.browser().version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  result.extensionWorker = worker.url();
  page = await context.newPage();
  deadline = Date.now() + 60000;
  result.step = 'open-youtube';
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: budget(25000) });
  result.url = page.url();
  const rejectConsent = page.getByRole('button', { name: /^(Reject all|拒绝全部|全部拒绝|拒绝所有)$/i }).first();
  if (await rejectConsent.isVisible()) {
    result.step = 'reject-optional-consent';
    await rejectConsent.click({ timeout: budget(5000) });
  }
  result.step = 'wait-for-video';
  await page.locator('video').first().waitFor({ state: 'visible', timeout: budget(15000) });
  result.title = await page.title();
  const video = page.locator('video').first();
  await video.evaluate(video => { video.muted = true; });
  if (await video.evaluate(video => video.paused)) {
    const play = page.locator('.ytp-large-play-button').first();
    if (await play.isVisible()) await play.click({ timeout: budget(4000) });
    else await video.click({ timeout: budget(4000) });
  }
  result.step = 'wait-for-playback';
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2 && video.videoWidth > 0 && !video.paused), null, { timeout: budget(15000) });
  result.videoBefore = await video.evaluate(video => ({readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused, currentTime: video.currentTime, disabled: video.disablePictureInPicture, pipEnabled: document.pictureInPictureEnabled}));
  result.step = 'click-extension-pip-button';
  const pipButton = page.locator('link-new-tab-video-tools button[data-action="pip"]');
  await pipButton.waitFor({state: 'visible', timeout: budget(5000)});
  await pipButton.click({ timeout: budget(5000) });
  await page.waitForFunction(() => document.pictureInPictureElement instanceof HTMLVideoElement, null, { timeout: budget(5000) });
  result.pip = await page.evaluate(() => ({tag: document.pictureInPictureElement.tagName, paused: document.pictureInPictureElement.paused, currentTime: document.pictureInPictureElement.currentTime}));
  result.status = 'passed';
  result.step = 'entered-real-pip';
})().catch(async error => {
  const environmentSteps = ['open-youtube', 'reject-optional-consent', 'wait-for-video', 'wait-for-playback'];
  result.status = environmentSteps.includes(result.step) ? 'not-verified' : 'failed';
  result.error = sanitize(error.message);
}).finally(async () => {
  if (page) {
    result.finalUrl = page.url();
    try { result.pageText = (await page.locator('body').innerText({timeout: 2000})).slice(0, 1600); } catch {}
    try { await page.screenshot({path: run.output('youtube-pip-test.png'), timeout: 3000}); result.screenshot = 'test-results/youtube/youtube-pip-test.png'; } catch {}
  }
  try { await run.cleanup(context); }
  catch (error) {
    result.cleanupError = sanitize(error.message);
    if (result.status === 'passed') result.status = 'failed';
  }
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'not-verified' ? 2 : 1;
  run.writeJson('report.json', result);
  run.writeText('report.md', '# YouTube 画中画：手动集成测试\n\n' +
    `- 测试时间（UTC）：${result.testedAt}\n- 状态：${result.status}\n- 最后步骤：${result.step}\n- 退出码：${process.exitCode}\n- 目标：[YouTube 测试视频](${targetUrl})\n\n` +
    (result.error ? '错误：\n\n```\n' + result.error + '\n```\n\n' : '') +
    (result.cleanupError ? '清理错误：\n\n```\n' + result.cleanupError + '\n```\n\n' : '') +
    '只有实际进入浏览器画中画才标记通过。网络、登录、机器人检查或视频无法播放时标记 not-verified，退出码为 2；不会绕过登录或访问限制。\n\n' +
    '此测试使用 headless 浏览器和独立空白 profile，不代表已目视确认操作系统悬浮窗，也不代表所有 YouTube 视频都兼容。\n');
  process.stdout.write(JSON.stringify(sanitize(result), null, 2) + '\n');
});
