const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentCapabilityTokens } = require('../agent-capability-tokens.cjs');
const { canonicalWorkspacePath } = require('../workspace-root-registry.cjs');

function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-capability-token-'));
  const realWorkspace = path.join(temporaryRoot, 'workspace');
  const linkedWorkspace = path.join(temporaryRoot, 'workspace-link');
  fs.mkdirSync(realWorkspace);
  fs.symlinkSync(realWorkspace, linkedWorkspace);
  const canonicalWorkspace = canonicalWorkspacePath(realWorkspace);
  const tokens = new AgentCapabilityTokens();
  try {
    assert.throws(() => tokens.issue({
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: '',
      workspace: linkedWorkspace,
    }), /exact Agent, runtime epoch, and workspace/);
    assert.throws(() => tokens.issue({
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'invalid epoch',
      workspace: linkedWorkspace,
    }), /exact Agent, runtime epoch, and workspace/);

    const browserToken = tokens.issue({
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'runtime-one',
      workspace: linkedWorkspace,
    });
    assert(browserToken.length >= 40);
    assert.strictEqual(tokens.issue({
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'runtime-one',
      workspace: canonicalWorkspace,
    }), browserToken, 'symlink and real paths must share one canonical binding');
    assert.deepStrictEqual(tokens.resolve(browserToken, 'browser'), {
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'runtime-one',
      workspace: canonicalWorkspace,
    });
    assert.strictEqual(tokens.resolve(browserToken, 'computer'), null);
    assert.strictEqual(tokens.resolve('forged-token', 'browser'), null);

    const computerToken = tokens.issue({
      agentId: 'agent-one',
      capability: 'computer',
      runtimeEpoch: 'runtime-one',
      workspace: linkedWorkspace,
    });
    assert.notStrictEqual(computerToken, browserToken);
    assert.strictEqual(tokens.activeTokenCount(), 2);

    const rotatedBrowserToken = tokens.issue({
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'runtime-two',
      workspace: canonicalWorkspace,
    });
    assert.notStrictEqual(rotatedBrowserToken, browserToken);
    assert.strictEqual(
      tokens.resolve(browserToken, 'browser'),
      null,
      'a previous ACP runtime token must never reactivate after rotation',
    );
    assert.deepStrictEqual(tokens.resolve(rotatedBrowserToken, 'browser'), {
      agentId: 'agent-one',
      capability: 'browser',
      runtimeEpoch: 'runtime-two',
      workspace: canonicalWorkspace,
    });
    assert.strictEqual(
      tokens.activeTokenCount(),
      2,
      'runtime history must not add another active token for the same Agent capability',
    );

    const firstScaleToken = tokens.issue({
      agentId: 'agent-scale',
      capability: 'browser',
      runtimeEpoch: 'runtime-0',
      workspace: canonicalWorkspace,
    });
    for (let index = 1; index <= 50_000; index += 1) {
      tokens.issue({
        agentId: 'agent-scale',
        capability: 'browser',
        runtimeEpoch: `runtime-${index}`,
        workspace: canonicalWorkspace,
      });
    }
    assert.strictEqual(tokens.resolve(firstScaleToken, 'browser'), null);
    assert.strictEqual(
      tokens.activeTokenCount(),
      3,
      '50,000 runtime rotations must retain one token, not one token per historical runtime',
    );
    tokens.revokeAgent('agent-scale');
    assert.strictEqual(tokens.activeTokenCount(), 2);

    tokens.revokeAgent('agent-one');
    assert.strictEqual(tokens.resolve(browserToken, 'browser'), null);
    assert.strictEqual(tokens.resolve(computerToken, 'computer'), null);
    assert.strictEqual(tokens.resolve(rotatedBrowserToken, 'browser'), null);
    assert.strictEqual(tokens.activeTokenCount(), 0);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log('Agent capability token isolation tests passed');
}

run();
