// Opt-in acceptance against an already-running instance and existing real sessions.
// Never starts an Agent, sends a prompt, or substitutes transcript responses.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

async function main() {
  const url = new URL(required('FARMING_CAPTURE_URL'));
  const target: { agentId: string; childTitle: string; mainText: string; peerText: string; childTexts: string[] } =
    JSON.parse(await fs.readFile(required('FARMING_CAPTURE_EXPECTATIONS'), 'utf8'));
  if (![target.agentId, target.childTitle, target.mainText, target.peerText].every(value => typeof value === 'string' && value.length)
    || !Array.isArray(target.childTexts) || !target.childTexts.length
    || !target.childTexts.every(value => typeof value === 'string' && value.length)) throw new Error('Invalid capture expectations');
  if (process.env.FARMING_CAPTURE_TOKEN_FILE) {
    url.searchParams.set('token', (await fs.readFile(process.env.FARMING_CAPTURE_TOKEN_FILE, 'utf8')).trim());
  }
  url.searchParams.set('ftarget', 'agent');
  url.searchParams.set('agent', target.agentId);
  const output = path.resolve(required('FARMING_CAPTURE_OUTPUT'));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.FARMING_PLAYWRIGHT_CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await page.goto(url.href);
    const row = page.getByTestId('code-agent-row').and(page.locator(`[data-agent-id="${target.agentId}"]`));
    await row.click();
    await row.hover();
    const toggle = row.getByTestId('code-agent-row-related-visibility');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    const finished = page.getByTestId('code-native-related-finished');
    if (await finished.count() && await finished.getAttribute('open') === null) await finished.locator('summary').click();
    const childRow = page.getByTestId('code-native-related-row').filter({ has: page.getByText(target.childTitle, { exact: true }) });
    await childRow.click();
    const panel = page.getByTestId('code-related-session-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('p').getByText(target.mainText, { exact: true })).toBeVisible();
    await expect(page.locator('.code-agent-transcript-peer-message').getByText(target.peerText, { exact: true })).toBeVisible();
    for (const text of target.childTexts) await expect(panel.locator('p').getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByTestId('code-agent-transcript-missing-final-reply')).toHaveCount(0);
    await expect(panel.getByTestId('code-agent-peer-receipts')).toHaveCount(1);
    await expect(panel.locator('.code-agent-transcript-message-unavailable')).toBeHidden();
    for (const appearance of ['light', 'dark', 'paper']) {
      // Appearance preview stays in this disposable browser context.
      await page.evaluate(value => {
        document.body.dataset.appearance = value;
        document.documentElement.dataset.appearance = value;
      }, appearance);
      await page.evaluate(() => document.fonts.ready);
      const image = await page.screenshot({ path: path.join(output, `${appearance}.png`), animations: 'disabled' });
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([1800, 1100]);
    }
    await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({
      ...target, appearances: ['light', 'dark', 'paper'], viewport: [1800, 1100], passed: true,
    }, null, 2));
    console.log(`Real Agent progress accepted; screenshots: ${output}`);
  } finally { await browser.close(); }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
