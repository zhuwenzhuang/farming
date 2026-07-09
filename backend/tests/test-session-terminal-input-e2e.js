const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
}

async function openDisposableShellSession(page) {
  return startDisposableSession(page, 'bash');
}

async function startDisposableSession(page, agentName) {
  const workspace = path.join(os.tmpdir(), `farming-e2e-${Date.now()}`);
  fs.mkdirSync(workspace, { recursive: true });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !document.documentElement.innerHTML.includes('xterm.min.js'));
  await page.waitForFunction(() => Boolean(window.FarmingTerminalBridge));
  await page.waitForSelector('#input-dialog.active, .agent-block, #main-agent-block', { timeout: 10000 });
  const dialogAlreadyActive = await page.$('#input-dialog.active');
  if (!dialogAlreadyActive) {
    await page.click('.sidebar-item');
    await page.waitForSelector('#input-dialog.active', { timeout: 10000 });
  }

  await page.waitForFunction(
    (expectedAgent) => Array.from(document.querySelectorAll('.agent-item .name')).some((node) => node.textContent.includes(expectedAgent)),
    {},
    agentName
  );
  await page.evaluate((expectedAgent) => {
    const item = Array.from(document.querySelectorAll('.agent-item')).find((node) => node.textContent.includes(expectedAgent));
    if (!item) throw new Error(`${expectedAgent} list item not found`);
    item.click();
  }, agentName);
  await page.waitForSelector('#workspace-input-container', { timeout: 5000 });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('workspace-input-container')).display !== 'none',
    { timeout: 5000 }
  );
  await page.$eval('#workspace-input', (input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, workspace);
  await page.evaluate(() => {
    const startButton = Array.from(document.querySelectorAll('#workspace-input-container button'))
      .find((button) => (button.textContent || '').includes('Start'));
    if (!startButton) throw new Error('Start button not found');
    startButton.click();
  });

  await page.waitForFunction(
    (expectedWorkspace) => Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .some((el) => (el.textContent || '').includes(expectedWorkspace)),
    { timeout: 30000 },
    workspace
  );

  const opened = await page.evaluate((expectedWorkspace) => {
    const existing = Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .find((el) => (el.textContent || '').includes(expectedWorkspace));
    if (existing) {
      existing.click();
      return true;
    }
    return false;
  }, workspace);

  if (!opened) {
    throw new Error(`Disposable ${agentName} session not found or failed to start`);
  }

  await page.waitForSelector('#session-modal.active', { timeout: 15000 });
  await page.click('#terminal-output');
  const terminalKind = await page.evaluate(async () => {
    const bundle = await window.FarmingTerminalBridge.createInstance();
    const kind = bundle && bundle.kind;
    if (bundle && bundle.terminal && typeof bundle.terminal.dispose === 'function') {
      bundle.terminal.dispose();
    }
    return kind;
  });
  assert.strictEqual(terminalKind, 'ghostty');
  await page.evaluate(() => {
    window.__sentInputs = [];
    const originalSend = WebSocket.prototype.send;
    if (!window.__patchedSessionInputE2E) {
      WebSocket.prototype.send = function patchedSend(payload) {
        try {
          const data = JSON.parse(payload);
          if (data.type === 'input') {
            window.__sentInputs.push(data.input);
          }
        } catch {
          // Ignore non-JSON WebSocket payloads.
        }
        return originalSend.call(this, payload);
      };
      window.__patchedSessionInputE2E = true;
    }
  });

  return { workspace, agentName };
}

async function sampleTerminalCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#terminal-output canvas');
    if (!canvas) {
      return { hasCanvas: false, nonBackgroundSamples: 0, totalSamples: 0 };
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { hasCanvas: true, readable: false, nonBackgroundSamples: 0, totalSamples: 0 };
    }

    const { width, height } = canvas;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
    let nonBackgroundSamples = 0;
    let totalSamples = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const pixel = context.getImageData(x, y, 1, 1).data;
        totalSamples += 1;
        const isNearBackground =
          pixel[3] > 0 &&
          pixel[0] < 20 &&
          pixel[1] < 30 &&
          pixel[2] < 20;
        if (!isNearBackground) {
          nonBackgroundSamples += 1;
        }
      }
    }

    return { hasCanvas: true, readable: true, nonBackgroundSamples, totalSamples };
  });
}

async function closeSessionModal(page) {
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('Escape');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.waitForFunction(
    () => !document.getElementById('session-modal').classList.contains('active'),
    { timeout: 5000 }
  );
}

