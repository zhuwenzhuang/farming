const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const { normalizeCodexHostMessageUpdate } = require('../acp-runtime.cjs');

async function run() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-visualize-reference-'));
  try {
    const sessionId = '019fc4eb-9000-7000-8000-000000000001';
    const codexHome = path.join(workspace, 'codex-home');
    const threadDirectory = path.join(codexHome, 'visualizations', '2026', '08', '03', sessionId);
    const visualizationPath = path.join(threadDirectory, 'chart.html');
    fs.mkdirSync(threadDirectory, { recursive: true });
    fs.writeFileSync(visualizationPath, '<button type="button">Switch view</button>');
    const binding = {
      provider: 'codex',
      cwd: workspace,
      env: { CODEX_HOME: codexHome },
      sessionId,
      sessionRequestOptions: { additionalDirectories: [], cwd: workspace, mcpServers: [] },
      codexInlineVisualizationStreams: new Map(),
    };
    const reference = `visualize${JSON.stringify({ path: visualizationPath })}`;

    const restored = await normalizeCodexHostMessageUpdate(binding, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'restored-visualization',
        content: { type: 'text', text: `Restored result\n\n${reference}` },
      },
    });
    assert.strictEqual(restored.length, 2);
    assert.strictEqual(restored[0].update.content.text.trim(), 'Restored result');
    assert.strictEqual(restored[1].update.content.type, 'resource_link');
    assert.strictEqual(restored[1].update.content.mimeType, 'text/html');
    assert.strictEqual(
      fs.realpathSync(fileURLToPath(restored[1].update.content.uri)),
      fs.realpathSync(visualizationPath),
    );
    assert.deepStrictEqual(restored[1].update.content._meta.farming, {
      presentation: 'inline-visualization', source: 'codex-host-directive', version: 1,
    });

    const outsidePath = path.join(workspace, 'chart.html');
    fs.writeFileSync(outsidePath, '<p>outside</p>');
    const rejected = await normalizeCodexHostMessageUpdate(binding, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'outside-visualization',
        content: {
          type: 'text',
          text: `visualize${JSON.stringify({ path: outsidePath })}`,
        },
      },
    });
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].update.content.uri, 'farming-unavailable:chart.html');
    assert.strictEqual(rejected[0].update.content._meta.codex.available, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('Codex Visualize reference regression test passed.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
