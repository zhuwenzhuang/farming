import assert from 'assert';
import { AgentTaskHistoryStore } from '../agent-task-history-store.cjs';

function main() {
  const persisted: Array<Record<string, unknown>> = [];
  let failWrite = false;
  const initial = Array.from({ length: 205 }, (_, index) => ({ id: `history-${index}` }));
  const store = new AgentTaskHistoryStore({
    appendTaskHistory(entry) {
      if (failWrite) throw new Error('simulated history write failure');
      persisted.push(entry);
    },
    getTaskHistory: () => initial,
  });

  assert.strictEqual(store.list().length, 200);
  const entry = { id: 'history-new', reason: 'manual-kill' };
  store.append(entry);
  assert.strictEqual(store.list()[0], entry);
  assert.deepStrictEqual(persisted, [entry]);

  const beforeFailure = store.list();
  failWrite = true;
  assert.throws(
    () => store.append({ id: 'history-failed' }),
    /simulated history write failure/,
  );
  assert.deepStrictEqual(store.list(), beforeFailure);

  const leaked = store.list();
  leaked.length = 0;
  assert.strictEqual(store.list().length, 200, 'callers must not mutate owned history state');

  console.log('Agent task history store tests passed');
}

main();
