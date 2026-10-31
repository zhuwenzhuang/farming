import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { cleanAgyUserInputText, isSafeAgyConversationId, normalizeAgyToolArgs } from './agy-conversation-store.cjs';
import type { AcpUpdate } from './acp-session-state.cjs';

const MAX_CHILDREN = 128;
const PAGE_BYTES = 1024 * 1024;
const MAX_RECORDS = 1000;

export interface AgyRelatedSession {
  sessionId: string;
  title: string;
  state: 'unknown';
}

function identity(value: unknown): string {
  if (!isSafeAgyConversationId(value) || value !== value.trim()) throw new Error('Invalid Antigravity related session identity');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Antigravity related session record');
  return value as Record<string, unknown>;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// The configured home may itself be a symlink; provider-owned descendants may
// not redirect reads into another conversation or outside this home.
async function ownedPath(home: string, ...segments: string[]): Promise<string> {
  const root = await fs.realpath(home);
  const expected = path.join(root, 'brain', ...segments);
  if (await fs.realpath(expected) !== expected) throw new Error('Antigravity related session path escapes its owner');
  return expected;
}

export async function listAgyRelatedSessions(home: string, parent: string): Promise<AgyRelatedSession[]> {
  identity(parent);
  let directory: string;
  try {
    directory = await ownedPath(home, parent, '.system_generated', 'subagents');
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const children: AgyRelatedSession[] = [];
  const dir = await fs.opendir(directory);
  let scanned = 0;
  for await (const entry of dir) {
    if (++scanned > MAX_CHILDREN * 2) throw new Error('Antigravity related session directory exceeds its limit');
    if (!entry.name.endsWith('.json')) continue;
    if (children.length >= MAX_CHILDREN) throw new Error('Antigravity related session inventory exceeds its limit');
    const id = identity(entry.name.slice(0, -5));
    if (id === parent || !entry.isFile()) throw new Error('Invalid Antigravity child association');
    const filename = await ownedPath(home, parent, '.system_generated', 'subagents', entry.name);
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Record<string, unknown>;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Antigravity child association exceeds its limit');
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 64 * 1024) throw new Error('Antigravity child association exceeds its limit');
      data = record(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    } finally {
      await file.close();
    }
    if (data.conversationId !== id) throw new Error('Antigravity child association identity mismatch');
    const descriptor = record(data.subagentDescriptor);
    if (typeof descriptor.role !== 'string' || descriptor.role.length > 1024 || typeof data.state !== 'string') {
      throw new Error('Invalid Antigravity child descriptor');
    }
    // ALIVE is durable existence, not a foreground Turn state. In particular,
    // parent completion and a completed invoke_subagent call cannot settle it.
    children.push({ sessionId: id, title: descriptor.role || 'Subagent', state: 'unknown' });
  }
  return children.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function projectRecord(entry: Record<string, unknown>, offset: number): AcpUpdate[] {
  const id = `agy-history-${offset}`;
  const text = typeof entry.content === 'string' ? entry.content : '';
  if (entry.type === 'USER_INPUT') {
    const cleaned = cleanAgyUserInputText(text);
    return cleaned ? [{ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text: cleaned } }] : [];
  }
  if (entry.type === 'GENERIC') {
    return text ? [{ sessionUpdate: 'tool_call', toolCallId: id, title: 'Tool result', kind: 'other',
      status: entry.status === 'DONE' ? 'completed' : entry.status === 'ERROR' ? 'failed' : 'in_progress',
      rawOutput: { output: text } }] : [];
  }
  if (entry.type !== 'PLANNER_RESPONSE') return [];
  const updates: AcpUpdate[] = [];
  if (typeof entry.thinking === 'string' && entry.thinking) {
    updates.push({ sessionUpdate: 'agent_thought_chunk', messageId: `${id}-thought`, content: { type: 'text', text: entry.thinking } });
  }
  for (const [index, value] of (Array.isArray(entry.tool_calls) ? entry.tool_calls : []).entries()) {
    const tool = record(value);
    const args = normalizeAgyToolArgs(tool.args == null ? undefined : record(tool.args));
    updates.push({ sessionUpdate: 'tool_call', toolCallId: `${id}-tool-${index}`,
      title: typeof tool.name === 'string' ? tool.name : 'Tool', kind: 'other', rawInput: args || {},
      // The planner issuing a call is not evidence of that call completing.
      status: 'pending' });
  }
  if (text) updates.push({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text } });
  return updates;
}

export async function readAgyRelatedHistory(home: string, parent: string, child: string, cursor: unknown, maxTurns: unknown) {
  identity(child);
  const association = (await listAgyRelatedSessions(home, parent)).find(item => item.sessionId === child);
  if (!association) throw new Error('Antigravity related session is not a child of this parent');
  let filename: string;
  try {
    filename = await ownedPath(home, child, '.system_generated', 'logs', 'transcript_full.jsonl');
  } catch (error) {
    if (!missing(error)) throw error;
    filename = await ownedPath(home, child, '.system_generated', 'logs', 'transcript.jsonl');
  }
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Invalid Antigravity child history');
    let end = stat.size;
    if (cursor != null) {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error('Invalid Antigravity history cursor');
      const value = record(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (value.parent !== parent || value.child !== child || value.ino !== stat.ino || value.dev !== stat.dev
        || value.file !== path.basename(filename) || !Number.isSafeInteger(value.end) || Number(value.end) < 0 || Number(value.end) > stat.size) {
        throw new Error('Invalid or stale Antigravity history cursor');
      }
      end = Number(value.end);
    }
    const start = Math.max(0, end - PAGE_BYTES);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) throw new Error('Antigravity child history changed during read');
    const first = start === 0 ? 0 : buffer.indexOf(10) + 1;
    const last = buffer.lastIndexOf(10) + 1;
    if ((!first && start > 0) || (last === 0 && buffer.length >= PAGE_BYTES)) throw new Error('Antigravity history record exceeds its limit');
    const rows: Array<{ offset: number; entry: Record<string, unknown> }> = [];
    let position = first;
    for (const line of buffer.subarray(first, last).toString('utf8').split('\n')) {
      if (line.trim()) rows.push({ offset: start + position, entry: record(JSON.parse(line)) });
      position += Buffer.byteLength(line) + 1;
    }
    const turns = typeof maxTurns === 'number' && Number.isInteger(maxTurns) && maxTurns > 0 ? Math.min(maxTurns, 100) : 24;
    let begin = Math.max(0, rows.length - MAX_RECORDS);
    let count = 0;
    for (let i = rows.length - 1; i >= begin; i--) {
      if (rows[i].entry.type === 'USER_INPUT' && ++count === turns) { begin = i; break; }
    }
    const offset = rows[begin]?.offset ?? start + first;
    const updates = rows.slice(begin).flatMap(row => projectRecord(row.entry, row.offset));
    if (updates.length > 4000 || Buffer.byteLength(JSON.stringify(updates)) > 2 * PAGE_BYTES) {
      throw new Error('Antigravity projected history exceeds its limit');
    }
    if (offset >= end && end > 0) throw new Error('Antigravity history has no complete record in this page');
    return { sessionId: child, title: association.title, status: association.state, updates,
      truncated: offset > 0,
      nextCursor: offset > 0 ? Buffer.from(JSON.stringify({ parent, child, end: offset, ino: stat.ino, dev: stat.dev, file: path.basename(filename) })).toString('base64url') : null };
  } finally {
    await file.close();
  }
}
