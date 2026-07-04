#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_BASE_PATH = '/farming';

function log(message) {
  console.log(`==> ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function commandProgram(command) {
  return String(command || '').trim().split(/\s+/)[0] || '';
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForOutputUrl(child, port) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for local server URL on port ${port}\n${output}`));
    }, 20000);

    const onData = (chunk) => {
      output += chunk.toString();
      if (process.env.FARMING_E2E_VERBOSE === '1') {
        process.stdout.write(chunk);
      }
      const match = output.match(new RegExp(`http://localhost:${port}[^\\s]+`));
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Local server exited before URL was printed: ${code}\n${output}`));
    });
  });
}

async function startLocalServer() {
  const port = Number(process.env.FARMING_E2E_PORT || await getFreePort());
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-e2e-config-'));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: process.env.FARMING_BASE_PATH || DEFAULT_BASE_PATH,
      FARMING_CONFIG_DIR: configDir,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = await waitForOutputUrl(child, port);
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await sleep(500);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function getRemoteUrl() {
  if (process.env.FARMING_E2E_REMOTE_URL) {
    return process.env.FARMING_E2E_REMOTE_URL;
  }

  throw new Error(
    'Set FARMING_E2E_REMOTE_URL to the printed /farming?token=... URL before running remote E2E.'
  );
}

function getRemoteWorkspace() {
  if (process.env.FARMING_E2E_REMOTE_WORKSPACE) {
    return process.env.FARMING_E2E_REMOTE_WORKSPACE;
  }

  throw new Error('Set FARMING_E2E_REMOTE_WORKSPACE to an existing project path on the remote host.');
}

function appPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

function wsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname.replace(/\/$/, '');
  const token = url.searchParams.get('token') || '';
  return `${protocol}//${url.host}${basePath}/ws${token ? `?token=${token}` : ''}`;
}

async function fetchJson(baseUrl, suffix) {
  const response = await fetch(appPath(baseUrl, suffix));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${suffix}: ${await response.text()}`);
  }
  return response.json();
}

class StateTracker {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.state = null;
    this.errors = [];
    this.previewByAgentId = new Map();
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(wsUrl(this.baseUrl));
    this.ws.on('message', (buffer) => {
      const message = JSON.parse(buffer.toString());
      if (message.type === 'state') {
        this.state = message.state;
      } else if (message.type === 'error') {
        this.errors.push(message.message);
      } else if (message.type === 'session-preview') {
        this.previewByAgentId.set(message.preview.agentId, message.preview);
      }
      this.flushWaiters();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting WebSocket')), 10000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', reject);
    });

    await this.waitFor(() => this.state, 'initial state');
    return this;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await sleep(200);
  }

  waitFor(predicate, label, timeout = 30000) {
    const current = predicate(this.state, this);
    if (current) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        label,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(item => item !== waiter);
          reject(new Error(`Timed out waiting for ${label}. Last errors: ${this.errors.join(' | ') || 'none'}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  flushWaiters() {
    const waiters = [...this.waiters];
    for (const waiter of waiters) {
      const result = waiter.predicate(this.state, this);
      if (!result) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter(item => item !== waiter);
      waiter.resolve(result);
    }
  }
}

async function startAgentViaWs(tracker, command, workspace, asMain = false) {
  const before = new Set((tracker.state?.agents || []).map(agent => agent.id));
  tracker.send({ type: 'start-agent', command, workspace, asMain });
  return tracker.waitFor((state) => {
    const agent = state?.agents.find(item => (
      !before.has(item.id) &&
      item.command === commandProgram(command) &&
      item.status === 'running'
    ));
    return agent || null;
  }, `${command} running`, 45000);
}

async function ensureMainAgent(tracker, workspace) {
  const currentMain = tracker.state?.agents.find(agent => agent.id === tracker.state.mainAgentId && agent.status === 'running');
  if (currentMain) return currentMain;
  return startAgentViaWs(tracker, 'bash', workspace, true);
}

async function cleanupCreatedAgents(tracker, initialIds) {
  if (process.env.FARMING_E2E_KEEP_AGENTS === '1') {
    log('Keeping E2E-created agents because FARMING_E2E_KEEP_AGENTS=1');
    return;
  }

  const currentAgents = tracker.state?.agents || [];
  currentAgents
    .filter(agent => !initialIds.has(agent.id))
    .forEach(agent => tracker.send({ type: 'kill-agent', agentId: agent.id }));
  await sleep(1000);
}

async function launchBrowser(viewport) {
  return puppeteer.launch({
    headless: process.env.FARMING_E2E_HEADLESS === 'false' ? false : true,
    protocolTimeout: 90000,
    defaultViewport: viewport,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--proxy-server=direct://',
      '--proxy-bypass-list=*',
    ],
  });
}

async function openAppPage(browser, baseUrl, viewport) {
  const page = await browser.newPage();
  if (viewport) await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => {
    window.__FARMING_E2E__ = true;
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.app-container', { timeout: 15000 });
  return page;
}

async function openNewAgentDialog(page) {
  const opened = await page.$('.input-dialog');
  if (opened) return;

  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sidebar-item')];
    const newAgent = items.find(item => (item.textContent || '').includes('[N]'));
    if (!newAgent) throw new Error('New Agent sidebar item not found');
    newAgent.click();
  });
  await page.waitForSelector('.input-dialog', { timeout: 10000 });
}

async function startAgentFromDialog(page, command, workspace) {
  await openNewAgentDialog(page);
  await page.evaluate((agentName) => {
    const item = [...document.querySelectorAll('.agent-item')]
      .find(node => (node.querySelector('.agent-item-name')?.textContent || '').trim() === agentName);
    if (!item) throw new Error(`${agentName} option not found`);
    item.click();
  }, command);
  await page.waitForSelector('.workspace-input input', { timeout: 10000 });
  await page.click('.workspace-input input', { clickCount: 3 });
  await page.keyboard.type(workspace, { delay: 1 });
  await page.click('.workspace-actions button');
  await page.waitForFunction(() => !document.querySelector('.input-dialog'), { timeout: 10000 });
}

