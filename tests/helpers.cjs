const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'extension');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep exported diagnostics shareable even when a browser error includes paths.
function sanitize(value) {
  if (typeof value === 'string') {
    const replacements = [[root, '<repository>'], [os.homedir(), '<home>']];
    for (const [absolute, label] of replacements) {
      value = value.split(absolute).join(label);
      value = value.split(absolute.replaceAll('\\', '/')).join(label);
    }
    if (process.env.CHROMIUM_EXECUTABLE_PATH) {
      value = value.split(process.env.CHROMIUM_EXECUTABLE_PATH).join('<chromium>');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
}

function harness(suite) {
  const outputDir = path.join(root, 'test-results', suite);
  fs.mkdirSync(outputDir, { recursive: true });
  let profile;
  const output = filename => path.join(outputDir, filename);
  const writeJson = (filename, value) => fs.writeFileSync(output(filename), JSON.stringify(sanitize(value), null, 2) + '\n', 'utf8');
  const writeText = (filename, value) => fs.writeFileSync(output(filename), sanitize(value), 'utf8');

  async function launch(options = {}) {
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw Error('Missing extension/manifest.json. Run the tests from the complete repository.');
    profile = fs.mkdtempSync(output('profile-'));
    const { args = [], ...rest } = options;
    return chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      headless: true,
      acceptDownloads: true,
      downloadsPath: output('downloads'),
      ...rest,
      args: [
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath,
        // Both HTTP hostnames must reach the IPv4-only loopback fixture server.
        '--host-resolver-rules=MAP localhost 127.0.0.1',
        ...args,
      ],
    });
  }

  async function cleanup(context, server) {
    try {
      if (context) await context.close();
    } finally {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      if (profile && fs.existsSync(profile)) {
        const resolvedProfile = fs.realpathSync(profile);
        const relative = path.relative(fs.realpathSync(outputDir), resolvedProfile);
        if (!relative.startsWith('profile-') || relative.includes(path.sep) || path.isAbsolute(relative)) {
          throw Error('Refusing to remove a profile outside the test output directory.');
        }
        fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }

  return { launch, cleanup, output, writeJson, writeText };
}

async function listenLocal(server) {
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    crossOrigin: 'http://localhost:' + server.address().port,
  };
}

function report(results, browserVersion, title, scope) {
  const passed = results.filter(result => result.passed).length;
  const testedAt = new Date().toISOString();
  const json = { testedAt, platform: process.platform, browserVersion, passed, total: results.length, results };
  const markdown = `# ${title}\n\n` +
    `- 验收时间（UTC）：${testedAt}\n- 环境：${process.platform}；Playwright 驱动 Chromium ${browserVersion}（headless，加载真实扩展）。\n` +
    '- 浏览器使用 test-results/ 内的临时独立 profile；测试结束后清理，不使用日常 Chrome 配置。\n' +
    `- 结果：${passed}/${results.length} 项通过。\n\n` +
    results.map(result => '- ' + (result.passed ? '通过' : '失败') + '：' + result.name + (result.passed ? '' : '\n  ```\n  ' + result.error.replace(/\n/g, '\n  ') + '\n  ```')).join('\n') +
    '\n\n' + scope + '\n';
  return { passed, json, markdown };
}

module.exports = { delay, harness, listenLocal, report, sanitize };
