import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:5189/farming/';
const output = path.resolve(process.argv[3] || '.tmp/installation-docs');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const locale of ['cn', 'en']) {
    for (const theme of ['light', 'dark', 'paper']) {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'],
        });
        try {
          const page = await context.newPage();
          await page.goto(`${base}${locale}/?theme=${theme}`, { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready);
          const methods = page.locator('.home-install-methods');
          const copy = page.locator('.home-install-copy');
          const npm = methods.getByRole('button', { name: locale === 'cn' ? 'npm 安装' : 'npm install', exact: true });
          const local = methods.getByRole('button', { name: locale === 'cn' ? '指定目录安装' : 'Directory install', exact: true });
          await expect(npm).toHaveAttribute('aria-pressed', 'true');
          for (const method of ['npm', 'local']) {
            const selected = method === 'npm' ? npm : local;
            const other = method === 'npm' ? local : npm;
            await selected.focus();
            await page.keyboard.press('Enter');
            await expect(selected).toHaveAttribute('aria-pressed', 'true');
            const command = page.locator('.home-install-command');
            const expected = method === 'npm'
              ? 'npm install --global farming-code@latest\nfarming daemon'
              : [
                  'curl -fLO https://zhuwenzhuang.github.io/farming/farming_install.sh',
                  'bash farming_install.sh --dir ~/farming',
                  'cd ~/farming',
                  './farming daemon',
                ].join('\n');
            assert.equal(await command.locator('code').textContent(), expected);
            if (method === 'local') {
              const pending = page.waitForEvent('download');
              await page.locator('.home-install a[download]').click();
              const download = await pending;
              assert.equal(download.suggestedFilename(), 'farming_install.sh');
              assert.equal(fs.readFileSync(await download.path(), 'utf8'),
                fs.readFileSync(new URL('../bin/install.sh', import.meta.url), 'utf8'));
            }
            const panel = page.locator('.home-install-panel');
            const box = await panel.boundingBox();
            const actions = await page.locator('.VPHero .actions').boundingBox();
            assert(box && actions && box.y >= actions.y + actions.height,
              'Install command must appear below the Quick Start actions');
            const install = await page.locator('.home-install').boundingBox();
            assert(install && install.y + install.height < page.viewportSize().height,
              'Install command panel must remain on the first screen');
            assert(await page.locator('.home-install-header').evaluate(element => element.scrollWidth <= element.clientWidth),
              'Header controls and requirements must fit without overflow');
            await expect(page.locator('.home-install-header .home-install-requirement')).toBeVisible();
            if (method === 'local') await expect(page.locator('.home-install-header .home-install-links')).toBeVisible();
            assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth),
              'Command panel must wrap without horizontal overflow');
            const headerBeforeCopy = await page.locator('.home-install-header').boundingBox();
            await copy.click();
            assert.deepEqual(await page.locator('.home-install-header').boundingBox(), headerBeforeCopy,
              'Copy feedback must not resize the header');
            await expect(copy).toHaveText(locale === 'cn' ? '已复制' : 'Copied');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
            await other.click();
            await selected.click();
            await expect(copy).toHaveText(locale === 'cn' ? '复制' : 'Copy');
            await page.mouse.move(0, 0);
            await selected.blur();
            const file = path.join(output, `${locale}-${theme}-${mobile ? 'mobile' : 'desktop'}-${method}.png`);
            await page.screenshot({ path: file, animations: 'disabled' });
            await panel.screenshot({ path: file.replace('.png', '-panel.png'), animations: 'disabled' });
            console.log(file);
          }
          await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
          await copy.click();
          await expect(page.locator('.home-install-feedback')).toHaveText(locale === 'cn'
            ? '请选中上方命令复制。' : 'Select the command above to copy it.');
          await npm.click();
          await expect(page.locator('.home-install-requirement')).toContainText('Node.js 22.13+');
          await page.goto(`${base}${locale}/get-started/installation`, { waitUntil: 'networkidle' });
          const pending = page.waitForEvent('download');
          await page.locator('.vp-doc a[download]').click();
          const download = await pending;
          assert.equal(download.suggestedFilename(), 'farming_install.sh');
          assert.equal(fs.readFileSync(await download.path(), 'utf8'),
            fs.readFileSync(new URL('../bin/install.sh', import.meta.url), 'utf8'));
        } finally { await context.close(); }
      }
    }
  }
} finally { await browser.close(); }