async function assertInvalidWorkspaceRejected(baseUrl, page, command) {
  const invalidWorkspace = `/definitely/not/a/real/workspace-${Date.now()}`;

  await openNewAgentDialog(page);
  await page.evaluate(() => {
    window.__farmingE2eAlert = null;
    window.alert = (message) => {
      window.__farmingE2eAlert = String(message);
    };
  });
  await page.evaluate((agentName) => {
    const item = [...document.querySelectorAll('.agent-item')]
      .find(node => (node.querySelector('.agent-item-name')?.textContent || '').trim() === agentName);
    if (!item) throw new Error(`${agentName} option not found`);
    item.click();
  }, command);
  await page.waitForSelector('.workspace-input input', { timeout: 10000 });
  await page.click('.workspace-input input', { clickCount: 3 });
  await page.keyboard.type(invalidWorkspace, { delay: 1 });
  await page.click('.workspace-actions button');
  await page.waitForFunction(() => (
    typeof window.__farmingE2eAlert === 'string' &&
    window.__farmingE2eAlert.includes('Workspace does not exist')
  ), { timeout: 10000 });

  const retryState = await page.evaluate(() => ({
    dialogOpen: Boolean(document.querySelector('.input-dialog')),
    workspaceValue: document.querySelector('.workspace-input input')?.value || '',
  }));
  assert.strictEqual(retryState.dialogOpen, true, 'workspace error should keep the dialog open');
  assert.strictEqual(retryState.workspaceValue, invalidWorkspace, 'workspace input should remain editable after an error');

  const settings = await fetchJson(baseUrl, '/api/settings');
  assert.ok(
    !(settings.settings?.workspaceHistory || []).includes(invalidWorkspace),
    'invalid workspace should not be persisted to workspace history'
  );

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.input-dialog'), { timeout: 10000 });
}

async function findAgentCard(page, agent) {
  const byId = await page.$(`.agent-block[data-agent-id="${agent.id}"]`);
  if (byId) {
    return byId;
  }

  if (agent.isMain) {
    const main = await page.$('.main-agent-content');
    if (main) return main;
  }

  const handle = await page.waitForFunction((expectedId, expectedCommand) => {
    const cards = [...document.querySelectorAll('.agent-block')];
    return cards.find(card => {
      const text = card.textContent || '';
      const title = card.querySelector('.agent-title-name')?.textContent || '';
      return text.includes(expectedId) || title.toLowerCase().includes(expectedCommand.toLowerCase());
    }) || null;
  }, { timeout: 30000 }, agent.id, agent.command);

  return handle.asElement();
}

async function assertCodingAgentPreview(page, agent) {
  const card = await findAgentCard(page, agent);
  await page.waitForFunction((expectedId, expectedCommand) => {
    const cards = [...document.querySelectorAll('.agent-block')];
    const card = cards.find(node => {
      const text = node.textContent || '';
      const title = node.querySelector('.agent-title-name')?.textContent || '';
      return text.includes(expectedId) || title.toLowerCase().includes(expectedCommand.toLowerCase());
    });
    return Boolean(card && card.querySelector('.terminal-snapshot-row'));
  }, { timeout: 30000 }, agent.id, agent.command);

  const cursorCount = await card.evaluate(node => node.querySelectorAll('.terminal-char.cursor').length);
  assert.strictEqual(cursorCount, 0, 'static previews should not render an extra HTML cursor');
}

async function openAgentModal(page, agent) {
  const card = await findAgentCard(page, agent);
  await card.click();
  await page.waitForSelector('.session-modal .terminal-container canvas', { timeout: 20000 });
  await sleep(1200);
}

async function assertTerminalModal(page, command) {
  const info = await page.evaluate(() => {
    const textarea = document.querySelector('.terminal-session-host textarea');
    const styles = textarea ? getComputedStyle(textarea) : null;
    return {
      hasCanvas: Boolean(document.querySelector('.terminal-container canvas')),
      activeTag: document.activeElement?.tagName || '',
      caretColor: styles?.caretColor || '',
      color: styles?.color || '',
    };
  });

  assert.ok(info.hasCanvas, `${command} modal should render a terminal canvas`);
  assert.strictEqual(info.caretColor, 'rgba(0, 0, 0, 0)', `${command} DOM caret should be hidden`);
}

async function assertTerminalHostOwnership(page, agent) {
  const info = await page.evaluate(() => {
    const container = document.querySelector('.terminal-container');
    const hosts = [...(container?.querySelectorAll('.terminal-session-host') || [])];
    const textarea = container?.querySelector('.terminal-session-host textarea.terminal-ime-input');
    return {
      hostCount: hosts.length,
      agentId: hosts[0]?.dataset.agentId || '',
      hasImeInput: Boolean(textarea),
      imeClipPath: textarea?.style.clipPath || '',
    };
  });

  assert.strictEqual(info.hostCount, 1, 'terminal modal should mount exactly one terminal host');
  assert.strictEqual(info.agentId, agent.id, 'terminal host should belong to the opened agent');
  assert.ok(info.hasImeInput, 'terminal modal should expose a cursor-positioned IME input');
  assert.strictEqual(info.imeClipPath, 'none', 'terminal IME input should not be clipped away');
}