async function getSessionLayoutMetrics(page) {
  return page.evaluate(() => {
    const toPlainRect = (rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    });

    const modal = document.querySelector('#session-modal .modal-content');
    const header = document.querySelector('#session-modal .modal-header');
    const terminal = document.getElementById('terminal-output');
    const canvas = document.querySelector('#terminal-output canvas');

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      modalRect: modal ? toPlainRect(modal.getBoundingClientRect()) : null,
      headerRect: header ? toPlainRect(header.getBoundingClientRect()) : null,
      terminalRect: terminal ? toPlainRect(terminal.getBoundingClientRect()) : null,
      canvasRect: canvas ? toPlainRect(canvas.getBoundingClientRect()) : null
    };
  });
}

async function openClaudeFromDialog(page, startAgent = false) {
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  const dialogAlreadyActive = await page.$('#input-dialog.active');
  if (!dialogAlreadyActive) {
    await page.click('.sidebar-item');
    await page.waitForSelector('#input-dialog.active', { timeout: 10000 });
  }
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.agent-item .name')).some((node) => node.textContent.includes('claude')));

  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('.agent-item')).find((node) => node.textContent.includes('claude'));
    if (!item) throw new Error('Claude list item not found');
    item.click();
  });

  await page.waitForSelector('#workspace-input-container', { timeout: 5000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('workspace-input-container')).display !== 'none');

  if (startAgent) {
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.agent-block, #main-agent-block')).some((node) =>
        (node.textContent || '').toLowerCase().includes('claude')
      ),
      { timeout: 15000 }
    );
  }
}

async function openAgentWorkspaceDialog(page, agentName) {
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  const dialogAlreadyActive = await page.$('#input-dialog.active');
  if (!dialogAlreadyActive) {
    await page.click('.sidebar-item');
    await page.waitForSelector('#input-dialog.active', { timeout: 10000 });
  }

  await page.waitForFunction(
    (expectedAgent) => Array.from(document.querySelectorAll('.agent-item .name')).some((node) => node.textContent.includes(expectedAgent)),
    {},
    agentName
  );
  await page.evaluate((expectedAgent) => {
    const item = Array.from(document.querySelectorAll('.agent-item')).find((node) => node.textContent.includes(expectedAgent));
    if (!item) throw new Error(`${expectedAgent} list item not found`);
    item.click();
  }, agentName);

  await page.waitForSelector('#workspace-input-container', { timeout: 5000 });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('workspace-input-container')).display !== 'none',
    { timeout: 5000 }
  );
}

async function clickWorkspaceStartButton(page) {
  await page.evaluate(() => {
    const startButton = Array.from(document.querySelectorAll('#workspace-input-container button'))
      .find((button) => (button.textContent || '').includes('Start'));
    if (!startButton) throw new Error('Start button not found');
    startButton.click();
  });
}

async function getSentInputs(page) {
  return page.evaluate(() => window.__sentInputs || []);
}

async function clearSentInputs(page) {
  await page.evaluate(() => {
    window.__sentInputs = [];
  });
}

async function getImeInputHandle(page) {
  await page.waitForFunction(() => {
    return Boolean(
      document.querySelector('#session-modal input[aria-hidden="true"]') ||
      document.querySelector('#terminal-output textarea[aria-label="Terminal input"]')
    );
  }, { timeout: 10000 });

  return page.evaluateHandle(() => {
    return document.querySelector('#session-modal input[aria-hidden="true"]') ||
      document.querySelector('#terminal-output textarea[aria-label="Terminal input"]');
  });
}

