import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const require = createRequire(path.join(root, 'package.json'));
const metadata = require('./package.json');
if (metadata.farmingRuntimePackages === 1) {
  for (const name of ['ansi-to-html', '@xterm/addon-clipboard', '@xterm/addon-search', 'qrcode-generator', 'node-pty']) {
    assert(!fs.existsSync(path.join(root, 'node_modules', name)), `Duplicate dependency: ${name}`);
  }
  for (const name of ['images', 'style_capsules', 'legacy-icons-v1', 'app-icon-v2-master.png']) {
    assert(!fs.existsSync(path.join(root, 'dist/farming-2', name)), `Design asset in runtime: ${name}`);
  }
}
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
for (const match of html.matchAll(/farming-2\/([^"'<>\s]+)/g)) {
  assert(fs.statSync(path.join(root, 'dist/farming-2', match[1])).isFile(), `Missing HTML icon: ${match[1]}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/farming-2/site.webmanifest'), 'utf8'));
for (const icon of manifest.icons) assert(fs.statSync(path.join(root, 'dist/farming-2', icon.src)).isFile());
const sheet = require('xlsx');
const workbook = sheet.utils.book_new();
sheet.utils.book_append_sheet(workbook, sheet.utils.aoa_to_sheet([['中文', 42], ['café', '终端']]), 'Sheet');
for (const bookType of ['xlsx', 'biff8']) {
  const bytes = sheet.write(workbook, { type: 'buffer', bookType });
  const restored = sheet.read(bytes, { type: 'buffer' });
  assert.deepEqual(sheet.utils.sheet_to_json(restored.Sheets.Sheet, { header: 1 }), [['中文', 42], ['café', '终端']]);
}
const tables = require('xlsx/dist/cpexcel.js');
assert.equal(tables.utils.decode(936, tables.utils.encode(936, '中文')), '中文');
// Exercise every retained SDK runtime export, not just its top-level entry.
const sdkRoot = path.join(root, 'node_modules/@agentclientprotocol/sdk');
const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
for (const target of Object.values(sdk.exports)) {
  if (typeof target === 'object') await import(pathToFileURL(path.join(sdkRoot, target.import)).href);
  else assert(fs.statSync(path.join(sdkRoot, target)).isFile());
}
console.log('Verified product/PWA icons, Excel and legacy code pages, and all ACP SDK runtime exports.');
