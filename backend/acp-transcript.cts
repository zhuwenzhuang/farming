const crypto = require('crypto');
const { createTwoFilesPatch, diffLines } = require('diff') as {
  createTwoFilesPatch(
    oldFileName: string, newFileName: string, oldText: string, newText: string,
    oldHeader: string, newHeader: string, options: { context: number },
  ): string;
  diffLines(oldText: string, newText: string): Array<{ count?: number; added?: boolean; removed?: boolean }>;
};
const {
  isCodexContextCompactionMessage,
} = require('./codex-transcript-sanitizer.cjs') as {
  isCodexContextCompactionMessage(value: unknown): boolean;
};

type DataRecord = Record<string, unknown>;

function isDataRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dataRecord(value: unknown): DataRecord {
  return isDataRecord(value) ? value : {};
}

interface TranscriptOptions extends DataRecord {
  includeDiff?: boolean;
  maxInlineDetailChars?: number;
  maxInlineToolDetailChars?: number;
  mediaPathPrefix?: string;
}

interface DecodedTranscriptMedia {
  content: Buffer;
  mimeType: string;
}

interface ValidatedTranscriptMedia {
  data: string;
  decodedBytes: number;
  mimeType: string;
  type: string;
}

const MAX_RENDERED_DIFF_CHARS = 64 * 1024;
const MAX_INLINE_TOOL_DETAIL_CHARS = 4 * 1024;
const MAX_TRANSCRIPT_INLINE_TOOL_DETAIL_CHARS = 64 * 1024;
const MAX_TRANSCRIPT_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_MEDIA_BASE64_CHARS = Math.ceil(MAX_TRANSCRIPT_MEDIA_BYTES / 3) * 4;
const MAX_EMBEDDED_RESOURCE_TEXT_CHARS = 4 * 1024;
const MAX_COLLABORATION_AGENTS = 16;
const MAX_COLLABORATION_ID_CHARS = 160;
const MAX_COLLABORATION_PATH_CHARS = 512;
const MAX_COLLABORATION_MESSAGE_CHARS = 160;
const MAX_TRANSCRIPT_LOCATIONS = 20;
const MAX_TRANSCRIPT_LOCATION_PATH_CHARS = 1024;
const TRANSCRIPT_MEDIA_MIME_TYPES = new Set<string>([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/wave',
  'audio/webm',
  'audio/x-wav',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function diffBlocks(content: unknown): DataRecord[] {
  return (Array.isArray(content) ? content : [])
    .filter((block: unknown): block is DataRecord => (
      isDataRecord(block) && block.type === 'diff' && typeof block.path === 'string' && Boolean(block.path.trim())
    ));
}

function diffAction(block: DataRecord): string {
  const kind = String(dataRecord(block._meta).kind || '').trim().toLowerCase();
  if (['add', 'added', 'create', 'created'].includes(kind)) return 'Added';
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'Deleted';
  if (['move', 'moved'].includes(kind)) return 'Moved';
  if (['rename', 'renamed'].includes(kind)) return 'Renamed';
  return 'Updated';
}

function patchLineStats(oldText: string, newText: string): { added: number; removed: number } {
  return diffLines(oldText, newText).reduce((stats, part) => {
    const count = Number(part.count || 0);
    if (part.added) stats.added += count;
    if (part.removed) stats.removed += count;
    return stats;
  }, { added: 0, removed: 0 });
}

function patchChanges(content: unknown, options: TranscriptOptions = {}) {
  return diffBlocks(content).map(block => {
    const path = String(block.path || '').trim();
    const oldText = block.oldText == null ? '' : String(block.oldText);
    const newText = block.newText == null ? '' : String(block.newText);
    const stats = patchLineStats(oldText, newText);
    return {
      path,
      kind: diffAction(block).toLowerCase(),
      added: stats.added,
      removed: stats.removed,
      ...(options.includeDiff === true
        ? { diff: boundedDiffText(createTwoFilesPatch(path, path, oldText, newText, 'before', 'after', { context: 3 })) }
        : {}),
    };
  });
}

function patchReviewChanges(content: unknown) {
  return diffBlocks(content).map(block => ({
    kind: diffAction(block).toLowerCase(),
    newText: block.newText == null ? '' : String(block.newText),
    oldText: block.oldText == null ? '' : String(block.oldText),
    path: String(block.path || '').trim(),
  }));
}

function boundedDiffText(value: unknown): string {
  const text = String(value || '');
  if (text.length <= MAX_RENDERED_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_RENDERED_DIFF_CHARS)}\n\n[Diff detail truncated]`;
}

function renderedDiffText(block: DataRecord): string {
  const path = String(block.path || '').trim();
  const oldText = block.oldText == null ? '' : String(block.oldText);
  const newText = block.newText == null ? '' : String(block.newText);
  const patch = createTwoFilesPatch(path, path, oldText, newText, 'before', 'after', { context: 3 });
  return `File: ${path}\n${boundedDiffText(patch)}`.trim();
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolContentText(content: unknown): string {
  return (Array.isArray(content) ? content : []).map((block: unknown) => {
    if (!isDataRecord(block)) return '';
    if (block.type === 'content') {
      const inner = dataRecord(block.content);
      if (inner?.type === 'text') return String(inner.text || '');
      if (inner?.type === 'resource_link') return [inner.name, inner.uri].filter(Boolean).join(' — ');
      if (inner?.type === 'resource') return jsonText(inner.resource);
      if (inner?.type === 'image') return `[Image: ${inner.mimeType || 'image'}]`;
      if (inner?.type === 'audio') return `[Audio: ${inner.mimeType || 'audio'}]`;
      return jsonText(inner);
    }
    if (block.type === 'diff') {
      return renderedDiffText(block);
    }
    if (block.type === 'terminal') {
      const terminal = isDataRecord(block.terminal) ? block.terminal : null;
      const exitStatus = dataRecord(terminal?.exitStatus);
      const status = terminal?.exitStatus
        ? `Exited ${exitStatus.exitCode ?? exitStatus.signal ?? ''}`.trim()
        : 'Running';
      const output = String(terminal?.output || '').trim();
      return [`Terminal: ${block.terminalId || ''} (${status})`.trim(), output].filter(Boolean).join('\n');
    }
    if (block.type === 'text') return String(block.text || '');
    return jsonText(block);
  }).filter(Boolean).join('\n\n').trim();
}

function equivalentJsonText(text: unknown, value: unknown): boolean {
  const candidate = String(text || '').trim();
  if (!candidate || value === undefined || value === null) return false;
  if (candidate === jsonText(value).trim()) return true;
  try {
    return JSON.stringify(JSON.parse(candidate)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function toolOutputText(entry: DataRecord): string {
  const output = entry.rawOutput;
  if (
    String(entry.kind || '').toLowerCase() === 'execute'
    && output
    && typeof output === 'object'
    && !Array.isArray(output)
  ) {
    const record = output as DataRecord;
    const stdout = typeof record.stdout === 'string' ? record.stdout.trimEnd() : '';
    const stderr = typeof record.stderr === 'string' ? record.stderr.trimEnd() : '';
    const sections = [];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`stderr\n${stderr}`);
    if (record.interrupted === true) sections.push('Interrupted');
    if (sections.length > 0) return sections.join('\n\n');
  }
  return jsonText(output).trim();
}

function detailForTool(entry: DataRecord): string {
  const sections = [];
  const rawInput = jsonText(entry.rawInput).trim();
  // Terminal blocks have a dedicated, live presentation populated by the ACP
  // client terminal manager. Rendering the same block through generic detail
  // text duplicates its output directly below the terminal card.
  let structuredContent = toolContentText(
    (Array.isArray(entry.content) ? entry.content : []).filter((block: unknown) => (
      !isDataRecord(block) || block.type !== 'terminal'
    ))
  );
  const rawOutput = toolOutputText(entry);
  // Some ACP adapters mirror rawOutput as a text content block. Keep the
  // canonical output once instead of presenting the same JSON twice.
  if (equivalentJsonText(structuredContent, entry.rawOutput)) structuredContent = '';
  if (rawInput) sections.push(`Input\n${rawInput}`);
  if (structuredContent) sections.push(structuredContent);
  if (rawOutput) sections.push(`Output\n${rawOutput}`);
  return sections.join('\n\n');
}

function positiveLocationInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function transcriptLocations(entry: DataRecord) {
  return (Array.isArray(entry?.locations) ? entry.locations : [])
    .slice(0, MAX_TRANSCRIPT_LOCATIONS)
    .flatMap((locationValue: unknown) => {
      const location = dataRecord(locationValue);
      const range = dataRecord(location.range);
      const start = dataRecord(range.start);
      const end = dataRecord(range.end);
      const path = String(location.path || location.uri || '').trim()
        .slice(0, MAX_TRANSCRIPT_LOCATION_PATH_CHARS);
      if (!path) return [];
      const lineNumber = positiveLocationInteger(location.line ?? location.lineNumber ?? start.line);
      const column = positiveLocationInteger(location.column ?? start.column);
      const endLineNumber = positiveLocationInteger(location.endLine ?? location.endLineNumber ?? end.line);
      const endColumn = positiveLocationInteger(location.endColumn ?? end.column);
      return [{
        path,
        ...(lineNumber !== undefined ? { lineNumber } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(endLineNumber !== undefined ? { endLineNumber } : {}),
        ...(endColumn !== undefined ? { endColumn } : {}),
      }];
    });
}

function transcriptResource(resourceValue: unknown) {
  const resource: DataRecord = resourceValue && typeof resourceValue === 'object'
    ? resourceValue as DataRecord
    : {};
  const text = typeof resource.text === 'string' ? resource.text : '';
  return {
    name: resource.name,
    uri: resource.uri,
    mimeType: resource.mimeType,
    ...(text
      ? {
          text: text.slice(0, MAX_EMBEDDED_RESOURCE_TEXT_CHARS),
          ...(text.length > MAX_EMBEDDED_RESOURCE_TEXT_CHARS ? { textTruncated: true } : {}),
        }
      : {}),
  };
}

function transcriptMediaValue(block: unknown): DataRecord | null {
  if (!block || typeof block !== 'object') return null;
  const candidate = block as DataRecord;
  if (candidate.type === 'image' || candidate.type === 'audio') return candidate;
  if (
    candidate.type === 'content'
    && candidate.content
    && typeof candidate.content === 'object'
    && ['image', 'audio'].includes(dataRecord(candidate.content).type as string)
  ) {
    return candidate.content as DataRecord;
  }
  return null;
}

function validatedTranscriptMedia(block: unknown): ValidatedTranscriptMedia | null {
  const candidate: DataRecord = block && typeof block === 'object' ? block as DataRecord : {};
  const type = String(candidate.type || '');
  const data = typeof candidate.data === 'string' ? candidate.data : '';
  const mimeType = String(candidate.mimeType || '').trim().toLowerCase();
  if (
    !['image', 'audio'].includes(type)
    || !data
    || data.length > MAX_TRANSCRIPT_MEDIA_BASE64_CHARS
    || data.length % 4 !== 0
    || !TRANSCRIPT_MEDIA_MIME_TYPES.has(mimeType)
    || !/^[a-z0-9+/]*={0,2}$/i.test(data)
  ) return null;
  const paddingChars = data.endsWith('==') ? 2 : (data.endsWith('=') ? 1 : 0);
  const decodedBytes = (data.length / 4) * 3 - paddingChars;
  if (decodedBytes <= 0 || decodedBytes > MAX_TRANSCRIPT_MEDIA_BYTES) return null;
  return { data, decodedBytes, mimeType, type };
}

function transcriptMediaId(block: DataRecord): string {
  const media = validatedTranscriptMedia(block);
  if (!media) return '';
  return crypto.createHash('sha256')
    .update(media.type)
    .update('\0')
    .update(media.mimeType)
    .update('\0')
    .update(media.data)
    .digest('hex');
}

function decodeAcpTranscriptMedia(block: unknown): DecodedTranscriptMedia | null {
  const media = validatedTranscriptMedia(block);
  if (!media) return null;
  const content = Buffer.from(media.data, 'base64');
  if (content.length !== media.decodedBytes) return null;
  return {
    content,
    mimeType: media.mimeType,
  };
}

function compactTranscriptMedia(block: DataRecord, entry: DataRecord, options: TranscriptOptions = {}) {
  const mediaPathPrefix = String(options.mediaPathPrefix || '').replace(/\/+$/, '');
  if (!mediaPathPrefix) return JSON.parse(JSON.stringify(block));
  const hasInlineData = typeof block?.data === 'string' && block.data.length > 0;
  if (!hasInlineData) return JSON.parse(JSON.stringify(block));
  const mediaId = transcriptMediaId(block);
  const projected = { ...block };
  delete projected.data;
  if (!mediaId) return projected;
  projected.url = `${mediaPathPrefix}/${encodeURIComponent(String(entry?.id || ''))}/${mediaId}`;
  return projected;
}

function acpTranscriptMedia(entry: DataRecord, requestedMediaId: unknown) {
  const mediaId = String(requestedMediaId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(mediaId)) return null;
  const direct = Array.isArray(entry?.content) ? entry.content : [];
  const output = dataRecord(entry.rawOutput);
  const result = dataRecord(output.result);
  const raw = Array.isArray(result.content)
    ? result.content
    : (Array.isArray(output.content) ? output.content : []);
  for (const block of [...direct, ...raw]) {
    const media = transcriptMediaValue(block);
    if (!media) continue;
    if (transcriptMediaId(media) === mediaId) return media;
  }
  return null;
}

function transcriptMediaBlocks(entry: DataRecord, options: TranscriptOptions = {}) {
  const direct = Array.isArray(entry?.content) ? entry.content : [];
  const output = dataRecord(entry.rawOutput);
  const result = dataRecord(output.result);
  const raw = Array.isArray(result.content)
    ? result.content
    : (Array.isArray(output.content) ? output.content : []);
  const blocks = [...direct, ...raw].flatMap((block: unknown) => {
    if (!isDataRecord(block)) return [];
    if (block.type === 'terminal') return [{ type: 'terminal', terminalId: String(block.terminalId || '') }];
    if (block.type === 'image' || block.type === 'audio') {
      return [compactTranscriptMedia(block, entry, options)];
    }
    if (block.type === 'resource_link') return [JSON.parse(JSON.stringify(block))];
    if (block.type === 'resource') {
      return [{
        type: 'resource',
        resource: transcriptResource(block.resource),
      }];
    }
    if (block.type !== 'content' || !block.content || typeof block.content !== 'object') return [];
    const content = dataRecord(block.content);
    if (content.type === 'image' || content.type === 'audio') {
      const projected = compactTranscriptMedia(content, entry, options);
      return [{ type: 'content', content: projected }];
    }
    if (content.type === 'resource_link') {
      return [{ type: 'content', content: JSON.parse(JSON.stringify(content)) }];
    }
    if (content.type === 'resource') {
      return [{
        type: 'content',
        content: {
          type: 'resource',
          resource: transcriptResource(content.resource),
        },
      }];
    }
    return [];
  });
  const seenTerminals = new Set();
  return blocks.filter((block: DataRecord) => {
    if (block.type !== 'terminal') return true;
    if (!block.terminalId || seenTerminals.has(block.terminalId)) return false;
    seenTerminals.add(block.terminalId);
    return true;
  });
}

function transcriptEntryWithCompactMedia(entry: DataRecord, options: TranscriptOptions = {}) {
  const mediaPathPrefix = String(options.mediaPathPrefix || '').trim();
  if (!mediaPathPrefix || !Array.isArray(entry?.content)) return entry;
  const content = entry.content.map((block: unknown) => {
    const media = transcriptMediaValue(block);
    if (!media) return block;
    const projected = compactTranscriptMedia(media, entry, options);
    return isDataRecord(block) && block.type === 'content'
      ? { ...block, content: projected }
      : projected;
  });
  return { ...entry, content };
}

function transcriptEntryForClient(entry: DataRecord, options: TranscriptOptions = {}) {
  if (
    entry?.type === 'message'
    && entry.role === 'assistant'
    && isCodexContextCompactionMessage(
      (Array.isArray(entry.content) ? entry.content : [])
        .filter((block: unknown): block is DataRecord => isDataRecord(block) && block.type === 'text')
        .map(block => String(block.text || ''))
        .join('')
    )
  ) {
    return {
      id: String(entry.id || ''),
      type: 'compaction',
      status: 'completed',
      summary: '',
    };
  }
  return transcriptEntryWithCompactMedia(entry, options);
}

function generatedMediaTool(entry: DataRecord) {
  const title = String(entry?.title || '').trim().toLowerCase();
  const id = String(entry?.id || '').trim().toLowerCase();
  const output = dataRecord(entry.rawOutput);
  return id.startsWith('ig_')
    || title === 'image generation'
    || title === 'audio generation'
    || String(output.savedPath || '').includes('/generated_images/');
}

function boundedCollaborationString(value: unknown, maxChars: number): string {
  return String(value || '').trim().slice(0, maxChars);
}

function boundedCollaborationIds(value: unknown): string[] {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
    const id = boundedCollaborationString(item, MAX_COLLABORATION_ID_CHARS);
    if (!id || seen.has(id) || seen.size >= MAX_COLLABORATION_AGENTS) return [];
    seen.add(id);
    return [id];
  });
}

function transcriptCodexToolMeta(entry: DataRecord): DataRecord | null {
  const codex = dataRecord(dataRecord(entry._meta).codex);
  const compact: DataRecord = {};
  if (isDataRecord(codex.collaboration)) {
    const collaboration = codex.collaboration;
    const rawInput = dataRecord(entry.rawInput);
    const receiverThreadIds = boundedCollaborationIds(
      collaboration.receiverThreadIds || rawInput.receiverThreadIds
    );
    const rawStates = dataRecord(rawInput.agentsStates);
    const agentsStates: DataRecord = {};
    const stateIds = boundedCollaborationIds([...receiverThreadIds, ...Object.keys(rawStates)]);
    for (const threadId of stateIds) {
      const state = dataRecord(rawStates[threadId]);
      agentsStates[threadId] = {
        status: boundedCollaborationString(state.status, 32),
        message: boundedCollaborationString(state.message, MAX_COLLABORATION_MESSAGE_CHARS),
      };
    }
    compact.collaboration = {
      tool: boundedCollaborationString(collaboration.tool, 48),
      senderThreadId: boundedCollaborationString(
        collaboration.senderThreadId || rawInput.senderThreadId,
        MAX_COLLABORATION_ID_CHARS
      ),
      receiverThreadIds,
      agentsStates,
    };
  }
  if (isDataRecord(codex.subagent)) {
    const subagent = codex.subagent;
    compact.subagent = {
      threadId: boundedCollaborationString(subagent.threadId, MAX_COLLABORATION_ID_CHARS),
      path: boundedCollaborationString(subagent.path, MAX_COLLABORATION_PATH_CHARS),
      activity: boundedCollaborationString(subagent.activity, 32),
    };
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function acpTranscriptToolEntry(entry: DataRecord, options: TranscriptOptions = {}) {
  if (!entry || entry.type !== 'tool') return entry;
  const detail = detailForTool(entry);
  const requestedInlineDetailChars = Number(options.maxInlineDetailChars);
  const inlineDetailChars = Number.isFinite(requestedInlineDetailChars)
    ? Math.max(0, Math.min(MAX_INLINE_TOOL_DETAIL_CHARS, Math.floor(requestedInlineDetailChars)))
    : MAX_INLINE_TOOL_DETAIL_CHARS;
  const decisions = dataRecord(dataRecord(entry._meta).farming_patch_decisions);
  const changes = patchChanges(entry.content).map(change => ({
    path: change.path,
    kind: change.kind,
    added: change.added,
    removed: change.removed,
    ...(decisions[change.path]
      ? { decision: decisions[change.path] }
      : {}),
  }));
  const patchSummary = diffBlocks(entry.content)
    .map(block => `${diffAction(block)} ${String(block.path || '').trim()}`)
    .join('\n');
  const meta: DataRecord = {};
  const entryMeta = dataRecord(entry._meta);
  if (entryMeta.subagent_session_info) {
    const sessionInfo = dataRecord(entryMeta.subagent_session_info);
    const sessionId = boundedCollaborationString(
      sessionInfo.session_id,
      MAX_COLLABORATION_ID_CHARS
    );
    if (sessionId) meta.subagent_session_info = { session_id: sessionId };
  }
  if (entryMeta.farming_patch_decisions) {
    meta.farming_patch_decisions = JSON.parse(JSON.stringify(entryMeta.farming_patch_decisions));
  }
  if (entryMeta.contextCompaction === true) {
    meta.contextCompaction = true;
  }
  const codexMeta = transcriptCodexToolMeta(entry);
  if (codexMeta) meta.codex = codexMeta;
  const locations = transcriptLocations(entry);
  return {
    id: String(entry.id || ''),
    type: 'tool',
    title: String(entry.title || ''),
    kind: String(entry.kind || 'other'),
    status: String(entry.status || ''),
    content: transcriptMediaBlocks(entry, options),
    ...(locations.length > 0 ? { locations } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    transcriptDetail: detail.length <= inlineDetailChars
      ? detail
      : `${detail.slice(0, inlineDetailChars)}${inlineDetailChars > 0 ? '\n\n' : ''}[Open to load full detail]`,
    transcriptDetailTruncated: detail.length > inlineDetailChars,
    transcriptPatchSummary: patchSummary,
    transcriptChanges: changes,
    generatedMedia: generatedMediaTool(entry),
    internal: entry.internal === true,
  };
}

function acpTranscriptEntries(entries: unknown, options: TranscriptOptions = {}) {
  const requestedBudget = Number(options.maxInlineToolDetailChars);
  let remainingInlineDetailChars = Number.isFinite(requestedBudget)
    ? Math.max(0, Math.floor(requestedBudget))
    : MAX_TRANSCRIPT_INLINE_TOOL_DETAIL_CHARS;
  const source = Array.isArray(entries) ? entries : [];
  const projected = new Array(source.length);

  // The transcript page owns only a bounded summary. Exact tool and subagent
  // detail remains backend-owned and is loaded on explicit expansion.
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = source[index];
    if (entry?.type !== 'tool') {
      projected[index] = transcriptEntryForClient(entry, options);
      continue;
    }
    const projectedEntry = acpTranscriptToolEntry(entry, {
      maxInlineDetailChars: remainingInlineDetailChars,
      mediaPathPrefix: options.mediaPathPrefix,
    });
    remainingInlineDetailChars = Math.max(
      0,
      remainingInlineDetailChars - String(projectedEntry.transcriptDetail || '').length
    );
    projected[index] = projectedEntry;
  }
  return projected;
}

module.exports = {
  acpTranscriptEntries,
  acpTranscriptMedia,
  acpToolChanges: (entry: unknown) => patchChanges(dataRecord(entry).content, { includeDiff: true }),
  acpToolDetail: detailForTool,
  acpToolReviewChanges: (entry: unknown) => patchReviewChanges(dataRecord(entry).content),
  acpTranscriptToolEntry,
  decodeAcpTranscriptMedia,
};