async function assertImeOverlayBaseline(page, agent) {
  const info = await page.evaluate(async (agentId) => {
    const host = document.querySelector('.terminal-session-host');
    const textarea = host?.querySelector('textarea.terminal-ime-input');
    if (!host || !textarea) {
      return { hasHost: Boolean(host), hasTextarea: Boolean(textarea) };
    }

    const fireComposition = (type, data) => {
      const event = typeof window.CompositionEvent === 'function'
        ? new window.CompositionEvent(type, { data, bubbles: true })
        : new Event(type, { bubbles: true });
      host.dispatchEvent(event);
    };

    await window.__farmingTerminalTest.writeFixture(agentId, '$ ');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const visibleCursorPixelBeforeComposition = window.__farmingTerminalTest.getCursorCellPixel(agentId);
    const imeKeydown = new window.KeyboardEvent('keydown', {
      key: 'Process',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(imeKeydown);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cursorPixelAfterImeKeydown = window.__farmingTerminalTest.getCursorCellPixel(agentId);
    fireComposition('compositionstart', 'n');
    fireComposition('compositionupdate', 'n');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const activeDuringComposition = host.classList.contains('terminal-ime-active');
    const composingClass = textarea.classList.contains('terminal-ime-composing');
    const stylesDuringComposition = getComputedStyle(textarea);
    const valueDuringComposition = textarea.value;
    const cursorVisibleDuringComposition = window.__farmingTerminalTest.getCursorVisible(agentId);
    const rendererCursorVisibleDuringComposition = window.__farmingTerminalTest.getRendererCursorVisible(agentId);
    const cursorPixelDuringComposition = window.__farmingTerminalTest.getCursorCellPixel(agentId);
    await window.__farmingTerminalTest.writeRaw(agentId, '\x1b[?25hTUI');
    const cursorVisibleAfterTuiOutput = window.__farmingTerminalTest.getCursorVisible(agentId);
    const rendererCursorVisibleAfterTuiOutput = window.__farmingTerminalTest.getRendererCursorVisible(agentId);
    const cursorPixelAfterTuiOutput = window.__farmingTerminalTest.getCursorCellPixel(agentId);

    fireComposition('compositionend', '你');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cursorVisibleAfterComposition = window.__farmingTerminalTest.getCursorVisible(agentId);
    const rendererCursorVisibleAfterComposition = window.__farmingTerminalTest.getRendererCursorVisible(agentId);

    await window.__farmingTerminalTest.writeFixture(agentId, '\x1b[?25l');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hiddenCursorBeforeComposition = window.__farmingTerminalTest.getCursorVisible(agentId);
    fireComposition('compositionstart', 'n');
    fireComposition('compositionupdate', 'ni');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fireComposition('compositionend', '你');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hiddenCursorAfterComposition = window.__farmingTerminalTest.getCursorVisible(agentId);
    await window.__farmingTerminalTest.writeFixture(agentId, '\x1b[?25h');

    return {
      hasHost: true,
      hasTextarea: true,
      activeDuringComposition,
      composingClass,
      activeAfterComposition: host.classList.contains('terminal-ime-active'),
      valueDuringComposition,
      fontSize: stylesDuringComposition.fontSize,
      lineHeight: stylesDuringComposition.lineHeight,
      caretColor: stylesDuringComposition.caretColor,
      cursorVisibleDuringComposition,
      rendererCursorVisibleDuringComposition,
      cursorVisibleAfterTuiOutput,
      rendererCursorVisibleAfterTuiOutput,
      cursorVisibleAfterComposition,
      rendererCursorVisibleAfterComposition,
      visibleCursorPixelBeforeComposition,
      cursorPixelAfterImeKeydown,
      cursorPixelDuringComposition,
      cursorPixelAfterTuiOutput,
      hiddenCursorBeforeComposition,
      hiddenCursorAfterComposition,
    };
  }, agent.id);

  assert.ok(info.hasHost && info.hasTextarea, 'terminal IME fixture should find the mounted input');
  assert.ok(info.composingClass, 'terminal should show IME composition text in the cursor-positioned overlay input');
  assert.strictEqual(info.activeDuringComposition, true, 'IME composition should install host-level composition state');
  assert.strictEqual(info.activeAfterComposition, false, 'IME composition should clear host-level composition state after composition');
  assert.strictEqual(info.fontSize, '14px', 'IME composition text should match the terminal font size');
  assert.ok(Number.parseFloat(info.lineHeight) >= 14, 'IME composition line-height should fit the terminal cell');
  assert.strictEqual(info.caretColor, 'rgba(0, 0, 0, 0)', 'IME composition should keep the DOM caret hidden');
  assert.strictEqual(info.cursorVisibleDuringComposition, true, 'IME composition should not mutate terminal protocol cursor visibility');
  assert.strictEqual(info.rendererCursorVisibleDuringComposition, false, 'IME composition should hide the terminal renderer cursor');
  assert.strictEqual(info.cursorVisibleAfterTuiOutput, true, 'TUI output may keep the terminal protocol cursor visible while composing');
  assert.strictEqual(info.rendererCursorVisibleAfterTuiOutput, false, 'IME composition should keep the renderer cursor hidden after TUI output');
  assert.strictEqual(info.cursorVisibleAfterComposition, true, 'IME composition should restore the terminal renderer cursor');
  assert.strictEqual(info.rendererCursorVisibleAfterComposition, true, 'IME composition should restore the renderer cursor visibility flag');
  assert.ok(info.visibleCursorPixelBeforeComposition?.g > 120, 'IME fixture should start with a visibly green terminal cursor pixel');
  assert.ok(info.cursorPixelAfterImeKeydown?.g < 80, 'IME keydown 229 should hide the green block cursor before composition text updates');
  assert.ok(info.cursorPixelDuringComposition?.g < 80, 'IME composition should repaint the canvas so the green block cursor disappears visually');
  assert.ok(info.cursorPixelAfterTuiOutput?.g < 80, 'IME composition should keep the green block cursor hidden after TUI output tries to redraw it');
  assert.strictEqual(info.hiddenCursorBeforeComposition, false, 'IME fixture should be able to start with a hidden terminal cursor');
  assert.strictEqual(info.hiddenCursorAfterComposition, false, 'IME composition should preserve a terminal cursor that was already hidden');
}

async function killOpenModalAgent(page, tracker, agent) {
  await page.click('.session-controls .kill-btn');
  await page.waitForFunction(() => !document.querySelector('.session-modal'), { timeout: 10000 });
  await tracker.waitFor(
    state => !state?.agents.some(item => item.id === agent.id),
    `${agent.id} removed after modal kill`,
    15000
  );
  await page.waitForFunction(
    killedAgentId => !document.querySelector(`.terminal-session-host[data-agent-id="${killedAgentId}"]`),
    { timeout: 10000 },
    agent.id
  );
}

async function assertWrappedUrlSelectionCopy(page) {
  const longUrl = `https://example.com/farming/copy-regression/${Date.now()}/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ?signature=copy_should_remain_one_url&workspace=remote-terminal`;
  const result = await page.evaluate(async (url) => {
    const normalizedBasePath = location.pathname.replace(/\/$/, '');
    const assetPath = (suffix) => `${normalizedBasePath}${suffix}`;
    const ghostty = await import(assetPath('/vendor/ghostty-web/ghostty-web.js'));
    await ghostty.init(assetPath('/vendor/ghostty-web/ghostty-vt.wasm'));

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = '260px';
    host.style.height = '160px';
    document.body.appendChild(host);

    const terminal = new ghostty.Terminal({
      cols: 28,
      rows: 8,
      scrollback: 50,
      fontSize: 12,
      theme: {
        background: '#000000',
        foreground: '#00ff00',
        selectionBackground: 'rgba(0, 255, 0, 0.3)',
      },
    });

    terminal.open(host);
    await new Promise((resolve) => terminal.write(url, resolve));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const wrappedRows = [];
    const buffer = terminal.buffer?.active;
    if (buffer && typeof buffer.getLine === 'function') {
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (line?.isWrapped) {
          wrappedRows.push(row);
        }
      }
    }

    function normalizeSelection(terminalInstance) {
      const selection = terminalInstance.getSelection() || '';
      const position = terminalInstance.getSelectionPosition?.();
      const buffer = terminalInstance.buffer?.active;
      if (!position || !buffer || typeof buffer.getLine !== 'function') {
        return selection;
      }

      const start = { ...position.start };
      const end = { ...position.end };
      if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
        position.start = end;
        position.end = start;
      }

      const rebuiltRows = [];
      let canRebuild = true;
      for (let row = position.start.y; row <= position.end.y; row += 1) {
        const line = buffer.getLine(row);
        if (!line || typeof line.getCell !== 'function') {
          canRebuild = false;
          break;
        }

        const startCol = row === position.start.y ? position.start.x : 0;
        const fallbackEndCol = typeof line.length === 'number' ? line.length - 1 : position.end.x;
        const endCol = row === position.end.y ? position.end.x : fallbackEndCol;
        let text = '';
        for (let col = Math.max(0, startCol); col <= Math.max(startCol, endCol); col += 1) {
          const cell = line.getCell(col);
          if (!cell) continue;
          if (typeof cell.getChars === 'function') {
            text += cell.getChars();
          } else if (typeof cell.getCode === 'function' && cell.getCode() > 0) {
            text += String.fromCodePoint(cell.getCode());
          }
        }
        const separator = row === position.start.y ? '' : line.isWrapped ? '' : '\n';
        rebuiltRows.push(`${separator}${text.trimEnd()}`);
      }
      if (canRebuild) {
        return rebuiltRows.join('');
      }

      if (!selection.includes('\n')) {
        return selection;
      }

      const startRow = position.start.y;
      return selection.split('\n').reduce((text, part, index) => {
        if (index === 0) return part;
        const currentLine = buffer.getLine(startRow + index);
        return `${text}${currentLine?.isWrapped ? '' : '\n'}${part}`;
      }, '');
    }

    terminal.select(0, 0, url.length);
    const rawSelection = terminal.getSelection();
    const normalizedSelection = normalizeSelection(terminal);
    const position = terminal.getSelectionPosition?.();
    terminal.dispose();
    host.remove();

    return {
      rawSelection,
      normalizedSelection,
      wrappedRows,
      position,
    };
  }, longUrl);

  assert.ok(result.wrappedRows.length > 0, 'long URL fixture should wrap across terminal rows');
  assert.ok(result.rawSelection.includes('\n'), 'long URL fixture should expose Ghostty soft-wrap newlines before normalization');
  assert.strictEqual(result.normalizedSelection, longUrl, 'wrapped long URL selection should copy as one unbroken URL');
  assert.strictEqual(result.normalizedSelection.includes('\n'), false, 'wrapped long URL copy should not contain inserted newlines');
  assert.strictEqual(result.normalizedSelection.includes('\r'), false, 'wrapped long URL copy should not contain inserted carriage returns');
}

