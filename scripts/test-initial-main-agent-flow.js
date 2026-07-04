const puppeteer = require('puppeteer');

async function run() {
  const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3011';
  const browser = await puppeteer.launch({ headless: 'new' });

  try {
    const page = await browser.newPage();
    page.on('dialog', async (dialog) => {
      console.log('browser-dialog:', dialog.message());
      await dialog.dismiss();
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#input-dialog.active');

    const titleBefore = await page.$eval('#dialog-title', (el) => el.textContent.trim());
    const items = await page.$$eval('#agent-list .agent-item .name', (els) =>
      els.map((el) => el.textContent.trim())
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

    const result = await page.evaluate(() => ({
      dialogActive: document.getElementById('input-dialog').classList.contains('active'),
      mapHidden: document.getElementById('map-area').classList.contains('hidden'),
      emptyVisible: getComputedStyle(document.getElementById('empty-state')).display !== 'none',
      mainAgentPanelVisible: getComputedStyle(document.getElementById('main-agent-panel')).display !== 'none',
      mainAgentTitle: document.getElementById('dialog-title').textContent.trim(),
    }));

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
