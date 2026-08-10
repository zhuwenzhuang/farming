import assert from 'assert';
import { AcpSessionOptionsStore } from '../acp-session-options-store.cjs';

function main() {
  const store = new AcpSessionOptionsStore();
  const options = {
    additionalDirectories: ['/repo/shared'],
    configOverrides: [{ configId: 'model', value: ['gpt-5.6-sol'] }],
    mcpServers: [{ name: 'private', env: [{ name: 'TOKEN', value: 'secret' }] }],
  };
  store.set('claude\u0000session-a', options);
  options.additionalDirectories.push('/mutated');
  (options.configOverrides[0]?.value as string[]).push('mutated');
  (options.mcpServers[0]?.env as Array<Record<string, string>>)[0]!.value = 'mutated';

  const stored = store.get('claude\u0000session-a');
  assert.deepStrictEqual(stored, {
    additionalDirectories: ['/repo/shared'],
    configOverrides: [{ configId: 'model', value: ['gpt-5.6-sol'] }],
    mcpServers: [{ name: 'private', env: [{ name: 'TOKEN', value: 'secret' }] }],
  });
  stored?.additionalDirectories.push('/read-mutated');
  assert.deepStrictEqual(store.get('claude\u0000session-a')?.additionalDirectories, ['/repo/shared']);
  assert.strictEqual(store.delete('claude\u0000session-a'), true);
  assert.strictEqual(store.get('claude\u0000session-a'), undefined);
  console.log('ACP session options store tests passed');
}

main();