async function assertCjkSelectionCopy(page) {
  const text = '中文复制不应该有空格';
  const result = await page.evaluate(async (expectedText) => {
    const normalizedBasePath = location.pathname.replace(/\/$/, '');
    const assetPath = (suffix) => `${normalizedBasePath}${suffix}`;
    const ghostty = await import(assetPath('/vendor/ghostty-web/ghostty-web.js'));
    await ghostty.init(assetPath('/vendor/ghostty-web/ghostty-vt.wasm'));

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = '360px';
    host.style.height = '120px';
    document.body.appendChild(host);

    const terminal = new ghostty.Terminal({
      cols: 32,
      rows: 4,
      scrollback: 10,
      fontSize: 12,
      theme: {
        background: '#000000',
        foreground: '#00ff00',
        selectionBackground: 'rgba(0, 255, 0, 0.3)',
      },
    });

    terminal.open(host);
    await new Promise((resolve) => terminal.write(expectedText, resolve));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    terminal.select(0, 0, expectedText.length * 2);
    const rawSelection = terminal.getSelection();
    const position = terminal.getSelectionPosition?.();
    const buffer = terminal.buffer?.active;
    let normalizedSelection = rawSelection;
    if (position && buffer && typeof buffer.getLine === 'function') {
      const line = buffer.getLine(position.start.y);
      if (line && typeof line.getCell === 'function') {
        normalizedSelection = '';
        for (let col = position.start.x; col <= position.end.x; col += 1) {
          const cell = line.getCell(col);
          if (!cell) continue;
          if (typeof cell.getChars === 'function') {
            normalizedSelection += cell.getChars();
          } else if (typeof cell.getCode === 'function' && cell.getCode() > 0) {
            normalizedSelection += String.fromCodePoint(cell.getCode());
          }
        }
        normalizedSelection = normalizedSelection.trimEnd();
      }
    }

    terminal.dispose();
    host.remove();

    return { rawSelection, normalizedSelection };
  }, text);

  assert.notStrictEqual(result.rawSelection, text, 'CJK fixture should expose Ghostty wide-cell spacer behavior before normalization');
  assert.strictEqual(result.normalizedSelection, text, 'CJK selection should copy without inserted spaces between Chinese characters');
}

