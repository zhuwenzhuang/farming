const { createTwoFilesPatch, diffLines } = require('diff');

const MAX_RENDERED_DIFF_CHARS = 64 * 1024;
const MAX_INLINE_TOOL_DETAIL_CHARS = 4 * 1024;

function diffBlocks(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'diff' && typeof block.path === 'string' && block.path.trim());
}

function diffAction(block) {
  const kind = String(block?._meta?.kind || '').trim().toLowerCase();
  if (['add', 'added', 'create', 'created'].includes(kind)) return 'Added';
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'Deleted';
  if (['move', 'moved'].includes(kind)) return 'Moved';
  if (['rename', 'renamed'].includes(kind)) return 'Renamed';
  return 'Updated';
}

function patchLineStats(oldText, newText) {
  return diffLines(oldText, newText).reduce((stats, part) => {
    const count = Number(part.count || 0);
    if (part.added) stats.added += count;
    if (part.removed) stats.removed += count;
    return stats;
  }, { added: 0, removed: 0 });
}

function patchChanges(content, options = {}) {
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

function patchReviewChanges(content) {
  return diffBlocks(content).map(block => ({
    kind: diffAction(block).toLowerCase(),
    newText: block.newText == null ? '' : String(block.newText),
    oldText: block.oldText == null ? '' : String(block.oldText),
    path: String(block.path || '').trim(),
  }));
}

function boundedDiffText(value) {
  const text = String(value || '');
  if (text.length <= MAX_RENDERED_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_RENDERED_DIFF_CHARS)}\n\n[Diff detail truncated]`;
}

function renderedDiffText(block) {
  const path = String(block.path || '').trim();
  const oldText = block.oldText == null ? '' : String(block.oldText);
  const newText = block.newText == null ? '' : String(block.newText);
  const patch = createTwoFilesPatch(path, path, oldText, newText, 'before', 'after', { context: 3 });
  return `File: ${path}\n${boundedDiffText(patch)}`.trim();
}

function jsonText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolContentText(content) {
  return (Array.isArray(content) ? content : []).map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'content') {
      const inner = block.content;
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
      const terminal = block.terminal && typeof block.terminal === 'object' ? block.terminal : null;
      const status = terminal?.exitStatus
        ? `Exited ${terminal.exitStatus.exitCode ?? terminal.exitStatus.signal ?? ''}`.trim()
        : 'Running';
      const output = String(terminal?.output || '').trim();
      return [`Terminal: ${block.terminalId || ''} (${status})`.trim(), output].filter(Boolean).join('\n');
    }
    if (block.type === 'text') return String(block.text || '');
    return jsonText(block);
  }).filter(Boolean).join('\n\n').trim();
}

function equivalentJsonText(text, value) {
  const candidate = String(text || '').trim();
  if (!candidate || value === undefined || value === null) return false;
  if (candidate === jsonText(value).trim()) return true;
  try {
    return JSON.stringify(JSON.parse(candidate)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function toolOutputText(entry) {
  const output = entry.rawOutput;
  if (
    String(entry.kind || '').toLowerCase() === 'execute'
    && output
    && typeof output === 'object'
    && !Array.isArray(output)
  ) {
    const stdout = typeof output.stdout === 'string' ? output.stdout.trimEnd() : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr.trimEnd() : '';
    const sections = [];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`stderr\n${stderr}`);
    if (output.interrupted === true) sections.push('Interrupted');
    if (sections.length > 0) return sections.join('\n\n');
  }
  return jsonText(output).trim();
}

function detailForTool(entry) {
  const sections = [];
  const rawInput = jsonText(entry.rawInput).trim();
  // Terminal blocks have a dedicated, live presentation populated by the ACP
  // client terminal manager. Rendering the same block through generic detail
  // text duplicates its output directly below the terminal card.
  let structuredContent = toolContentText(
    (Array.isArray(entry.content) ? entry.content : []).filter(block => block?.type !== 'terminal')
  );
  const rawOutput = toolOutputText(entry);
  // Some ACP adapters mirror rawOutput as a text content block. Keep the
  // canonical output once instead of presenting the same JSON twice.
  if (equivalentJsonText(structuredContent, entry.rawOutput)) structuredContent = '';
  const locations = (Array.isArray(entry.locations) ? entry.locations : [])
    .map(location => {
      const path = String(location?.path || location?.uri || '');
      const line = location?.line == null ? '' : `:${location.line}`;
      return `${path}${line}`;
    })
    .filter(Boolean)
    .join('\n');
  if (rawInput) sections.push(`Input\n${rawInput}`);
  if (structuredContent) sections.push(structuredContent);
  if (rawOutput) sections.push(`Output\n${rawOutput}`);
  if (locations) sections.push(`Locations\n${locations}`);
  return sections.join('\n\n');
}

function transcriptMediaBlocks(entry) {
  const direct = Array.isArray(entry?.content) ? entry.content : [];
  const output = entry?.rawOutput && typeof entry.rawOutput === 'object' ? entry.rawOutput : {};
  const result = output?.result && typeof output.result === 'object' ? output.result : {};
  const raw = Array.isArray(result.content)
    ? result.content
    : (Array.isArray(output.content) ? output.content : []);
  const blocks = [...direct, ...raw].flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'terminal') return [{ type: 'terminal', terminalId: String(block.terminalId || '') }];
    if (['image', 'audio', 'resource_link'].includes(block.type)) return [JSON.parse(JSON.stringify(block))];
    if (block.type === 'resource') {
      const resource = block.resource && typeof block.resource === 'object' ? block.resource : {};
      return [{
        type: 'resource',
        resource: {
          name: resource.name,
          uri: resource.uri,
          mimeType: resource.mimeType,
        },
      }];
    }
    if (block.type !== 'content' || !block.content || typeof block.content !== 'object') return [];
    const content = block.content;
    if (['image', 'audio', 'resource_link'].includes(content.type)) {
      return [{ type: 'content', content: JSON.parse(JSON.stringify(content)) }];
    }
    if (content.type === 'resource') {
      const resource = content.resource && typeof content.resource === 'object' ? content.resource : {};
      return [{
        type: 'content',
        content: {
          type: 'resource',
          resource: {
            name: resource.name,
            uri: resource.uri,
            mimeType: resource.mimeType,
          },
        },
      }];
    }
    return [];
  });
  const seenTerminals = new Set();
  return blocks.filter(block => {
    if (block.type !== 'terminal') return true;
    if (!block.terminalId || seenTerminals.has(block.terminalId)) return false;
    seenTerminals.add(block.terminalId);
    return true;
  });
}

function generatedMediaTool(entry) {
  const title = String(entry?.title || '').trim().toLowerCase();
  const id = String(entry?.id || '').trim().toLowerCase();
  const output = entry?.rawOutput && typeof entry.rawOutput === 'object' ? entry.rawOutput : {};
  return id.startsWith('ig_')
    || title === 'image generation'
    || title === 'audio generation'
    || String(output.savedPath || '').includes('/generated_images/');
}

function acpTranscriptToolEntry(entry) {
  if (!entry || entry.type !== 'tool') return entry;
  const detail = detailForTool(entry);
  const changes = patchChanges(entry.content).map(change => ({
    path: change.path,
    kind: change.kind,
    added: change.added,
    removed: change.removed,
    ...(entry?._meta?.farming_patch_decisions?.[change.path]
      ? { decision: entry._meta.farming_patch_decisions[change.path] }
      : {}),
  }));
  const patchSummary = diffBlocks(entry.content)
    .map(block => `${diffAction(block)} ${String(block.path || '').trim()}`)
    .join('\n');
  const meta = {};
  if (entry?._meta?.subagent_session_info) {
    meta.subagent_session_info = JSON.parse(JSON.stringify(entry._meta.subagent_session_info));
  }
  if (entry?._meta?.farming_patch_decisions) {
    meta.farming_patch_decisions = JSON.parse(JSON.stringify(entry._meta.farming_patch_decisions));
  }
  return {
    id: String(entry.id || ''),
    type: 'tool',
    title: String(entry.title || ''),
    kind: String(entry.kind || 'other'),
    status: String(entry.status || ''),
    content: transcriptMediaBlocks(entry),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    transcriptDetail: detail.length <= MAX_INLINE_TOOL_DETAIL_CHARS
      ? detail
      : `${detail.slice(0, MAX_INLINE_TOOL_DETAIL_CHARS)}\n\n[Open to load full detail]`,
    transcriptDetailTruncated: detail.length > MAX_INLINE_TOOL_DETAIL_CHARS,
    transcriptPatchSummary: patchSummary,
    transcriptChanges: changes,
    generatedMedia: generatedMediaTool(entry),
    internal: entry.internal === true,
  };
}

module.exports = {
  acpToolChanges: entry => patchChanges(entry?.content, { includeDiff: true }),
  acpToolDetail: detailForTool,
  acpToolReviewChanges: entry => patchReviewChanges(entry?.content),
  acpTranscriptToolEntry,
};
