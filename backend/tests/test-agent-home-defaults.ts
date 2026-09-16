const assert = require('node:assert/strict');
const { acpHomeDefaultsPatch } = require('../agent-home-defaults.cjs');

const configOptions = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'confirmed-model' },
  { id: 'reasoning', category: 'thought_level', type: 'select', currentValue: 'high' },
  { id: 'fast-mode', type: 'boolean', currentValue: false },
  { id: 'permission', type: 'select', currentValue: 'full' },
];
assert.deepEqual(acpHomeDefaultsPatch({ configOptions }, [{ configId: 'model', value: 'requested-model' }]), {
  model: 'confirmed-model', reasoning: 'high',
});
assert.deepEqual(acpHomeDefaultsPatch({ configOptions }, [{ configId: 'fast-mode', value: false }]), { fast: 'off' });
assert.deepEqual(acpHomeDefaultsPatch({ configOptions, deferred: true }, [
  { configId: 'model', value: 'next-model' },
  { configId: 'fast-mode', value: true },
]), { model: 'next-model', fast: 'on' });
assert.deepEqual(acpHomeDefaultsPatch({ configOptions }, [{ configId: 'permission', value: 'full' }]), {});
assert.deepEqual(acpHomeDefaultsPatch({ configOptions }, []), {});
assert.deepEqual(acpHomeDefaultsPatch(null, [{ configId: 'model', value: 'ignored' }]), {});
assert.deepEqual(acpHomeDefaultsPatch({ configOptions: [
  { id: 'speed', type: 'boolean', currentValue: true },
] }, [{ configId: 'speed', value: true }]), { fast: 'on' });
console.log('Agent Home defaults selection tests passed');