async function assertLiveTerminalCopyAndDoubleClick(page, agent) {
  const longUrl = `https://example.com/farming/live-copy/${Date.now()}/alpha-beta.gamma_delta/path/to/resource?copy=remote&double_click=continuous&value=12345`;

  await page.waitForFunction(
    agentId => Boolean(window.__farmingTerminalTest?.getCellCenter(agentId, 0, 0)),
    { timeout: 10000 },
    agent.id
  );

  await page.evaluate(async ({ agentId, text }) => {
    await window.__farmingTerminalTest.writeFixture(agentId, text);
  }, { agentId: agent.id, text: longUrl });

  const firstCell = await page.evaluate(agentId => window.__farmingTerminalTest.getCellCenter(agentId, 8, 0), agent.id);
  assert.ok(firstCell, 'live terminal copy fixture should expose a selectable cell');
  await page.mouse.click(firstCell.x, firstCell.y, { clickCount: 2 });

  const selection = await page.evaluate(agentId => window.__farmingTerminalTest.getSelection(agentId), agent.id);
  assert.strictEqual(selection, longUrl, 'double-click should select one continuous non-whitespace terminal token across punctuation and soft wraps');

  const copied = await page.evaluate(agentId => window.__farmingTerminalTest.dispatchCopyFromTextarea(agentId), agent.id);

  assert.strictEqual(copied.prevented, true, 'live terminal copy should prevent browser canvas copy default');
  assert.strictEqual(copied.text, longUrl, 'live terminal copy should write the normalized terminal selection to text/plain');
}

async function assertGhosttyFontMetrics(page) {
  const result = await page.evaluate(async () => {
    const normalizedBasePath = location.pathname.replace(/\/$/, '');
    const assetPath = (suffix) => `${normalizedBasePath}${suffix}`;
    const ghostty = await import(assetPath('/vendor/ghostty-web/ghostty-web.js'));
    await ghostty.init(assetPath('/vendor/ghostty-web/ghostty-vt.wasm'));

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = '360px';
    host.style.height = '120px';
    document.body.appendChild(host);

    const fontFamily = [
      '"JetBrains Mono"',
      '"SF Mono"',
      'Menlo',
      'Monaco',
      '"Cascadia Mono"',
      '"Segoe UI Mono"',
      '"Sarasa Mono SC"',
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Noto Sans Mono CJK SC"',
      '"Microsoft YaHei UI"',
      'monospace',
    ].join(', ');
    const terminal = new ghostty.Terminal({
      cols: 16,
      rows: 4,
      fontSize: 14,
      fontFamily,
    });

    terminal.open(host);
    const metrics = terminal.renderer?.getMetrics?.();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `14px ${fontFamily}`;
    const measuredM = context.measureText('M').width;
    const measuredChinese = context.measureText('中').width;

    terminal.dispose();
    host.remove();

    return {
      measuredM,
      measuredChinese,
      cellWidth: metrics?.width,
      fullWidthAdvance: metrics ? metrics.width * 2 : null,
      ceiledFullWidthAdvance: Math.ceil(measuredM) * 2,
    };
  });

  assert.ok(result.cellWidth > 0, 'Ghostty renderer should expose measured cell width');
  assert.ok(
    Math.abs(result.cellWidth - result.measuredM) < 0.01,
    'Ghostty cell width should preserve fractional font metrics instead of rounding cells wider'
  );
  assert.ok(
    result.fullWidthAdvance <= result.ceiledFullWidthAdvance,
    'CJK fullwidth advance should not be widened by ceiled ASCII metrics'
  );
}

async function assertMobileViewportFits(page, label) {
  const info = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      };
    };

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      app: rectFor('.app-container'),
      main: rectFor('.main-content'),
      map: rectFor('.map-area'),
      sidebar: rectFor('.sidebar'),
      mobileBar: rectFor('.mobile-main-bar'),
      modal: rectFor('.session-modal .modal-content'),
      mobileControls: rectFor('.mobile-terminal-controls'),
    };
  });

  assert.ok(info.docScrollWidth <= info.viewportWidth, `${label} should not create document horizontal overflow`);
  assert.ok(info.bodyScrollWidth <= info.viewportWidth, `${label} should not create body horizontal overflow`);
  assert.ok(info.docScrollHeight <= info.viewportHeight, `${label} should fit document height into the mobile viewport`);
  assert.ok(info.bodyScrollHeight <= info.viewportHeight, `${label} should fit body height into the mobile viewport`);

  for (const [name, rect] of Object.entries({
    app: info.app,
    main: info.main,
    map: info.map,
    sidebar: info.sidebar,
    mobileBar: info.mobileBar,
    modal: info.modal,
    mobileControls: info.mobileControls,
  })) {
    if (!rect) continue;
    assert.ok(rect.left >= -1, `${label} ${name} should not overflow left`);
    assert.ok(rect.right <= info.viewportWidth + 1, `${label} ${name} should not overflow right`);
    assert.ok(rect.top >= -1, `${label} ${name} should not overflow top`);
    assert.ok(rect.bottom <= info.viewportHeight + 1, `${label} ${name} should not overflow bottom`);
  }
}

async function assertMobileShellLayout(page) {
  const info = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const map = document.querySelector('.map-area');
    const sidebarRect = sidebar?.getBoundingClientRect();
    const mapRect = map?.getBoundingClientRect();
    const itemRects = [...document.querySelectorAll('.sidebar-item')]
      .slice(0, 2)
      .map((item) => {
        const rect = item.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
      });
    return {
      sidebarWidth: sidebarRect?.width || 0,
      sidebarHeight: sidebarRect?.height || 0,
      sidebarTop: sidebarRect?.top || 0,
      sidebarLeft: sidebarRect?.left || 0,
      mapWidth: mapRect?.width || 0,
      mapBottom: mapRect?.bottom || 0,
      mapRight: mapRect?.right || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      itemRects,
    };
  });

  assert.ok(info.mapWidth <= info.viewportWidth - info.sidebarWidth + 1, 'mobile map should leave room for the vertical sidebar');
  assert.ok(info.sidebarWidth <= 48, 'mobile sidebar should stay as a compact vertical rail');
  assert.ok(info.sidebarHeight >= info.mapBottom - info.sidebarTop - 1, 'mobile sidebar should run vertically beside the map');
  assert.ok(info.sidebarLeft >= info.mapRight - 1, 'mobile sidebar should sit to the right of the map');
  assert.ok(info.itemRects.length >= 2, 'mobile sidebar should contain menu items');
  assert.ok(info.itemRects[1].top >= info.itemRects[0].bottom - 1, 'mobile sidebar menu items should stack vertically');
}

