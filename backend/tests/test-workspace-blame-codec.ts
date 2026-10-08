import assert from 'node:assert/strict';
import { packWorkspaceBlameLines, unpackWorkspaceBlameLines, type WorkspaceBlameLine } from '../../shared/workspace-blame';

const lines: WorkspaceBlameLine[] = Array.from({ length: 300 }, (_, index) => {
  const uncommitted = index >= 200;
  const commit = (uncommitted ? '0' : index < 100 ? 'a' : 'b').repeat(40);
  const time = index < 100 ? null : 1700000000;
  return { commit, shortCommit: uncommitted ? 'uncommitted' : commit.slice(0, 8),
    author: '作者', authorMail: 'example@example.test', authorTime: time,
    authorTimeIso: time === null ? '' : new Date(time * 1000).toISOString(),
    summary: 'quote " slash \\ newline\n', uncommitted,
    lineNumber: index + 1, originalLineNumber: index < 150 ? index + 1 : index + 11,
    content: `${index} 中文 👩‍💻 " \\ \r\t` };
});
for (const budget of [500, 1000, 10000]) {
  const restored: WorkspaceBlameLine[] = [];
  while (restored.length < lines.length) {
    const page = packWorkspaceBlameLines(lines, restored.length, budget);
    assert.ok(page.count > 0);
    assert.ok(Buffer.byteLength(JSON.stringify({ commits: page.commits, ranges: page.ranges })) <= budget);
    restored.push(...unpackWorkspaceBlameLines(page));
  }
  assert.deepEqual(restored, lines);
}
assert.equal(packWorkspaceBlameLines(lines, 0, 10).count, 0);
assert.deepEqual(unpackWorkspaceBlameLines({ commits: [], ranges: [] }), []);
assert.throws(() => unpackWorkspaceBlameLines({ commits: [], ranges: [{ start: 1, originalStart: 1, commit: 0, contents: ['bad'] }] }), /Invalid blame range/);
console.log('workspace blame codec passed');
