const { createTwoFilesPatch, diffLines } = require('diff');

const MAX_RENDERED_DIFF_CHARS = 64 * 1024;

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

module.exports = {
  acpToolChanges: entry => patchChanges(entry?.content, { includeDiff: true }),
  acpToolDetail: detailForTool,
  acpToolReviewChanges: entry => patchReviewChanges(entry?.content),
};