async function assertMobileTerminalLayout(page) {
  const info = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      header: rectFor('.session-header'),
      terminal: rectFor('.terminal-container'),
      sessionControls: rectFor('.session-controls'),
      menuButton: rectFor('.session-mobile-menu-btn'),
      controls: rectFor('.mobile-terminal-controls'),
      inputRow: rectFor('.mobile-terminal-input-row'),
      navRow: rectFor('.mobile-terminal-nav-row'),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      activeClassName: document.activeElement?.className || '',
    };
  });

  assert.ok(info.header && info.terminal && info.controls && info.inputRow && info.navRow, 'mobile terminal layout fixtures should exist');
  assert.ok(info.header.height <= 56, 'mobile terminal header should stay compact');
  assert.ok(info.controls.height <= 112, 'mobile terminal controls should stay compact');
  assert.ok(info.inputRow.width <= info.viewportWidth, 'mobile terminal input row should fit the viewport width');
  assert.ok(info.navRow.bottom <= info.inputRow.top + 1, 'mobile terminal nav row should sit above the input row');
  assert.ok(info.inputRow.bottom >= info.controls.bottom - 12, 'mobile terminal input row should stay close to the keyboard edge');
  assert.ok(info.terminal.height >= 240, 'mobile terminal viewport should keep enough room for output');
  assert.ok(info.controls.bottom <= info.viewportHeight + 1, 'mobile terminal controls should remain visible');
  assert.ok(info.menuButton && info.menuButton.width > 0, 'mobile terminal should show a compact header menu button');
  assert.ok(info.sessionControls && info.sessionControls.height === 0, 'mobile terminal kill/close controls should start collapsed');
  assert.notStrictEqual(info.activeClassName, 'mobile-terminal-input', 'opening a mobile terminal should not automatically open the keyboard');
}

async function assertMobileTerminalInputFocusBehavior(page) {
  const attrs = await page.evaluate(() => {
    const input = document.querySelector('.mobile-terminal-input');
    if (!input) throw new Error('Mobile terminal input not found');
    return {
      name: input.getAttribute('name'),
      inputMode: input.getAttribute('inputmode'),
      autoComplete: input.getAttribute('autocomplete'),
      autoCorrect: input.getAttribute('autocorrect'),
      autoCapitalize: input.getAttribute('autocapitalize'),
      spellCheck: input.getAttribute('spellcheck'),
      enterKeyHint: input.getAttribute('enterkeyhint'),
      lpIgnore: input.getAttribute('data-lpignore'),
      onePasswordIgnore: input.getAttribute('data-1p-ignore'),
      bitwardenIgnore: input.getAttribute('data-bwignore'),
      formType: input.getAttribute('data-form-type'),
    };
  });
  assert.deepStrictEqual(attrs, {
    name: 'terminal-command',
    inputMode: 'text',
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: 'false',
    enterKeyHint: 'send',
    lpIgnore: 'true',
    onePasswordIgnore: 'true',
    bitwardenIgnore: 'true',
    formType: 'other',
  }, 'mobile terminal input should avoid password-manager and autocorrect UI');

  await page.evaluate(() => {
    const terminal = document.querySelector('.terminal-container');
    if (!terminal) throw new Error('Terminal container not found');
    const pointerEvent = typeof window.PointerEvent === 'function'
      ? new window.PointerEvent('pointerdown', { bubbles: true })
      : new MouseEvent('pointerdown', { bubbles: true });
    terminal.dispatchEvent(pointerEvent);
    terminal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const afterTerminalClick = await page.evaluate(() => document.activeElement?.className || '');
  assert.notStrictEqual(afterTerminalClick, 'mobile-terminal-input', 'clicking terminal output should not open the mobile keyboard');

  await page.focus('.mobile-terminal-input');
  const afterInputFocus = await page.evaluate(() => document.activeElement?.className || '');
  assert.strictEqual(afterInputFocus, 'mobile-terminal-input', 'clicking the mobile input should focus it for typing');
}

async function assertMobileVisualViewportHeightLayout(page, label, expectedHeight) {
  await page.evaluate((height) => {
    document.documentElement.style.setProperty('--app-visual-height', `${height}px`);
    document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
  }, expectedHeight);

  await new Promise(resolve => setTimeout(resolve, 50));

  const info = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      visualHeight: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-visual-height')),
      app: rectFor('.app-container'),
      dialogOverlay: rectFor('.dialog-overlay'),
      inputDialog: rectFor('.input-dialog'),
      sessionModal: rectFor('.session-modal'),
      modalContent: rectFor('.session-modal .modal-content'),
      terminal: rectFor('.terminal-container'),
      mobileControls: rectFor('.mobile-terminal-controls'),
    };
  });

  assert.ok(info.app && info.app.height <= expectedHeight + 1, `${label} app should shrink to the visual viewport height`);
  if (info.dialogOverlay) {
    assert.ok(info.dialogOverlay.height <= expectedHeight + 1, `${label} dialog overlay should shrink to the visual viewport height`);
  }
  if (info.inputDialog) {
    assert.ok(info.inputDialog.height <= expectedHeight + 1, `${label} input dialog should shrink to the visual viewport height`);
    assert.ok(info.inputDialog.bottom <= expectedHeight + 1, `${label} input dialog should fit above the keyboard`);
  }
  if (info.sessionModal) {
    assert.ok(info.sessionModal.height <= expectedHeight + 1, `${label} session modal should shrink to the visual viewport height`);
  }
  if (info.modalContent) {
    assert.ok(info.modalContent.height <= expectedHeight + 1, `${label} session content should shrink to the visual viewport height`);
  }
  if (info.mobileControls) {
    assert.ok(info.mobileControls.bottom <= expectedHeight + 1, `${label} mobile terminal controls should stay above the keyboard`);
  }
  if (info.terminal && info.mobileControls) {
    assert.ok(info.terminal.bottom <= info.mobileControls.top + 1, `${label} terminal should resize instead of being covered by controls`);
    assert.ok(info.terminal.height >= 80, `${label} terminal should keep usable output room`);
  }
}

