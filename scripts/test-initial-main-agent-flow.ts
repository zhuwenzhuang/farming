#!/usr/bin/env -S npx tsx

import puppeteer from 'puppeteer';

async function run() {
  const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3011';
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.on('dialog', async (dialog) => {
      console.log('browser-dialog:', dialog.message());
      await dialog.dismiss();
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#input-dialog.active');

    const titleBefore = await page.$eval('#dialog-title', (el) => el.textContent?.trim() || '');
    const items = await page.$$eval('#agent-list .agent-item .name', (els) =>
      els.map((el) => el.textContent?.trim() || '')
    );

    const agentCards = await page.$$('#agent-list .agent-item');
    let clickIndex = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].includes('bash')) {
        clickIndex = i;
        break;
      }
    }

    await agentCards[clickIndex].click();
    await new Promise((resolve) => setTimeout(resolve, 3200));

    const result = await page.evaluate(() => {
      const inputDialog = document.getElementById('input-dialog');
      const mapArea = document.getElementById('map-area');
      const emptyState = document.getElementById('empty-state');
      const mainAgentPanel = document.getElementById('main-agent-panel');
      const dialogTitle = document.getElementById('dialog-title');
      if (!inputDialog || !mapArea || !emptyState || !mainAgentPanel || !dialogTitle) {
        throw new Error('Expected initial Main Agent fixture elements');
      }
      return {
        dialogActive: inputDialog.classList.contains('active'),
        mapHidden: mapArea.classList.contains('hidden'),
        emptyVisible: getComputedStyle(emptyState).display !== 'none',
        mainAgentPanelVisible: getComputedStyle(mainAgentPanel).display !== 'none',
        mainAgentTitle: dialogTitle.textContent?.trim() || '',
      };
    });

    console.log(JSON.stringify({
      titleBefore,
      items,
      clickedAgent: items[clickIndex],
      ...result,
    }, null, 2));

    if (result.dialogActive) {
      throw new Error('Input dialog is still active after starting the first main agent');
    }
    if (result.mapHidden) {
      throw new Error('Main map is still hidden after starting the first main agent');
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
