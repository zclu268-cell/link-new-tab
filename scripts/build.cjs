const fs = require('node:fs');
const path = require('node:path');
const { check } = require('./check.cjs');
const { writeArchive } = require('./archive.cjs');

const { root, extension, manifest, assets } = check();
const files = Object.fromEntries(assets.map(name => [name, fs.readFileSync(path.join(extension, name))]));
writeArchive(path.join(root, 'dist', `link-new-tab-v${manifest.version}.zip`), files);