async function clearMobileVisualViewportOverride(page) {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--app-visual-height');
    document.documentElement.style.removeProperty('--app-visual-offset-top');
    window.dispatchEvent(new Event('resize'));
  });
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function assertMobileHeaderActions(page) {
  await page.evaluate(() => {
    const menuButton = document.querySelector('.session-mobile-menu-btn');
    if (!menuButton) throw new Error('Mobile session menu button not found');
    menuButton.click();
  });

  const info = await page.evaluate(() => {
    const controls = document.querySelector('.session-controls');
    const killButton = document.querySelector('.session-controls .kill-btn');
    const closeButton = document.querySelector('.session-controls .close-btn');
    const rect = controls?.getBoundingClientRect();
    return {
      className: controls?.className || '',
      hasKill: Boolean(killButton),
      hasClose: Boolean(closeButton),
      controls: rect ? { right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  assert.ok(info.className.includes('session-controls-open'), 'mobile session menu should expand kill/close actions');
  assert.ok(info.hasKill && info.hasClose, 'mobile session menu should contain kill and close actions');
  assert.ok(info.controls && info.controls.right <= info.viewportWidth + 1, 'expanded mobile session menu should fit horizontally');
  assert.ok(info.controls && info.controls.bottom <= info.viewportHeight + 1, 'expanded mobile session menu should fit vertically');

  await page.evaluate(() => {
    const menuButton = document.querySelector('.session-mobile-menu-btn');
    if (menuButton) menuButton.click();
  });
  const className = await page.evaluate(() => document.querySelector('.session-controls')?.className || '');
  assert.ok(!className.includes('session-controls-open'), 'mobile session menu should collapse after the second tap');
}

async function assertMobileWorkspaceDialogFocus(page, command) {
  await openNewAgentDialog(page);
  await page.evaluate((agentName) => {
    const item = [...document.querySelectorAll('.agent-item')]
      .find(node => (node.querySelector('.agent-item-name')?.textContent || '').trim() === agentName);
    if (!item) throw new Error(`${agentName} option not found`);
    item.click();
  }, command);
  await page.waitForSelector('.workspace-input input', { timeout: 10000 });

  const attrs = await page.evaluate(() => {
    const input = document.querySelector('.workspace-input input');
    if (!input) throw new Error('Workspace input not found');
    return {
      activeClassName: document.activeElement?.className || '',
      activeTag: document.activeElement?.tagName || '',
      name: input.getAttribute('name'),
      inputMode: input.getAttribute('inputmode'),
      autoComplete: input.getAttribute('autocomplete'),
      lpIgnore: input.getAttribute('data-lpignore'),
      formType: input.getAttribute('data-form-type'),
    };
  });

  assert.notStrictEqual(attrs.activeTag, 'INPUT', 'mobile workspace step should not autofocus the input or open the keyboard');
  assert.strictEqual(attrs.name, 'workspace-path', 'workspace input should have a stable non-password name');
  assert.strictEqual(attrs.inputMode, 'text', 'workspace input should request text keyboard mode');
  assert.strictEqual(attrs.autoComplete, 'off', 'workspace input should disable autocomplete');
  assert.strictEqual(attrs.lpIgnore, 'true', 'workspace input should ask password managers to stay out');
  assert.strictEqual(attrs.formType, 'other', 'workspace input should not look like a login form');

  await assertMobileVisualViewportHeightLayout(page, 'mobile workspace keyboard viewport', 360);
  await clearMobileVisualViewportOverride(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.input-dialog'), { timeout: 10000 });
}

async function assertMobileTerminalResize(baseUrl, agentId) {
  const sessionView = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
  const cols = sessionView.session?.previewCols || 0;
  const rows = sessionView.session?.previewRows || 0;
  assert.ok(cols > 0 && rows > 0, 'mobile terminal resize should publish positive terminal dimensions');
  assert.ok(cols < 80, `mobile terminal should resize cols below desktop default to avoid fake wrapping (${cols})`);
  assert.ok(rows >= 20, `mobile terminal should resize rows to the visible viewport (${rows})`);
}

async function closeModal(page) {
  const didClick = await page.evaluate(() => {
    const closeButton = document.querySelector('.session-controls .close-btn');
    if (!closeButton) return false;

    const menuButton = document.querySelector('.session-mobile-menu-btn');
    const controls = document.querySelector('.session-controls');
    if (
      menuButton &&
      controls &&
      getComputedStyle(menuButton).display !== 'none' &&
      !controls.classList.contains('session-controls-open')
    ) {
      menuButton.click();
    }

    closeButton.click();
    return true;
  });

  if (didClick) {
    await page.waitForFunction(() => !document.querySelector('.session-modal'), { timeout: 10000 });
  }
}

async function runDesktopCodingAgentFlow({ baseUrl, tracker, workspace, command }) {
  log(`Desktop flow: start ${command} through the UI`);
  await ensureMainAgent(tracker, workspace);

  const browser = await launchBrowser({ width: 1440, height: 900 });
  try {
    const page = await openAppPage(browser, baseUrl);
    await assertInvalidWorkspaceRejected(baseUrl, page, 'bash');
    const before = new Set((tracker.state?.agents || []).map(agent => agent.id));
    await startAgentFromDialog(page, command, workspace);

    const agent = await tracker.waitFor((state) => {
      return state?.agents.find(item => (
        !before.has(item.id) &&
        item.command === commandProgram(command) &&
        item.status === 'running'
      )) || null;
    }, `${command} card running after UI start`, 45000);

    await assertCodingAgentPreview(page, agent);
    await openAgentModal(page, agent);
    await assertTerminalModal(page, command);
    await assertTerminalHostOwnership(page, agent);
    await assertImeOverlayBaseline(page, agent);
    await assertGhosttyFontMetrics(page);
    await assertWrappedUrlSelectionCopy(page);
    await assertCjkSelectionCopy(page);
    await assertLiveTerminalCopyAndDoubleClick(page, agent);
    await killOpenModalAgent(page, tracker, agent);

    const replacementBefore = new Set((tracker.state?.agents || []).map(item => item.id));
    await startAgentFromDialog(page, command, workspace);
    const replacement = await tracker.waitFor((state) => {
      return state?.agents.find(item => (
        !replacementBefore.has(item.id) &&
        item.command === commandProgram(command) &&
        item.status === 'running'
      )) || null;
    }, `${command} replacement card running after modal kill`, 45000);

    await openAgentModal(page, replacement);
    await assertTerminalModal(page, command);
    await assertTerminalHostOwnership(page, replacement);
    await closeModal(page);
    log(`Desktop flow passed for ${command} (${replacement.id})`);
    return replacement;
  } finally {
    await browser.close();
  }
}

async function runMobileBashFlow({ baseUrl, tracker, workspace }) {
  log('Mobile flow: open bash terminal and send input from bottom composer');
  await ensureMainAgent(tracker, workspace);
  const bash = await startAgentViaWs(tracker, 'bash', workspace, false);

  const browser = await launchBrowser({
    width: 390,
    height: 844,
    isMobile: process.env.FARMING_E2E_TOUCH === '1',
    hasTouch: process.env.FARMING_E2E_TOUCH === '1',
    deviceScaleFactor: 2,
  });

  try {
    const page = await openAppPage(browser, baseUrl);
    await assertMobileViewportFits(page, 'mobile shell');
    await assertMobileShellLayout(page);
    await assertMobileWorkspaceDialogFocus(page, 'bash');
    await openAgentModal(page, bash);
    await assertMobileViewportFits(page, 'mobile terminal modal');
    await assertMobileTerminalLayout(page);
    await assertMobileVisualViewportHeightLayout(page, 'mobile terminal keyboard viewport', 520);
    await clearMobileVisualViewportOverride(page);
    await assertMobileTerminalResize(baseUrl, bash.id);
    await assertMobileTerminalInputFocusBehavior(page);
    await assertMobileHeaderActions(page);

    const mobileReady = await page.evaluate(() => {
      const input = document.querySelector('.mobile-terminal-input');
      return Boolean(input && getComputedStyle(input).display !== 'none');
    });
    assert.ok(mobileReady, 'mobile terminal input should be visible');

    const marker = `farming-mobile-e2e-${Date.now()}`;
    await page.focus('.mobile-terminal-input');
    await page.type('.mobile-terminal-input', `echo ${marker}`, { delay: 1 });
    const inputValue = await page.$eval('.mobile-terminal-input', input => input.value);
    assert.strictEqual(inputValue, `echo ${marker}`, 'mobile input should receive typed text before Send');
    await page.evaluate(() => {
      const sendButton = document.querySelector('.mobile-terminal-input-row button');
      if (!sendButton) throw new Error('Mobile send button not found');
      sendButton.click();
    });
    await page.waitForFunction(() => {
      const input = document.querySelector('.mobile-terminal-input');
      return input && input.value === '';
    }, { timeout: 5000 });

    await waitForSessionText(baseUrl, bash.id, text => text.includes(marker), `bash output ${marker}`);
    await closeModal(page);
    await page.setViewport({
      width: 844,
      height: 390,
      isMobile: process.env.FARMING_E2E_TOUCH === '1',
      hasTouch: process.env.FARMING_E2E_TOUCH === '1',
      deviceScaleFactor: 2,
    });
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.app-container', { timeout: 15000 });
    await assertMobileViewportFits(page, 'mobile landscape shell');
    await assertMobileShellLayout(page);
    await openAgentModal(page, bash);
    await assertMobileViewportFits(page, 'mobile landscape terminal modal');
    await assertMobileTerminalLayout(page);
    await assertMobileVisualViewportHeightLayout(page, 'mobile landscape keyboard viewport', 260);
    await clearMobileVisualViewportOverride(page);
    await closeModal(page);
    log(`Mobile flow passed for bash (${bash.id})`);
    return bash;
  } finally {
    await browser.close();
  }
}

async function waitForSessionText(baseUrl, agentId, predicate, label) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const data = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
    const text = [data.session?.output, data.session?.renderOutput, data.session?.previewText]
      .filter(Boolean)
      .join('\n');
    if (predicate(text)) return text;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function assertAgentAvailable(baseUrl, command, required) {
  const data = await fetchJson(baseUrl, '/api/executables');
  const available = (data.agents || []).some(agent => agent.name === command);
  if (!available && required) {
    throw new Error(`${command} is not available in /api/executables`);
  }
  return available;
}

async function runSuite({ mode, baseUrl, workspace, desktopAgent, desktopAgentRequired }) {
  log(`E2E target: ${baseUrl}`);
  log(`Workspace: ${workspace}`);

  const tracker = await new StateTracker(baseUrl).connect();
  const initialIds = new Set((tracker.state?.agents || []).map(agent => agent.id));

  try {
    const available = await assertAgentAvailable(baseUrl, desktopAgent, desktopAgentRequired);
    if (available) {
      await runDesktopCodingAgentFlow({ baseUrl, tracker, workspace, command: desktopAgent });
    } else {
      log(`Skipping ${desktopAgent}: not available on ${mode}`);
    }

    await runMobileBashFlow({ baseUrl, tracker, workspace });
  } finally {
    await cleanupCreatedAgents(tracker, initialIds);
    await tracker.close();
  }
}

async function main() {
  const mode = process.argv[2] || 'local';
  let localServer = null;

  try {
    if (mode === 'local') {
      localServer = await startLocalServer();
      await runSuite({
        mode,
        baseUrl: localServer.baseUrl,
        workspace: process.env.FARMING_E2E_WORKSPACE || PROJECT_ROOT,
        desktopAgent: process.env.FARMING_E2E_DESKTOP_AGENT || 'codex',
        desktopAgentRequired: true,
      });
    } else if (mode === 'remote') {
      await runSuite({
        mode,
        baseUrl: getRemoteUrl(),
        workspace: getRemoteWorkspace(),
        desktopAgent: process.env.FARMING_E2E_DESKTOP_AGENT || 'qwen',
        desktopAgentRequired: false,
      });
    } else {
      throw new Error(`Unknown mode "${mode}". Use "local" or "remote".`);
    }

    log(`${mode} E2E passed`);
  } finally {
    if (localServer) {
      await localServer.stop();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
