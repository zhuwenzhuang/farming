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

    const project = path.join(workspace, 'project');
    const output = path.join(project, '.tmp', 'mobile-composer-design');
    fs.mkdirSync(output, { recursive: true });
    const projectBinding = { ...binding, cwd: project, sessionRequestOptions: { ...binding.sessionRequestOptions, cwd: project } };
    const projectPath = path.join(output, 'mobile-long-input.html');
    fs.writeFileSync(projectPath, '<textarea>长文本输入</textarea><script>document.body.dataset.ready="true"</script>');
    let message = 0;
    async function resolveFile(file, owner = projectBinding) {
      const updates = await normalizeCodexHostMessageUpdate(owner, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: `path-${message++}`,
          content: { type: 'text', text: `visualize${JSON.stringify({ path: file })}` } },
      });
      return updates[0].update.content;
    }
    assert.strictEqual(fileURLToPath((await resolveFile(projectPath)).uri), fs.realpathSync(projectPath));
    // Workspace output does not depend on the optional per-thread directory existing.
    const noThreadBinding = { ...projectBinding, env: { CODEX_HOME: path.join(workspace, 'absent-home') } };
    assert.strictEqual(fileURLToPath((await resolveFile(projectPath, noThreadBinding)).uri), fs.realpathSync(projectPath));
    assert.strictEqual(fileURLToPath((await resolveFile('chart.html')).uri), fs.realpathSync(visualizationPath));
    const extra = path.join(workspace, 'granted');
    fs.mkdirSync(extra);
    const extraPath = path.join(extra, 'extra.html');
    fs.writeFileSync(extraPath, '<p>granted</p>');
    assert.strictEqual((await resolveFile(extraPath))._meta.codex.available, false);
    const extraBinding = { ...projectBinding, sessionRequestOptions: { ...projectBinding.sessionRequestOptions, additionalDirectories: [extra] } };
    assert.strictEqual(fileURLToPath((await resolveFile(extraPath, extraBinding)).uri), fs.realpathSync(extraPath));

    const outsidePath = path.join(workspace, 'chart.html');
    fs.writeFileSync(outsidePath, '<p>outside</p>');
    const rejected = await normalizeCodexHostMessageUpdate(projectBinding, {
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
    const escapedPath = path.join(output, 'escape.html');
    fs.symlinkSync(outsidePath, escapedPath);
    assert.strictEqual((await resolveFile(escapedPath))._meta.codex.available, false);
    const sibling = path.join(workspace, 'project-other');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'sibling.html'), '<p>sibling</p>');
    assert.strictEqual((await resolveFile(path.join(sibling, 'sibling.html')))._meta.codex.available, false);
    const otherThread = path.join(path.dirname(threadDirectory), '019fc4eb-9000-7000-8000-000000000002');
    fs.mkdirSync(otherThread);
    const otherThreadPath = path.join(otherThread, 'other.html');
    fs.writeFileSync(otherThreadPath, '<p>another session</p>');
    assert.strictEqual((await resolveFile(otherThreadPath, binding))._meta.codex.available, false);
    const otherThreadLink = path.join(output, 'other-thread.html');
    fs.symlinkSync(otherThreadPath, otherThreadLink);
    assert.strictEqual((await resolveFile(otherThreadLink))._meta.codex.available, false);
    for (const [name, source] of [
      ['invalid.html', Buffer.from([0xff, 0xfe])],
      ['large.html', Buffer.alloc(2 * 1024 * 1024 + 1, 'x')],
      ['source.txt', '<p>not HTML</p>'],
    ]) {
      const file = path.join(output, name);
      fs.writeFileSync(file, source);
      assert.strictEqual((await resolveFile(file))._meta.codex.available, false, name);
    }
    assert.strictEqual((await resolveFile(path.join(output, 'missing.html')))._meta.codex.available, false);
    assert.strictEqual((await resolveFile('../chart.html'))._meta.codex.available, false);
    fs.mkdirSync(path.join(output, 'directory.html'));
    assert.strictEqual((await resolveFile(path.join(output, 'directory.html')))._meta.codex.available, false);
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
