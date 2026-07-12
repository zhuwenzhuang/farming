function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
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
      const oldText = block.oldText == null ? '' : String(block.oldText);
      return [`File: ${block.path || ''}`, '--- before', oldText, '+++ after', String(block.newText || '')]
        .filter(Boolean)
        .join('\n');
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

function projectEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.internal === true && entry.type !== 'message') return null;
  if (entry.type === 'message') {
    const text = contentText(entry.content);
    const images = contentImages(entry.content, entry.id || 'message');
    if (!text && images.length === 0) return null;
    if (entry.internal === true && entry.role !== 'assistant') return null;
    return {
      id: String(entry.id || ''),
      type: 'message',
      role: entry.role === 'user' ? 'user' : 'assistant',
      text,
      images,
      internal: entry.internal === true,
    };
  }
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
    return {
      id: String(entry.id || ''),
      type: 'tool',
      kind: String(entry.kind || 'other'),
      title: String(entry.title || 'Tool'),
      detail: detailForTool(entry),
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

function acpSessionTranscript(session, options = {}) {
  const allEntries = (Array.isArray(session?.entries) ? session.entries : [])
    .map(projectEntry)
    .filter(Boolean);
  const maxEntries = Number.isFinite(Number(options.maxEntries))
    ? Math.max(1, Math.floor(Number(options.maxEntries)))
    : 600;
  const entries = allEntries.slice(-maxEntries);
  return {
    version: 2,
    available: entries.length > 0,
    reason: entries.length > 0 ? undefined : 'empty-acp-session',
    sessionId: String(session?.sessionId || ''),
    updatedAt: String(session?.updatedAt || ''),
    source: 'acp',
    state: String(session?.state || ''),
    stopReason: String(session?.stopReason || ''),
    hasMoreBefore: allEntries.length > entries.length,
    entryLimit: maxEntries,
    truncated: session?.truncated === true,
    entries,
  };
}

module.exports = { acpSessionTranscript };
