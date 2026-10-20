const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Symbolic links are not allowed in packaged source: ${entry.name}`);
    return entry.isDirectory() ? walk(file) : [file];
  }).sort();
}

function check() {
  const manifest = readJSON(path.join(extension, 'manifest.json'));
  const pkg = readJSON(path.join(root, 'package.json'));
  assert.equal(manifest.manifest_version, 3, 'Use Manifest V3');
  assert.equal(manifest.version, pkg.version, 'Manifest and package versions must agree');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage'], 'Review permission changes explicitly');
  assert(!manifest.host_permissions && !manifest.externally_connectable, 'Review additional access explicitly');

  const assets = new Set([
    'manifest.json', manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)
  ]);
  for (const content of manifest.content_scripts) {
    assert.deepEqual(content.matches, ['http://*/*', 'https://*/*']);
    for (const file of [...content.js, ...(content.css || [])]) assets.add(file);
  }
  const popup = fs.readFileSync(path.join(extension, manifest.action.default_popup), 'utf8');
  for (const match of popup.matchAll(/\b(?:src|href)="([^"]+)"/g)) assets.add(match[1]);
  for (const script of popup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert(!script[1].trim(), 'Popup must use external scripts');
  }
  for (const relative of assets) {
    assert(typeof relative === 'string' && !relative.includes('..') && !relative.includes(':') && !path.isAbsolute(relative), `Invalid asset path: ${relative}`);
    const absolute = path.join(extension, relative);
    assert(fs.statSync(absolute).isFile(), `Missing extension file: ${relative}`);
  }

  for (const dir of ['extension', 'scripts', 'tests']) {
    for (const file of walk(path.join(root, dir))) {
      if (/\.(?:js|cjs)$/.test(file)) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: path.relative(root, file) });
    }
  }
  // Publishing source must not leak machine-specific account or runtime paths.
  for (const dir of ['extension', 'scripts', 'tests', 'docs']) {
    for (const file of walk(path.join(root, dir))) {
      if (!/\.(?:js|cjs|json|md|html|css)$/.test(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      assert(!/[A-Z]:[\\/]Users[\\/]|\/(?:Users|home)\/[a-z0-9_-]+\//i.test(content), `Machine-specific path found in ${path.relative(root, file)}`);
    }
  }
  console.log(`Check passed: Manifest V3 ${manifest.version}; ${assets.size} release assets; JavaScript syntax and portable paths.`);
  return { root, extension, manifest, assets: [...assets].sort() };
}

if (require.main === module) check();
module.exports = { check, walk };
