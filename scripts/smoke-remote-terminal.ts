#!/usr/bin/env -S npx tsx

import { chromium } from '@playwright/test';

function usage(): void {
  console.error('Usage: tsx scripts/smoke-remote-terminal.ts <farming-url-with-token>');
  console.error('Example: tsx scripts/smoke-remote-terminal.ts "http://host:39401/farming/?token=..."');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2] || process.env.FARMING_SMOKE_URL || '';
  if (!url) {
    usage();
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="code-agent-row"]', { timeout: 20_000 });

    const row = page.locator('[data-testid="code-agent-row"]').first();
    const targetAgentId = await row.getAttribute('data-agent-id');
    assert(targetAgentId, 'first visible agent row has no data-agent-id');
    await row.click();
    await page.waitForFunction((agentId: string) => {
      const activeRow = document.querySelector('[data-testid="code-agent-row"].active');
      return activeRow?.getAttribute('data-agent-id') === agentId;
    }, targetAgentId, { timeout: 20_000 });
    await page.waitForFunction((agentId: string) => {
      const pane = document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(agentId)}"]`);
      return Boolean(pane?.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(agentId)}"] .xterm`));
    }, targetAgentId, { timeout: 20_000 });

    const state = await page.evaluate(async (targetId: string) => {
      const rowEl = document.querySelector(`[data-testid="code-agent-row"][data-agent-id="${CSS.escape(targetId)}"]`);
      const rowAgentId = targetId || rowEl?.getAttribute('data-agent-id') || '';
      const pane = rowAgentId
        ? document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(rowAgentId)}"]`)
        : null;
      const host = rowAgentId
        ? document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(rowAgentId)}"]`)
        : null;
      let sessionView: { ok: boolean; status: number; body: unknown } | null = null;
      if (rowAgentId) {
        const response = await fetch(`/farming/api/agents/${encodeURIComponent(rowAgentId)}/session-view`);
        sessionView = {
          ok: response.ok,
          status: response.status,
          body: response.ok ? await response.json() : null,
        };
      }
      return {
        title: document.title,
        bodyLength: document.body?.innerText?.length || 0,
        hasCodeShell: Boolean(document.querySelector('.code-app, .code-shell, .code-workspace')),
        rowAgentId,
        rowText: rowEl?.textContent?.trim() || '',
        paneExists: Boolean(pane),
        paneActive: pane?.classList.contains('active') || false,
        hostExists: Boolean(host),
        xtermVisible: Boolean(host?.querySelector('.xterm')),
        terminalHostCount: document.querySelectorAll('.terminal-session-host').length,
        bodyText: document.body?.innerText?.slice(0, 500) || '',
        sessionView,
      };
    }, targetAgentId);

    assert(state.bodyLength > 0, 'page body is empty');
    assert(state.hasCodeShell, 'Farming Code shell is not mounted');
    assert(state.rowAgentId, `no visible agent row found; page text: ${state.bodyText}`);
    assert(state.paneExists, `terminal pane missing for ${state.rowAgentId}`);
    assert(state.hostExists, `terminal host missing for ${state.rowAgentId}`);
    assert(state.xtermVisible, `xterm is not mounted for ${state.rowAgentId}`);
    assert(state.sessionView?.ok, `session-view failed for ${state.rowAgentId}: ${state.sessionView?.status}`);
    const session = (state.sessionView.body as { session?: Record<string, unknown> })?.session || {};
    assert(Number.isFinite(Number(session.outputSeq)), `session-view outputSeq is missing for ${state.rowAgentId}`);
    const previewSnapshot = session.previewSnapshot as { cells?: unknown[] } | undefined;
    assert(previewSnapshot && Array.isArray(previewSnapshot.cells), `preview snapshot is missing for ${state.rowAgentId}`);

    console.log(JSON.stringify({
      ok: true,
      url: page.url(),
      title: state.title,
      agentId: state.rowAgentId,
      rowText: state.rowText,
      terminalHostCount: state.terminalHostCount,
      outputSeq: session.outputSeq,
      snapshotRows: previewSnapshot!.cells!.length,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error((error as Error).stack || (error as Error).message || String(error));
  process.exit(1);
});
