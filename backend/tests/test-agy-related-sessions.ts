import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAgyRelatedSessions, readAgyRelatedHistory } from '../agy-related-sessions.cjs';

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-agy-related-'));
  const directory = path.join(home, 'brain', 'parent', '.system_generated', 'subagents');
  try {
    await fs.mkdir(directory, { recursive: true });
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(directory, `child-${i}.json`), JSON.stringify({
        conversationId: `child-${i}`, subagentDescriptor: { typeName: 'self', role: `Analyzer ${i}` },
        state: 'SUBAGENT_STATE_ALIVE', spawnStepIndex: 59,
      }));
    }
    const children = await listAgyRelatedSessions(home, 'parent');
    assert.equal(children.length, 4);
    assert(children.every(child => child.state === 'unknown'));
    const logs = path.join(home, 'brain', 'child-0', '.system_generated', 'logs');
    await fs.mkdir(logs, { recursive: true });
    const transcript = path.join(logs, 'transcript_full.jsonl');
    const rows = Array.from({ length: 80 }, (_, i) => [
      { type: 'USER_INPUT', content: `<USER_REQUEST>Question ${i}</USER_REQUEST>` },
      { type: 'PLANNER_RESPONSE', status: 'DONE', content: `Answer ${i}: ${'内容'.repeat(3000)}` },
    ]).flat();
    await fs.writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const messages: string[] = [];
    let cursor: string | null = null;
    let firstCursor = '';
    do {
      const page = await readAgyRelatedHistory(home, 'parent', 'child-0', cursor, 3);
      messages.unshift(...page.updates.filter(update => update.sessionUpdate === 'user_message_chunk').map(update => String(update.content.text)));
      assert.equal(page.status, 'unknown');
      if (!firstCursor) firstCursor = page.nextCursor || '';
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(messages, Array.from({ length: 80 }, (_, i) => `Question ${i}`));
    await assert.rejects(readAgyRelatedHistory(home, 'other-parent', 'child-0', null, 1), /not a child/);
    await assert.rejects(readAgyRelatedHistory(home, 'parent', '../child-0', null, 1), /identity/);
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'parent', null, 1), /not a child/);
    await fs.writeFile(path.join(directory, 'invalid.json'), '{broken');
    await assert.rejects(listAgyRelatedSessions(home, 'parent'));
    await fs.unlink(path.join(directory, 'invalid.json'));
    await fs.writeFile(path.join(directory, 'wrong.json'), JSON.stringify({ conversationId: 'child-0' }));
    await assert.rejects(listAgyRelatedSessions(home, 'parent'), /identity mismatch/);
    await fs.unlink(path.join(directory, 'wrong.json'));
    const anotherLogs = path.join(home, 'brain', 'child-1', '.system_generated', 'logs');
    await fs.mkdir(anotherLogs, { recursive: true });
    await fs.writeFile(path.join(anotherLogs, 'transcript_full.jsonl'), '{}\n');
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'child-1', firstCursor, 1), /cursor/);
    await fs.rename(transcript, transcript + '.old');
    await fs.writeFile(transcript, '{}\n');
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'child-0', firstCursor, 1), /cursor/);
    await fs.unlink(transcript);
    await fs.symlink(path.join(anotherLogs, 'transcript_full.jsonl'), transcript);
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'child-0', null, 1), /escapes its owner/);
    await fs.unlink(transcript);
    await fs.writeFile(transcript, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'child-0', null, 1), /exceeds its limit/);
    await fs.writeFile(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Complete answer' }) + '\n{"type":');
    const partial = await readAgyRelatedHistory(home, 'parent', 'child-0', null, 1);
    assert.equal(partial.updates.length, 1, 'partial tail must not discard complete records');
    await fs.unlink(path.join(directory, 'child-0.json'));
    await assert.rejects(readAgyRelatedHistory(home, 'parent', 'child-0', null, 1), /not a child/);
    console.log('Antigravity related session boundaries and pagination passed');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
