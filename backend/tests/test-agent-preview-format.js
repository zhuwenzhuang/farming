const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

(async () => {
  const {
    stripAnsi,
    extractMeaningfulPreview,
    extractTerminalSnapshotPreview,
    agentDisplayName,
    agentTitle,
  } = importTsModule('src/lib/format.ts');

  const rawClaudeOutput = [
    '\u001b[?2026l',
    '\u001b[32mTry "how do I log an error?"\u001b[0m',
    '\u001b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━\u001b[0m',
    'bypass permissions on (shift+tab to cycle)',
    'Auto-update failed · Try claude doctor',
    'Meaningful final line',
  ].join('\n');

  assert.strictEqual(stripAnsi('\u001b[?2026lhello\u001b[0m'), 'hello');
  assert.strictEqual(agentDisplayName('claude'), 'Claude Code');
  assert.strictEqual(agentDisplayName('bash'), 'bash');
  assert.strictEqual(
    agentTitle({ command: 'claude', sessionTitle: 'Investigating planner bug', task: 'Fallback task' }),
    'Investigating planner bug',
    'agent-updated session titles should drive sidebar titles before task text'
  );
  assert.strictEqual(
    agentTitle({ command: 'claude', sessionTitle: 'Claude Code' }),
    'claude',
    'generic program titles should fall back to the agent command'
  );
  assert.strictEqual(
    agentTitle({ command: 'claude', source: 'claude-history:8d8f', task: '带读一下精读 AbstractOptimizer.optimize', sessionTitle: '＊ Claude Code' }),
    '带读一下精读 AbstractOptimizer.op…',
    'decorated generic Claude terminal titles should not hide the original resumed chat title'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', cwd: '/repo/sql-insight', sessionTitle: '⠙ mc_skills' }),
    'mc_skills',
    'Codex spinner-prefixed terminal titles should display the stable title text without a second activity glyph'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', cwd: '/repo/example-project', sessionTitle: 'example-project', task: 'Inspect example-project' }),
    'codex',
    'workspace directory titles should not become chat titles'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', source: 'codex-history:019d0f73', task: 'Hash delta daily 问题调查3', sessionTitle: 'Codex' }),
    'Hash delta daily 问题调查3',
    'resumed Codex history sessions should use the original chat title while the live title is still generic'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', cwd: '/repo/farming', projectWorkspace: '/repo/farming', source: 'codex-history:019d0f74', task: 'Farming + Codex', sessionTitle: '⠿ farming' }),
    'Farming + Codex',
    'Codex spinner-prefixed workspace titles should not replace the original chat title'
  );
  assert.strictEqual(
    agentTitle({ command: 'claude', source: 'claude-history-fork:8d8f', task: '继续修复 Farming 性能', sessionTitle: 'Claude session' }),
    '继续修复 Farming 性能',
    'forked history sessions should also keep the original chat title when the live title is generic'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', source: 'ui', task: 'Inspect example-project', sessionTitle: 'Codex' }),
    'codex',
    'ordinary new agents should not use task text as their sidebar title'
  );
  assert.strictEqual(
    agentTitle({ command: 'codex', customTitle: 'User renamed chat', sessionTitle: 'Agent title' }),
    'User renamed chat',
    'user renames should override later agent title updates'
  );
  assert.strictEqual(
    agentTitle({ command: 'claude', isMain: true, sessionTitle: '.farming' }),
    'Main Agent',
    'main agent should not expose the internal .farming workspace as its title'
  );

  const preview = extractMeaningfulPreview(rawClaudeOutput);
  assert.ok(preview.includes('Try "how do I log an error?"'));
  assert.ok(preview.includes('Meaningful final line'));
  assert.ok(!preview.includes('Auto-update failed'));
  assert.ok(!preview.includes('shift+tab to cycle'));
  assert.ok(!preview.includes('━━━━━━━━'));

  const terminalSnapshot = extractTerminalSnapshotPreview([
    'Claude Code',
    '',
    'Working...',
    '',
    '$ echo done',
    'done',
  ].join('\n'), 4);
  assert.strictEqual(terminalSnapshot, ['Working...', '', '$ echo done', 'done'].join('\n'));

  console.log('✓ agent preview formatting strips terminal noise and uses friendly names');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
