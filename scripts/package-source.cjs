const fs = require('node:fs');
const path = require('node:path');
const { check, walk } = require('./check.cjs');
const { writeArchive } = require('./archive.cjs');

const { root, manifest } = check();
const files = {};
const topFiles = ['README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.editorconfig'];
if (fs.existsSync(path.join(root, 'LICENSE'))) topFiles.push('LICENSE');
const sourceFiles = topFiles.map(file => path.join(root, file));
for (const dir of ['extension', 'scripts', 'tests', 'docs', '.github']) sourceFiles.push(...walk(path.join(root, dir)));
for (const absolute of sourceFiles) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  files[`link-new-tab-github/${relative}`] = fs.readFileSync(absolute);
}
writeArchive(path.join(root, 'dist', `link-new-tab-source-v${manifest.version}.zip`), files);
