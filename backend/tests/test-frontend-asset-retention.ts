import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { FRONTEND_ASSET_RETENTION_MS, preserveFrontendAssets } from '../../scripts/preserve-frontend-assets';

async function run() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-asset-retention-')));
  const assets = path.join(root, 'dist/assets');
  const cache = path.join(root, '.tmp/frontend-assets');
  let now = Date.now();
  const compile = () => build({
    configFile: false, root, logLevel: 'silent',
    plugins: [{ name: 'retain-test-assets', buildStart: () => preserveFrontendAssets(root, now) }],
    build: { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false } },
  });
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await fs.writeFile(path.join(root, 'main.js'), 'window.openEditor = () => import("./editor.js");');
    await fs.writeFile(path.join(root, 'editor.js'), 'export const version = "previous";');
    await compile();
    const previous = (await fs.readdir(assets)).find(name => name.startsWith('editor-'))!;
    const previousBytes = await fs.readFile(path.join(assets, previous));
    await fs.writeFile(path.join(root, 'editor.js'), 'export const version = "current";');
    await compile();
    assert(!(await fs.readdir(assets)).includes(previous), 'dist contains only the current release assets');
    assert.deepEqual(await fs.readFile(path.join(cache, previous)), previousBytes, 'old lazy chunks survive Vite cleanup');
    now += FRONTEND_ASSET_RETENTION_MS / 2;
    await preserveFrontendAssets(root, now);
    assert.deepEqual(await fs.readFile(path.join(cache, previous)), previousBytes);
    now += FRONTEND_ASSET_RETENTION_MS / 2 + 1000;
    await preserveFrontendAssets(root, now);
    await assert.rejects(fs.stat(path.join(cache, previous)), { code: 'ENOENT' });
    for (const name of await fs.readdir(assets)) {
      assert.deepEqual(await fs.readFile(path.join(cache, name)), await fs.readFile(path.join(assets, name)));
    }
    console.log('✓ Rebuilds retain exact old lazy chunks outside the release and prune expired assets');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