async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });

  const bashSession = await openDisposableShellSession(page);
  await page.evaluate(() => window.pasteTerminalText('printf "surface-bash\\n"\\r'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const firstCanvas = await sampleTerminalCanvas(page);
  assert.strictEqual(firstCanvas.hasCanvas, true);
  assert.strictEqual(firstCanvas.readable, true);
  assert.strictEqual(firstCanvas.nonBackgroundSamples > 10, true);

  await clearSentInputs(page);
  await page.keyboard.type('abc');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(await getSentInputs(page), ['a', 'b', 'c']);

  await clearSentInputs(page);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Backspace');
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    }));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const controlInputs = await getSentInputs(page);
  assert.strictEqual(controlInputs.includes('\r'), true);
  assert.strictEqual(controlInputs.includes('\x7f'), true);

  await clearSentInputs(page);
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const escapeInputs = await getSentInputs(page);
  assert.strictEqual(escapeInputs.includes('\x1b'), true);
  const stillActiveAfterSingleEscape = await page.$eval('#session-modal', (node) => node.classList.contains('active'));
  assert.strictEqual(stillActiveAfterSingleEscape, true);

  const dialogEnterWorkspace = path.join(os.tmpdir(), `farming-dialog-enter-${Date.now()}`);
  fs.mkdirSync(dialogEnterWorkspace, { recursive: true });
  await clearSentInputs(page);
  await page.evaluate(() => {
    window.showInputDialog();
  });
  await page.waitForSelector('#input-dialog.active', { timeout: 5000 });
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('.agent-item')).find((node) => node.textContent.includes('bash'));
    if (!item) throw new Error('bash list item not found');
    item.click();
  });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('workspace-input-container')).display !== 'none',
    { timeout: 5000 }
  );
  await page.$eval('#workspace-input', (input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, dialogEnterWorkspace);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (expectedWorkspace) => Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .some((node) => (node.textContent || '').includes(expectedWorkspace)),
    { timeout: 15000 },
    dialogEnterWorkspace
  );
  const enterWhileDialogInputs = await getSentInputs(page);
  assert.strictEqual(enterWhileDialogInputs.includes('\r'), false);
  await page.waitForFunction(
    () => !document.getElementById('input-dialog').classList.contains('active'),
    { timeout: 5000 }
  );

  await clearSentInputs(page);
  const imeInput = await getImeInputHandle(page);
  await page.evaluate((input) => {
    if (!input) throw new Error('hidden bridge input not found');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true, cancelable: true }));
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true, cancelable: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true, cancelable: true }));
  }, imeInput);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const imeInputs = await getSentInputs(page);
  assert.strictEqual(Array.isArray(imeInputs), true);
  if (imeInputs.length > 0) {
    assert.deepStrictEqual(imeInputs, ['你好']);
  }

  await clearSentInputs(page);
  await page.evaluate(() => {
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    pasteEvent.clipboardData.setData('text/plain', 'paste check');
    document.dispatchEvent(pasteEvent);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(await getSentInputs(page), ['paste check']);

  await closeSessionModal(page);
  const clearedSurface = await page.evaluate(() => ({
    active: document.getElementById('session-modal').classList.contains('active'),
    htmlLen: document.getElementById('terminal-output').innerHTML.length,
    canvasCount: document.querySelectorAll('#terminal-output canvas').length
  }));
  assert.strictEqual(clearedSurface.active, false);
  assert.strictEqual(clearedSurface.htmlLen, 0);
  assert.strictEqual(clearedSurface.canvasCount, 0);

  await page.evaluate((expectedWorkspace) => {
    const target = Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .find((node) => (node.textContent || '').includes(expectedWorkspace));
    if (!target) {
      throw new Error(`session block for ${expectedWorkspace} not found`);
    }
    target.click();
  }, bashSession.workspace);
  await page.waitForSelector('#session-modal.active', { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const reopenedCanvas = await sampleTerminalCanvas(page);
  assert.strictEqual(reopenedCanvas.hasCanvas, true);
  assert.strictEqual(reopenedCanvas.readable, true);
  assert.strictEqual(reopenedCanvas.nonBackgroundSamples > 10, true);

  await closeSessionModal(page);

  const zshPage = await browser.newPage();
  await zshPage.setViewport({ width: 960, height: 620, deviceScaleFactor: 1 });
  await startDisposableSession(zshPage, 'zsh');
  await zshPage.evaluate(() => window.pasteTerminalText('printf "surface-zsh\\n"\\r'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const zshCanvas = await sampleTerminalCanvas(zshPage);
  assert.strictEqual(zshCanvas.hasCanvas, true);
  assert.strictEqual(zshCanvas.readable, true);
  assert.strictEqual(zshCanvas.nonBackgroundSamples > 0, true);
  const zshLayout = await getSessionLayoutMetrics(zshPage);
  assert.strictEqual(zshLayout.modalRect.right <= zshLayout.viewport.width, true);
  assert.strictEqual(zshLayout.modalRect.bottom <= zshLayout.viewport.height, true);
  assert.strictEqual(zshLayout.headerRect.bottom <= zshLayout.terminalRect.top, true);
  assert.strictEqual(zshLayout.canvasRect.right <= zshLayout.terminalRect.right + 1, true);
  assert.strictEqual(zshLayout.canvasRect.bottom <= zshLayout.terminalRect.bottom + 1, true);
  const zshTitle = await zshPage.$eval('#session-title', (node) => node.textContent || '');
  assert.strictEqual(zshTitle.toLowerCase().includes('zsh'), true);

  const dialogPage = await browser.newPage();
  await dialogPage.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
  await openClaudeFromDialog(dialogPage);
  const dialogState = await dialogPage.evaluate(() => ({
    listDisplay: getComputedStyle(document.getElementById('agent-list')).display,
    workspaceDisplay: getComputedStyle(document.getElementById('workspace-input-container')).display,
    dialogActive: document.getElementById('input-dialog').classList.contains('active'),
    workspaceValue: document.getElementById('workspace-input').value,
    historyVisible: getComputedStyle(document.getElementById('workspace-history')).display !== 'none',
    historyItems: Array.from(document.querySelectorAll('#workspace-history-list .workspace-history-item')).map((node) => node.textContent || ''),
  }));
  assert.strictEqual(dialogState.listDisplay, 'none');
  assert.notStrictEqual(dialogState.workspaceDisplay, 'none');
  assert.strictEqual(dialogState.dialogActive, true);
  assert.strictEqual(dialogState.workspaceValue, '');
  assert.strictEqual(dialogState.historyVisible, true);

  await dialogPage.keyboard.press('ArrowDown');
  const historyVisibleAfterArrow = await dialogPage.$eval('#workspace-history', (node) => getComputedStyle(node).display !== 'none');
  assert.strictEqual(historyVisibleAfterArrow, true);
  const historyItems = await dialogPage.$$eval('#workspace-history-list .workspace-history-item', (nodes) => nodes.map((node) => node.textContent || ''));
  assert.strictEqual(historyItems.length >= 2, true);
  const firstHistoryValue = await dialogPage.$eval('#workspace-input', (node) => node.value);
  assert.strictEqual(firstHistoryValue.length > 0, true);

  await dialogPage.keyboard.press('ArrowDown');
  const secondHistoryValue = await dialogPage.$eval('#workspace-input', (node) => node.value);
  assert.strictEqual(secondHistoryValue.length > 0, true);
  assert.notStrictEqual(secondHistoryValue, firstHistoryValue);
  await dialogPage.close();

  const enterPage = await browser.newPage();
  await enterPage.setViewport({ width: 1400, height: 960, deviceScaleFactor: 1 });
  await openAgentWorkspaceDialog(enterPage, 'bash');
  const enterWorkspace = path.join(os.tmpdir(), `farming-enter-${Date.now()}`);
  fs.mkdirSync(enterWorkspace, { recursive: true });
  await enterPage.$eval('#workspace-input', (input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, enterWorkspace);
  await enterPage.keyboard.press('Enter');
  await enterPage.waitForFunction(
    (expectedWorkspace) => Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .some((node) => (node.textContent || '').includes(expectedWorkspace)),
    { timeout: 15000 },
    enterWorkspace
  );
  await enterPage.close();

  const retryPage = await browser.newPage();
  await retryPage.setViewport({ width: 1400, height: 960, deviceScaleFactor: 1 });
  await openAgentWorkspaceDialog(retryPage, 'bash');
  await retryPage.evaluate(() => {
    window.__lastAlertMessage = null;
    window.alert = (message) => {
      window.__lastAlertMessage = message;
    };
  });
  await retryPage.$eval('#workspace-input', (input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, '/definitely/not/a/real/workspace');
  await clickWorkspaceStartButton(retryPage);
  await retryPage.waitForFunction(
    () => typeof window.__lastAlertMessage === 'string' && window.__lastAlertMessage.includes('Workspace does not exist'),
    { timeout: 10000 }
  );
  const retryStateAfterError = await retryPage.evaluate(() => ({
    dialogActive: document.getElementById('input-dialog').classList.contains('active'),
    workspaceVisible: getComputedStyle(document.getElementById('workspace-input-container')).display !== 'none',
    agentListVisible: getComputedStyle(document.getElementById('agent-list')).display !== 'none',
    workspaceValue: document.getElementById('workspace-input').value
  }));
  assert.strictEqual(retryStateAfterError.dialogActive, true);
  assert.strictEqual(retryStateAfterError.workspaceVisible, true);
  assert.strictEqual(retryStateAfterError.agentListVisible, false);
  assert.strictEqual(retryStateAfterError.workspaceValue, '/definitely/not/a/real/workspace');

  const retryWorkspace = path.join(os.tmpdir(), `farming-retry-${Date.now()}`);
  fs.mkdirSync(retryWorkspace, { recursive: true });
  await retryPage.$eval('#workspace-input', (input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, retryWorkspace);
  await clickWorkspaceStartButton(retryPage);
  await retryPage.waitForFunction(
    (expectedWorkspace) => Array.from(document.querySelectorAll('.agent-block, #main-agent-block'))
      .some((node) => (node.textContent || '').includes(expectedWorkspace)),
    { timeout: 15000 },
    retryWorkspace
  );
  await retryPage.close();

  await page.evaluate(() => {
    const killButton = Array.from(document.querySelectorAll('button')).find((button) =>
      (button.textContent || '').includes('Kill')
    );
    if (killButton) {
      killButton.click();
    }
  });
  await zshPage.evaluate(() => {
    const killButton = Array.from(document.querySelectorAll('button')).find((button) =>
      (button.textContent || '').includes('Kill')
    );
    if (killButton) {
      killButton.click();
    }
  });
  await zshPage.close();

  console.log('test-session-terminal-input-e2e passed');
  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
