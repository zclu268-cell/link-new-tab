const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { zipSync, unzipSync } = require('fflate');

function writeArchive(destination, files) {
  const entries = {};
  // Fixed timestamps and sorted paths keep rebuilds byte-for-byte reproducible.
  for (const name of Object.keys(files).sort()) {
    entries[name] = [new Uint8Array(files[name]), { mtime: new Date(2020, 0, 1), level: 9 }];
  }
  const zip = Buffer.from(zipSync(entries));
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(files).sort());
  for (const [name, data] of Object.entries(files)) assert(Buffer.from(unpacked[name]).equals(data), `ZIP round-trip failed: ${name}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, zip);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(`${destination}.sha256`, `${sha256}  ${path.basename(destination)}\n`);
  console.log(`${path.basename(destination)}: ${Object.keys(files).length} files, ${zip.length} bytes\nSHA-256 ${sha256}`);
  return { destination, sha256, size: zip.length };
}
module.exports = { writeArchive };
