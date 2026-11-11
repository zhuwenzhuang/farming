import assert from 'node:assert/strict';
import { normalizeClaudeModelValue } from '../claude-settings.cjs';
assert.equal(normalizeClaudeModelValue(' future-provider-model[1m] '), 'future-provider-model[1m]');
for (const invalid of ['bad model', '--option', 'bad\nmodel', '', null]) assert.equal(normalizeClaudeModelValue(invalid), '');
console.log('Claude model preference boundary tests passed');
