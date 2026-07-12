const { createTwoFilesPatch } = require('diff');

const MAX_RENDERED_DIFF_CHARS = 64 * 1024;

function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
}

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

function patchSummaryText(content) {
  return diffBlocks(content)
    .map(block => `${diffAction(block)} ${block.path.trim()}`)
    .join('\n');
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
    if (block.type === 'terminal') return `Terminal: ${block.terminalId || ''}`.trim();
    if (block.type === 'text') return String(block.text || '');
    return jsonText(block);
  }).filter(Boolean).join('\n\n').trim();
}

function contentImages(content, prefix) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'image' && typeof block.data === 'string' && block.data)
    .map((block, index) => ({
      id: `${prefix}-image-${index + 1}`,
      url: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
      alt: 'Image',
    }));
}

function detailForTool(entry) {
  const sections = [];
  const rawInput = jsonText(entry.rawInput).trim();
  const structuredContent = toolContentText(entry.content);
  const rawOutput = jsonText(entry.rawOutput).trim();
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

function planDetail(plan) {
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  if (entries.length > 0) {
    return entries.map(entry => `${entry.status || 'pending'}: ${entry.content || entry.title || ''}`).join('\n');
  }
  if (plan?.type === 'markdown') return String(plan.content || '');
  if (plan?.type === 'file') return String(plan.uri || '');
  return '';
}

function processEntry(entry) {
  if (entry.type === 'thought') {
    const detail = contentText(entry.content);
    if (!detail) return null;
    return {
      id: String(entry.id || ''),
      type: 'thought',
      title: 'Reasoning',
      detail,
      status: 'completed',
    };
  }
  if (entry.type === 'tool') {
    const patchSummary = patchSummaryText(entry.content);
    const detail = detailForTool(entry);
    return {
      id: String(entry.id || ''),
      type: patchSummary ? 'patch' : 'tool',
      kind: String(entry.kind || 'other'),
      title: String(entry.title || 'Tool'),
      detail: [patchSummary, detail].filter(Boolean).join('\n\n'),
      status: String(entry.status || ''),
    };
  }
  if (entry.type === 'plan') {
    const detail = planDetail(entry.plan);
    if (!detail) return null;
    const items = Array.isArray(entry.plan?.entries) ? entry.plan.entries : [];
    return {
      id: String(entry.id || ''),
      type: 'plan',
      title: 'Plan',
      detail,
      status: items.length > 0 && items.every(item => item.status === 'completed') ? 'completed' : 'running',
    };
  }
  return null;
}

function emptyTurn(id, internal) {
  return {
    id,
    internal,
    userMessage: '',
    userImages: [],
    userFiles: [],
    finalMessage: '',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    status: 'completed',
    processItems: [],
    assistantMessages: [],
  };
}

function finishTurn(turn) {
  if (!turn) return null;
  if (turn.assistantMessages.length > 0) {
    turn.finalMessage = turn.assistantMessages[turn.assistantMessages.length - 1];
    if (!turn.internal) {
      const progress = turn.assistantMessages.slice(0, -1).filter(Boolean);
      if (progress.length > 0) {
        turn.processItems.unshift({
          id: `${turn.id}-progress-updates`,
          type: 'progress',
          title: 'Progress updates',
          detail: progress.join('\n\n'),
          status: 'completed',
        });
      }
    }
  }
  delete turn.assistantMessages;
  if (turn.internal) turn.processItems = [];
  delete turn.internal;
  return turn.userMessage || turn.finalMessage || turn.userImages.length > 0 || turn.processItems.length > 0
    ? turn
    : null;
}

function acpSessionTranscript(session, options = {}) {
  const turns = [];
  let current = null;
  let sequence = 0;
  const flush = () => {
    const finished = finishTurn(current);
    if (finished) turns.push(finished);
    current = null;
  };
  for (const entry of Array.isArray(session?.entries) ? session.entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'message' && entry.role === 'user') {
      flush();
      current = emptyTurn(`acp-segment-${++sequence}`, entry.internal === true);
      if (!entry.internal) {
        current.userMessage = contentText(entry.content);
        current.userImages = contentImages(entry.content, entry.id || current.id);
      }
      continue;
    }
    if (!current) current = emptyTurn(`acp-segment-${++sequence}`, entry.internal === true);
    if (entry.internal === true && !current.internal) {
      flush();
      current = emptyTurn(`acp-segment-${++sequence}`, true);
    }
    if (entry.type === 'message' && entry.role === 'assistant') {
      const text = contentText(entry.content);
      // Preserve an empty sanitized assistant entry as the final boundary. A
      // DONT_NOTIFY heartbeat is intentionally empty; promoting the preceding
      // progress sentence to a user-visible result would leak internal work.
      current.assistantMessages.push(text);
      continue;
    }
    if (current.internal || entry.internal === true) continue;
    const process = processEntry(entry);
    if (process) current.processItems.push(process);
  }
  flush();

  if (turns.length > 0 && ['working', 'waiting-for-permission', 'interrupting'].includes(String(session?.state || ''))) {
    turns[turns.length - 1].status = 'inProgress';
  }
  const maxTurns = Number.isFinite(Number(options.maxTurns))
    ? Math.max(1, Math.floor(Number(options.maxTurns)))
    : 80;
  const visibleTurns = turns.slice(-maxTurns);
  return {
    version: 2,
    available: visibleTurns.length > 0,
    reason: visibleTurns.length > 0 ? undefined : 'empty-acp-session',
    sessionId: String(session?.sessionId || ''),
    updatedAt: String(session?.updatedAt || ''),
    source: 'acp',
    hasMoreBefore: turns.length > visibleTurns.length,
    turnLimit: maxTurns,
    truncated: session?.truncated === true,
    turns: visibleTurns,
  };
}

module.exports = { acpSessionTranscript };
