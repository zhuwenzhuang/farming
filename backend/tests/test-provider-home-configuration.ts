import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  readProviderHomeConfiguration,
  summarizeCodexConfiguration,
  summarizeJsonConfiguration,
} = require('../provider-home-configuration.cjs');

assert.deepStrictEqual(summarizeCodexConfiguration([
  'model = "gpt-5.6-sol"',
  'model_provider = "openai"',
  'model_reasoning_effort = "high"',
  'service_tier = "priority"',
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  '',
  '[profiles.other]',
  'model = "ignored"',
].join('\n')), [
  { key: 'model', value: 'gpt-5.6-sol' },
  { key: 'provider', value: 'openai' },
  { key: 'reasoning', value: 'high' },
  { key: 'serviceTier', value: 'priority' },
  { key: 'approval', value: 'on-request' },
  { key: 'sandbox', value: 'workspace-write' },
]);

assert.deepStrictEqual(summarizeJsonConfiguration('claude', JSON.stringify({
  model: 'claude-opus-4-1',
  effortLevel: 'high',
  permissionMode: 'acceptEdits',
  env: { ANTHROPIC_AUTH_TOKEN: 'must-not-leak' },
})), [
  { key: 'model', value: 'claude-opus-4-1' },
  { key: 'reasoning', value: 'high' },
  { key: 'permission', value: 'acceptEdits' },
]);

assert.deepStrictEqual(summarizeJsonConfiguration('opencode', `{
  // JSONC remains supported.
  "model": "openai/gpt-5.6",
  "provider": "openai",
}`), [
  { key: 'model', value: 'openai/gpt-5.6' },
  { key: 'provider', value: 'openai' },
]);

assert.deepStrictEqual(summarizeJsonConfiguration('opencode', `{
  // "model": "commented/old-model",
  /* "provider": "commented-provider" */
  "model": "openai/new-model",
  "provider": "openai",
  "note": "https://example.test/path/* literal */ and \\\"model\\\": \\\"embedded/old-model\\\"",
}`), [
  { key: 'model', value: 'openai/new-model' },
  { key: 'provider', value: 'openai' },
]);

assert.deepStrictEqual(summarizeJsonConfiguration('opencode', `{
  "note": "\\\"model\\\": \\\"embedded/old-model\\\"",
}`), []);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-provider-home-config-'));
try {
  const qwenHome = path.join(root, 'qwen');
  fs.mkdirSync(qwenHome, { recursive: true });
  fs.writeFileSync(path.join(qwenHome, 'settings.json'), JSON.stringify({
    model: { name: 'qwen3-coder-plus' },
    security: { auth: { token: 'must-not-leak' } },
  }));
  assert.deepStrictEqual(readProviderHomeConfiguration('qwen', qwenHome), {
    exists: true,
    filePath: 'settings.json',
    summary: [{ key: 'model', value: 'qwen3-coder-plus' }],
  });

  assert.deepStrictEqual(readProviderHomeConfiguration('codex', path.join(root, 'missing')), {
    exists: false,
    filePath: 'config.toml',
    summary: [],
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('test-provider-home-configuration passed');
