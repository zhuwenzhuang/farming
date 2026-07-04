const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { readClaudeSettingsSummary, summarizeClaudeSettings } = require('../claude-settings');

function run() {
  const tmpBase = path.resolve(__dirname, '..', '..', '.tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'claude-settings-'));
  const claudeHome = path.join(tmpRoot, '.claude');
  const settingsFile = path.join(claudeHome, 'settings.json');

  try {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret-should-not-leak',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-4-8[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-8[1m]',
        ANTHROPIC_MODEL: 'claude-opus-4-8[1m]',
      },
      alwaysThinkingEnabled: true,
      effortLevel: 'high',
      skipDangerousModePermissionPrompt: true,
    }));

    const summary = readClaudeSettingsSummary({ settingsFile });
    assert.strictEqual(summary.available, true);
    assert.strictEqual(summary.effectiveModel, 'claude-opus-4-8[1m]');
    assert.strictEqual(summary.effectiveEffort, 'high');
    assert.strictEqual(summary.modelOptions.length, 1);
    assert.strictEqual(summary.modelOptions[0].value, 'claude-opus-4-8[1m]');
    assert(summary.effortOptions.some(option => option.value === 'high'));

    const serialized = JSON.stringify(summary);
    assert(!serialized.includes('ANTHROPIC_AUTH_TOKEN'));
    assert(!serialized.includes('sk-secret-should-not-leak'));
    assert(!serialized.includes('ANTHROPIC_BASE_URL'));

    const multipleModels = summarizeClaudeSettings({
      env: {
        ANTHROPIC_MODEL: 'qwen3.7-max',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4',
      },
      effortLevel: 'medium',
    });
    assert.deepStrictEqual(multipleModels.modelOptions.map(option => option.value), [
      'qwen3.7-max',
      'claude-sonnet-4',
      'claude-opus-4',
    ]);
    assert.strictEqual(multipleModels.effectiveModel, 'qwen3.7-max');

    console.log('test-claude-settings passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run();
