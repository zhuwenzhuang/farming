import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:5189/farming/';
const output = path.resolve(process.argv[3] || '.tmp/installation-docs');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const expected = 'npm install --global farming-code@latest\nfarming daemon';
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
          const panel = page.locator('.home-install-panel');
          const copy = page.locator('.home-install-copy');
          await expect(panel.locator('code')).toHaveText(expected);
          await expect(panel.locator('.home-install-requirement')).toHaveCount(0);
          const box = await panel.boundingBox();
          const actions = await page.locator('.VPHero .actions').boundingBox();
          assert(box && actions && box.y >= actions.y + actions.height);
          assert(box.y + box.height < page.viewportSize().height, 'Install commands stay on the first screen');
          assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth));
          const beforeCopy = await panel.boundingBox();
          await copy.focus();
          await page.keyboard.press('Enter');
          await expect(copy).toHaveText(locale === 'cn' ? '已复制' : 'Copied');
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
          assert.deepEqual(await panel.boundingBox(), beforeCopy);
          await copy.blur();
          await page.mouse.move(0, 0);
          const prefix = path.join(output, `${locale}-${theme}-${mobile ? 'mobile' : 'desktop'}`);
          await page.screenshot({ path: `${prefix}-home.png`, animations: 'disabled' });
          await panel.screenshot({ path: `${prefix}-install-panel.png`, animations: 'disabled' });
          const icon = page.locator('.docs-card-provider-icons img[alt="Antigravity"]:visible').first();
          await expect(icon).toBeVisible();
          await expect.poll(() => icon.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
          await page.locator('.docs-card-provider-icons').first().screenshot({ path: `${prefix}-providers.png` });
          const codeCard = page.locator('.docs-card').filter({ has: page.locator('strong', { hasText: /^Farming Code$/ }) });
          await expect(codeCard.locator('.docs-card-provider-icons')).toHaveCount(1);
          await expect(page.locator('.docs-card[href="./code/mobile-and-remote"] .docs-card-provider-icons')).toHaveCount(0);
          await codeCard.screenshot({ path: `${prefix}-code-card.png`, animations: 'disabled' });
          await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
          await copy.click();
          await expect(page.locator('.home-install-feedback')).toHaveText(locale === 'cn'
            ? '请选中上方命令复制。' : 'Select the command above to copy it.');
          await page.goto(`${base}${locale}/get-started/installation?theme=${theme}`, { waitUntil: 'networkidle' });
          await expect(page.locator('.vp-doc')).toContainText('npm install --global farming-code@latest');
          await page.screenshot({ path: `${prefix}-installation.png`, fullPage: true, animations: 'disabled' });
          console.log(prefix);
        } finally { await context.close(); }
      }
    }
  }
} finally { await browser.close(); }
