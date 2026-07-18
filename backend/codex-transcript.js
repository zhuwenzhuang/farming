const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { findCodexRolloutFile } = require('./codex-rollout-follower');
const {
  heartbeatAssistantMessage,
  heartbeatUserMessage,
  isCodexInjectedContextMessage,
  stripCodexInternalContextBlocks,
} = require('./codex-transcript-sanitizer');

// @deprecated `readCodexTranscript` below is the legacy JSONL file reader.
// App Server uses the generic event-to-turn projection exported here instead.
const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TURNS = 240;
const USER_MESSAGE_BEGIN = '## My request for Codex:';
const MAX_USER_IMAGES_PER_TURN = 6;
const MAX_USER_IMAGE_URL_LENGTH = 5 * 1024 * 1024;
const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_USER_AUDIOS_PER_TURN = 6;
const MAX_USER_AUDIO_URL_LENGTH = 10 * 1024 * 1024;
const MAX_LOCAL_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_USER_FILES_PER_TURN = 6;
const MAX_USER_FILE_CONTENT_CHARS = 50_000;
const CODEX_HISTORY_IMAGE_LINK_PATTERN = /\[@(?:image|[^\]]+\.(?:gif|jpe?g|png|svg|webp))\]\(([^)\n]+)\)/gi;

const LOCAL_IMAGE_MIME_BY_EXT = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const LOCAL_AUDIO_MIME_BY_EXT = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function normalizeDeltaText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function extractMemoryCitationBlock(value) {
  const text = normalizeText(value);
  if (!text) return { text: '', detail: '' };
  const blocks = [];
  const cleaned = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, (block) => {
    blocks.push(block);
    return '';
  });
  return {
    text: normalizeText(cleaned),
    detail: blocks.map(formatRawMemoryCitationBlock).filter(Boolean).join('\n\n'),
  };
}

function formatRawMemoryCitationBlock(block) {
  return normalizeText(block)
    .replace(/<\/?oai-mem-citation>/g, '')
    .replace(/<citation_entries>/g, 'citation entries:\n')
    .replace(/<\/citation_entries>/g, '')
    .replace(/<rollout_ids>/g, '\nrollout ids:\n')
    .replace(/<\/rollout_ids>/g, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function detailForMemoryCitation(memoryCitation) {
  if (!memoryCitation || typeof memoryCitation !== 'object') return '';
  const rows = [];
  const entries = Array.isArray(memoryCitation.entries) ? memoryCitation.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const pathLabel = compactInline(entry.path || '');
    const lineStart = entry.lineStart ?? entry.line_start;
    const lineEnd = entry.lineEnd ?? entry.line_end;
    const lineLabel = Number.isFinite(lineStart)
      ? `:${lineStart}${Number.isFinite(lineEnd) && lineEnd !== lineStart ? `-${lineEnd}` : ''}`
      : '';
    const note = compactInline(entry.note || '');
    rows.push(`${pathLabel}${lineLabel}${note ? ` | ${note}` : ''}`);
  }
  const threadIds = Array.isArray(memoryCitation.threadIds)
    ? memoryCitation.threadIds
    : (Array.isArray(memoryCitation.thread_ids) ? memoryCitation.thread_ids : []);
  if (threadIds.length) rows.push(`threads: ${threadIds.map(id => compactInline(id)).filter(Boolean).join(', ')}`);
  return summarizeOutput(rows.join('\n'));
}

function appendMemoryCitation(turn, id, memoryCitation, rawDetail = '') {
  const detail = [detailForMemoryCitation(memoryCitation), rawDetail].filter(Boolean).join('\n\n');
  if (!detail) return;
  appendProcess(turn, {
    id: `${id || turn.id || 'message'}-memory-citation`,
    type: 'citation',
    title: 'Memory citations',
    detail,
    status: 'completed',
  });
}

function finalMessageText(value, turn, id, memoryCitation) {
  const extracted = extractMemoryCitationBlock(value);
  appendMemoryCitation(turn, id, memoryCitation, extracted.detail);
  const heartbeatMessage = heartbeatAssistantMessage(extracted.text);
  if (heartbeatMessage || heartbeatMessage === '') {
    const text = normalizeText(extracted.text);
    if (/^<heartbeat(?:\s+[^>]*)?>[\s\S]*<\/heartbeat>$/i.test(text)) return heartbeatMessage;
  }
  return stripCodexInternalContextBlocks(extracted.text);
}

function stripUserMessagePrefix(value) {
  const text = normalizeText(value);
  const index = text.indexOf(USER_MESSAGE_BEGIN);
  return index >= 0 ? text.slice(index + USER_MESSAGE_BEGIN.length).trim() : text;
}

function isInjectedContextMessage(value) {
  return isCodexInjectedContextMessage(value);
}

function renderedAttachmentKindSet(options = {}) {
  return new Set(Array.isArray(options.renderedAttachmentKinds) ? options.renderedAttachmentKinds : []);
}

function extractComposerFileAttachments(value) {
  const text = normalizeText(value);
  if (!text) return { text: '', files: [] };
  const files = [];
  const pattern = /(^|\n{2,})\s*Attached file:\s*([^\n]*)(?:\n{2,}|\n)([\s\S]*?)(?=\n{2,}\s*Attached (?:file|image):|\n{2,}\s*<image\b|$)/gi;
  const stripped = text.replace(pattern, (match, prefix, rawName, rawContent) => {
    if (files.length < MAX_USER_FILES_PER_TURN) {
      const name = compactInline(rawName, `attachment-${files.length + 1}`);
      const originalContent = String(rawContent || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trimEnd();
      const errorMatch = originalContent.trim().match(/^\[([^\]]+)\]$/);
      const truncatedMarker = originalContent.match(/\n{2,}\[File truncated after\s+(\d+)\s+characters\]\s*$/i);
      const contentWithoutMarker = truncatedMarker
        ? originalContent.slice(0, truncatedMarker.index).trimEnd()
        : originalContent;
      const truncated = Boolean(truncatedMarker) || contentWithoutMarker.length > MAX_USER_FILE_CONTENT_CHARS;
      files.push({
        id: `file-${files.length + 1}`,
        name,
        content: errorMatch ? '' : contentWithoutMarker.slice(0, MAX_USER_FILE_CONTENT_CHARS),
        error: errorMatch ? errorMatch[1] : '',
        truncated,
      });
    }
    return prefix || '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, files };
}

function findLastTranscriptTimestamp(text) {
  const pattern = /(?:^|\n)(?:[A-Za-z]+day\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)\s*\n/gi;
  let match = null;
  let next;
  while ((next = pattern.exec(text))) match = next;
  if (!match) return null;
  return {
    index: match.index + (match[0].startsWith('\n') ? 1 : 0),
    end: match.index + match[0].length,
  };
}

function extractReferencedPastedTranscriptContext(value) {
  const text = normalizeText(value);
  if (!text || text.length < 1200 || !/\nReferenced pasted text files:\n/i.test(text)) {
    return { text, files: [] };
  }

  const referenceMatch = text.match(/\nReferenced pasted text files:\n[\s\S]*?(?=\n(?:Sent as goal|Goal blocked|\d{1,2}:\d{2}\s*(?:AM|PM)|$))/i);
  if (!referenceMatch || referenceMatch.index === undefined) return { text, files: [] };

  const beforeReference = text.slice(0, referenceMatch.index).trimEnd();
  const timestamp = findLastTranscriptTimestamp(beforeReference);
  if (!timestamp || timestamp.index < 400) return { text, files: [] };

  const pastedContext = beforeReference.slice(0, timestamp.index).trim();
  const userRequest = beforeReference.slice(timestamp.end).trim();
  if (!pastedContext || !userRequest) return { text, files: [] };

  const referenceBlock = referenceMatch[0].trim();
  const remaining = text.slice(referenceMatch.index + referenceMatch[0].length).trim();
  const trailingContext = remaining
    ? remaining.replace(/^Sent as goal\s*/i, '').trim()
    : '';
  const content = [pastedContext, trailingContext].filter(Boolean).join('\n\n---\n\n');
  const truncated = content.length > MAX_USER_FILE_CONTENT_CHARS;

  return {
    text: [userRequest, referenceBlock].filter(Boolean).join('\n\n'),
    files: [{
      id: 'file-pasted-transcript-context',
      name: 'pasted-transcript-context.txt',
      content: content.slice(0, MAX_USER_FILE_CONTENT_CHARS),
      truncated,
    }],
  };
}

function extractCodexApprovalTranscriptContext(value) {
  const text = normalizeText(value);
  if (
    !text ||
    text.length < 500 ||
    !/^The following is the Codex agent history(?: whose request action you are assessing| added since your last approval assessment)\b/i.test(text)
  ) {
    return { text, files: [] };
  }

  const firstParagraph = text.split(/\n{2,}/)[0].trim();
  const truncated = text.length > MAX_USER_FILE_CONTENT_CHARS;
  return {
    text: firstParagraph,
    files: [{
      id: 'file-codex-approval-transcript',
      name: 'codex-approval-transcript.txt',
      content: text.slice(0, MAX_USER_FILE_CONTENT_CHARS),
      truncated,
    }],
  };
}

function parseSubagentNotification(value) {
  const text = normalizeText(value);
  const match = text.match(/^<subagent_notification(?:\s+[^>]*)?>([\s\S]*?)<\/subagent_notification>$/i);
  if (!match) return null;
  const payload = parseJsonValue(match[1]);
  if (!payload || typeof payload !== 'object') {
    return {
      title: 'Subagent update',
      detail: normalizeText(match[1]),
      status: 'completed',
    };
  }
  const status = payload.status && typeof payload.status === 'object' ? payload.status : {};
  const completed = typeof status.completed === 'string' ? status.completed : '';
  const failed = typeof status.failed === 'string' ? status.failed : '';
  const detail = completed || failed || compactInline(status.message || payload.message || '');
  return {
    title: failed ? 'Subagent failed' : completed ? 'Subagent completed' : 'Subagent update',
    detail,
    status: failed ? 'failed' : 'completed',
  };
}

function stripRenderedAttachmentTagBlocks(value, renderedKinds) {
  const text = normalizeText(value);
  if (!text) return '';
  let next = text;
  for (const kind of renderedKinds) {
    const tagName = String(kind || '').replace(/[^a-z0-9_-]/gi, '');
    if (!tagName) continue;
    const pattern = new RegExp(`(^|\\n{2,})\\s*<${tagName}\\b[\\s\\S]*?<\\/${tagName}>\\s*(?=\\n{2,}|$)`, 'gi');
    next = next.replace(pattern, '$1');
  }
  return next
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripRenderedComposerAttachmentBlocks(value, renderedKinds) {
  const text = normalizeText(value);
  if (!text) return '';
  let next = text;
  for (const kind of renderedKinds) {
    const label = String(kind || '').replace(/[^a-z0-9_-]/gi, '');
    if (!label) continue;
    if (label.toLowerCase() === 'file') {
      next = extractComposerFileAttachments(next).text;
      continue;
    }
    const title = label.charAt(0).toUpperCase() + label.slice(1);
    const pattern = new RegExp(`(^|\\n{2,})\\s*Attached ${label}:[^\\n]*(?:\\n{2,}|\\n)(?:${title} path:|\\[[^\\]]+\\])[^\\n]*(?=\\n{2,}|$)`, 'gi');
    next = next.replace(pattern, '$1');
  }
  return next
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function codexHistoryImageTargets(value) {
  const text = String(value || '');
  const targets = [];
  let match;
  CODEX_HISTORY_IMAGE_LINK_PATTERN.lastIndex = 0;
  while ((match = CODEX_HISTORY_IMAGE_LINK_PATTERN.exec(text))) {
    const target = String(match[1] || '').trim();
    if (!target || targets.includes(target)) continue;
    targets.push(target);
    if (targets.length >= MAX_USER_IMAGES_PER_TURN) break;
  }
  return targets;
}

function localImagePathFromTarget(value) {
  const target = String(value || '').trim();
  if (!target || target.includes('\0') || /^data:/i.test(target)) return '';
  if (/^file:\/\//i.test(target)) {
    try {
      return fileURLToPath(target);
    } catch {
      return '';
    }
  }
  return path.isAbsolute(target) ? target : '';
}

function localImagePathsFromUserContent(content) {
  const paths = [];
  const append = (value) => {
    const filePath = localImagePathFromTarget(value);
    if (!filePath || !LOCAL_IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || paths.includes(filePath)) return;
    paths.push(filePath);
  };
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== 'object') continue;
    if (['local_image', 'localImage'].includes(part.type)) append(part.path || part.file || part.url);
    const text = typeof part.text === 'string' ? part.text : '';
    for (const match of text.matchAll(/<image\b[^>]*\bpath=(['"])(.*?)\1/gi)) append(match[2]);
    for (const match of text.matchAll(/^##\s+[^\n:]+:\s*(.+)$/gim)) append(match[1]);
  }
  return paths.slice(0, MAX_USER_IMAGES_PER_TURN);
}

function dataImageUrlsFromUserContent(content) {
  const urls = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== 'object' || !['input_image', 'inputImage', 'image'].includes(part.type)) continue;
    const value = String(part.image_url || part.imageUrl || part.url || part.data || '');
    if (!/^data:image\/(?:gif|jpe?g|png|svg\+xml|webp);base64,/i.test(value)) continue;
    if (value.length > MAX_USER_IMAGE_URL_LENGTH || urls.includes(value)) continue;
    urls.push(value);
    if (urls.length >= MAX_USER_IMAGES_PER_TURN) break;
  }
  return urls;
}

function appendHistoryImageDataFromContent(imageDataByPath, content) {
  const paths = localImagePathsFromUserContent(content);
  const urls = dataImageUrlsFromUserContent(content);
  for (let index = 0; index < Math.min(paths.length, urls.length); index += 1) {
    if (!imageDataByPath.has(paths[index])) imageDataByPath.set(paths[index], urls[index]);
  }
}

function stripRenderedCodexHistoryAttachmentLinks(value, renderedKinds) {
  const text = normalizeText(value);
  if (!text || !renderedKinds.has('image')) return text;
  CODEX_HISTORY_IMAGE_LINK_PATTERN.lastIndex = 0;
  return text
    .replace(CODEX_HISTORY_IMAGE_LINK_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function visibleUserMessageText(value, options = {}) {
  const rawText = stripUserMessagePrefix(value);
  const heartbeatMessage = heartbeatUserMessage(rawText);
  if (heartbeatMessage) return heartbeatMessage;
  const text = stripCodexInternalContextBlocks(rawText);
  if (isInjectedContextMessage(text)) return '';
  const renderedKinds = renderedAttachmentKindSet(options);
  return stripRenderedCodexHistoryAttachmentLinks(
    stripRenderedComposerAttachmentBlocks(stripRenderedAttachmentTagBlocks(text, renderedKinds), renderedKinds),
    renderedKinds,
  );
}

function renderedAttachmentKindsForTurn(turn) {
  const kinds = [];
  if (turn && Array.isArray(turn.userImages) && turn.userImages.length > 0) kinds.push('image');
  if (turn && Array.isArray(turn.userAudios) && turn.userAudios.length > 0) kinds.push('audio');
  if (turn && Array.isArray(turn.userFiles) && turn.userFiles.length > 0) kinds.push('file');
  return kinds;
}

function renderedAttachmentKindsForAttachments({ images = [], audios = [], files = [] } = {}) {
  const kinds = [];
  if (Array.isArray(images) && images.length > 0) kinds.push('image');
  if (Array.isArray(audios) && audios.length > 0) kinds.push('audio');
  if (Array.isArray(files) && files.length > 0) kinds.push('file');
  return kinds;
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactInline(value, fallback = '') {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  return text || fallback;
}

function humanizeType(value, fallback = 'Event') {
  const text = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function textFromContent(content) {
  if (typeof content === 'string') return normalizeText(content);
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.text === 'string') return normalizeText(content.text);
    if (typeof content.content === 'string') return normalizeText(content.content);
    if (Array.isArray(content.content)) return textFromContent(content.content);
    if (Array.isArray(content.content_items)) return textFromContent(content.content_items);
    if (Array.isArray(content.contentItems)) return textFromContent(content.contentItems);
    return '';
  }
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function imageAltFromContentPart(part, index) {
  const fallback = `Image ${index + 1}`;
  if (!part || typeof part !== 'object') return fallback;
  return compactInline(part.name || part.filename || part.path || part.alt || '', fallback);
}

function imageAltFromPath(filePath, index) {
  const basename = path.basename(String(filePath || ''));
  return basename || `Image ${index + 1}`;
}

function isDisplayableImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.length > MAX_USER_IMAGE_URL_LENGTH) return false;
  return url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://');
}

function imagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'localImage') {
      const image = imageFromLocalPath(part.path, images.length);
      if (image) images.push(image);
      if (images.length >= MAX_USER_IMAGES_PER_TURN) break;
      continue;
    }
    if (part.type !== 'input_image' && part.type !== 'inputImage' && part.type !== 'image') continue;
    const url = part.image_url || part.imageUrl || part.url || part.data;
    if (isDisplayableImageUrl(url)) {
      images.push({
        id: `image-${images.length + 1}`,
        url,
        alt: imageAltFromContentPart(part, images.length),
      });
    } else {
      const localImage = imageFromLocalPath(part.path || part.file || part.localPath, images.length);
      if (localImage) images.push(localImage);
    }
    if (images.length >= MAX_USER_IMAGES_PER_TURN) break;
  }
  return images;
}

function audioMimeFromUrl(url) {
  const dataMime = String(url || '').match(/^data:(audio\/[^;,]+)[;,]/i)?.[1];
  if (dataMime) return dataMime.toLowerCase();
  try {
    return LOCAL_AUDIO_MIME_BY_EXT[path.extname(new URL(url).pathname).toLowerCase()] || '';
  } catch {
    return '';
  }
}

function audioNameFromPart(part, index) {
  const explicit = compactInline(part?.name || part?.filename || '');
  if (explicit) return explicit;
  const target = String(part?.path || part?.url || '');
  if (target && !/^data:/i.test(target)) {
    try {
      const basename = path.basename(new URL(target, 'file:///').pathname);
      if (basename) return basename;
    } catch {
      const basename = path.basename(target);
      if (basename) return basename;
    }
  }
  return `Audio ${index + 1}`;
}

function audioFromLocalPath(filePath, index) {
  const normalized = String(filePath || '').trim();
  if (!normalized || normalized.includes('\0')) return null;
  const mimeType = LOCAL_AUDIO_MIME_BY_EXT[path.extname(normalized).toLowerCase()];
  if (!mimeType) return null;
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCAL_AUDIO_BYTES) return null;
    return {
      id: `local-audio-${index + 1}`,
      url: `data:${mimeType};base64,${fs.readFileSync(normalized).toString('base64')}`,
      mimeType,
      name: path.basename(normalized) || `Audio ${index + 1}`,
    };
  } catch {
    return null;
  }
}

function audiosFromContent(content) {
  if (!Array.isArray(content)) return [];
  const audios = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    let audio = null;
    if (part.type === 'localAudio') {
      audio = audioFromLocalPath(part.path, audios.length);
    } else if (part.type === 'audio') {
      const url = String(part.url || '');
      if (
        url.length <= MAX_USER_AUDIO_URL_LENGTH
        && (/^data:audio\//i.test(url) || /^https?:\/\//i.test(url))
      ) {
        audio = {
          id: `audio-${audios.length + 1}`,
          url,
          mimeType: audioMimeFromUrl(url),
          name: audioNameFromPart(part, audios.length),
        };
      }
    }
    if (audio && !audios.some(existing => existing.url === audio.url)) audios.push(audio);
    if (audios.length >= MAX_USER_AUDIOS_PER_TURN) break;
  }
  return audios;
}

function inlineImageFromEntry(entry, index) {
  if (typeof entry === 'string') {
    return isDisplayableImageUrl(entry)
      ? { id: `image-${index + 1}`, url: entry, alt: `Image ${index + 1}` }
      : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const url = entry.image_url || entry.imageUrl || entry.url || entry.data;
  if (!isDisplayableImageUrl(url)) return imageFromLocalPath(entry.path || entry.file || entry.localPath, index);
  return {
    id: `image-${index + 1}`,
    url,
    alt: imageAltFromContentPart(entry, index),
  };
}

function imageFromValue(value, index, alt = '') {
  if (isDisplayableImageUrl(value)) {
    return { id: `image-${index + 1}`, url: value, alt: compactInline(alt, `Image ${index + 1}`) };
  }
  return imageFromLocalPath(value, index);
}

function imagesFromImageItem(item) {
  if (!item || typeof item !== 'object') return [];
  const candidates = [
    item.result,
    item.src,
    item.url,
    item.saved_path,
    item.savedPath,
    item.path,
  ];
  const images = [];
  for (const candidate of candidates) {
    const image = imageFromValue(candidate, images.length, item.title || item.alt || 'Generated image');
    if (!image || images.some(existing => existing.url === image.url)) continue;
    images.push(image);
    if (images.length >= MAX_USER_IMAGES_PER_TURN) break;
  }
  return images;
}

function imageFromLocalPath(filePath, index) {
  const normalized = String(filePath || '').trim();
  if (!normalized || normalized.includes('\0')) return null;
  const ext = path.extname(normalized).toLowerCase();
  const mime = LOCAL_IMAGE_MIME_BY_EXT[ext];
  if (!mime) return null;
  let stat = null;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCAL_IMAGE_BYTES) return null;
  try {
    const base64 = fs.readFileSync(normalized).toString('base64');
    return {
      id: `local-image-${index + 1}`,
      url: `data:${mime};base64,${base64}`,
      alt: imageAltFromPath(normalized, index),
    };
  } catch {
    return null;
  }
}

function imagesFromUserMessagePayload(payload) {
  const images = [];
  const appendImage = (image) => {
    if (!image || images.length >= MAX_USER_IMAGES_PER_TURN) return;
    if (images.some(existing => existing.url === image.url)) return;
    images.push({
      ...image,
      id: image.id || `image-${images.length + 1}`,
    });
  };

  const inlineImages = Array.isArray(payload.images) ? payload.images : [];
  for (const image of imagesFromContent(inlineImages)) {
    appendImage(image);
  }
  for (const entry of inlineImages) {
    appendImage(inlineImageFromEntry(entry, images.length));
  }

  const localImages = Array.isArray(payload.local_images)
    ? payload.local_images
    : (Array.isArray(payload.localImages) ? payload.localImages : []);
  for (const entry of localImages) {
    const filePath = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' ? entry.path || entry.file || entry.url : '');
    appendImage(imageFromLocalPath(filePath, images.length));
  }

  return images;
}

function summarizeStructuredOutput(output) {
  if (typeof output === 'string') return summarizeOutput(output);
  if (Array.isArray(output)) {
    const text = output
      .map(part => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (typeof part.value === 'string') return part.value;
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
    return summarizeOutput(text);
  }
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return summarizeOutput(output.content);
    if (Array.isArray(output.content)) return summarizeStructuredOutput(output.content);
    if (Array.isArray(output.content_items)) return summarizeStructuredOutput(output.content_items);
    if (Array.isArray(output.contentItems)) return summarizeStructuredOutput(output.contentItems);
    return summarizeOutput(JSON.stringify(output, null, 2));
  }
  return '';
}

function imagesFromStructuredOutput(output) {
  if (Array.isArray(output)) return imagesFromContent(output);
  if (output && typeof output === 'object') {
    const images = [];
    const append = (image) => {
      if (!image || images.length >= MAX_USER_IMAGES_PER_TURN) return;
      if (images.some(existing => existing.url === image.url)) return;
      images.push(image);
    };
    for (const field of ['content', 'content_items', 'contentItems']) {
      if (!Array.isArray(output[field])) continue;
      for (const image of imagesFromContent(output[field])) append(image);
    }
    return images;
  }
  return [];
}

function commandText(command) {
  if (Array.isArray(command)) return command.map(part => String(part || '')).filter(Boolean).join(' ');
  return normalizeText(command);
}

function titleForParsedCommand(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const kind = String(parsed.type || '').trim();
  const lowerKind = kind.replace(/_/g, '').toLowerCase();
  const commandName = compactInline(parsed.command || parsed.cmd || '');
  if (lowerKind === 'search') {
    const name = compactInline(parsed.query || parsed.name || commandName || parsed.path || '');
    return name ? `Searched ${name}` : 'Searched files';
  }
  const name = compactInline(parsed.name || parsed.path || parsed.query || commandName || '');
  if (lowerKind === 'read') return name ? `Read ${name}` : 'Read file';
  if (lowerKind === 'listfiles') return name ? `Listed ${name}` : 'Listed files';
  if (lowerKind === 'write') return name ? `Edited ${name}` : 'Edited file';
  return '';
}

function titleForCommandExecution(payload) {
  const actions = Array.isArray(payload.command_actions) ? payload.command_actions : payload.commandActions;
  const parsedActions = Array.isArray(actions) ? actions : payload.parsed_cmd;
  const parsed = Array.isArray(parsedActions) && parsedActions.length === 1
    ? titleForParsedCommand(parsedActions[0])
    : '';
  if (parsed) return parsed;
  const cmd = compactInline(commandText(payload.command));
  return cmd ? `Ran ${cmd}` : 'Ran command';
}

function summarizeApplyPatchText(input) {
  const text = normalizeText(input);
  if (!text.startsWith('*** Begin Patch')) return '';
  const rows = [];
  let active = null;
  const flush = () => {
    if (!active) return;
    const statLabel = [
      active.added > 0 ? `+${active.added}` : '',
      active.removed > 0 ? `-${active.removed}` : '',
    ].filter(Boolean).join(' ');
    rows.push(`${active.kind} ${active.path}${statLabel ? ` ${statLabel}` : ''}`);
  };
  for (const line of text.split('\n')) {
    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (addMatch || updateMatch || deleteMatch) {
      flush();
      active = {
        kind: addMatch ? 'add' : deleteMatch ? 'delete' : 'update',
        path: addMatch?.[1] || updateMatch?.[1] || deleteMatch?.[1] || '',
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (moveMatch && active) {
      active.kind = 'move';
      active.path = moveMatch[1] || active.path;
      continue;
    }
    if (!active || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) active.added += 1;
    else if (line.startsWith('-')) active.removed += 1;
  }
  flush();
  return rows.slice(0, 16).join('\n');
}

function applyPatchTitleFromText(input) {
  const summary = summarizeApplyPatchText(input);
  if (!summary) return '';
  const count = summary.split('\n').filter(Boolean).length;
  if (count === 1) return 'Edited 1 file';
  if (count > 1) return `Edited ${count} files`;
  return '';
}

function processTitleForFunctionCall(payload) {
  const name = String(payload.name || '').trim();
  const args = parseJsonValue(payload.arguments);
  if (name === 'exec_command') {
    const cmd = normalizeText(args && args.cmd).replace(/\s+/g, ' ');
    return cmd ? `Ran ${cmd}` : 'Ran command';
  }
  if (name === 'apply_patch') return applyPatchTitleFromText(payload.input || payload.arguments) || 'Applied patch';
  if (name === 'view_image') return 'Viewed image';
  if (name === 'update_plan') return 'Updated plan';
  if (name === 'read_mcp_resource') return 'Read resource';
  if (name) return `Used ${name}`;
  return 'Used tool';
}

function processTypeForFunctionCall(payload) {
  const name = String(payload.name || '').trim();
  if (name === 'exec_command') return 'command';
  if (name === 'apply_patch') return 'patch';
  if (name === 'view_image') return 'image';
  if (name === 'update_plan') return 'plan';
  if (name === 'imagegen' || name === 'image_gen' || name === 'image_generation') return 'image-generation';
  return 'tool';
}

function detailForFunctionCall(payload) {
  const args = normalizeText(payload.arguments || payload.input);
  if (!args) return '';
  if (String(payload.name || '').trim() === 'apply_patch') {
    const patchSummary = summarizeApplyPatchText(args);
    if (patchSummary) return patchSummary;
  }
  const parsed = parseJsonValue(args);
  if (parsed) {
    if (typeof parsed.cmd === 'string') return parsed.cmd;
    if (typeof parsed.prompt === 'string') return parsed.prompt;
    return JSON.stringify(parsed, null, 2);
  }
  return args;
}

function titleForLocalShell(payload) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  const command = action.command || action.cmd || payload.command;
  const cmd = compactInline(command);
  return cmd ? `Ran ${cmd}` : 'Ran local shell';
}

function detailForLocalShell(payload) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  return summarizeOutput([
    action.cwd ? `cwd: ${action.cwd}` : '',
    action.command || action.cmd || '',
    payload.status ? `status: ${payload.status}` : '',
  ].filter(Boolean).join('\n'));
}

function summarizeOutput(output) {
  const text = normalizeText(output);
  if (!text) return '';
  const lines = text.split('\n').map(line => line.trimEnd()).filter(Boolean);
  const visible = lines.slice(0, 8).join('\n');
  if (lines.length <= 8) return visible;
  return `${visible}\n... +${lines.length - 8} lines`;
}

function summarizeCommandOutput(payload) {
  const chunks = [
    payload.formatted_output,
    payload.aggregated_output,
    payload.aggregatedOutput,
    payload.stdout,
    payload.stderr,
  ].filter(value => normalizeText(value));
  const output = chunks.join('\n');
  const prefix = [];
  if (payload.cwd) prefix.push(`cwd: ${payload.cwd}`);
  if (Number.isFinite(payload.exit_code)) prefix.push(`exit: ${payload.exit_code}`);
  else if (Number.isFinite(payload.exitCode)) prefix.push(`exit: ${payload.exitCode}`);
  const body = summarizeOutput(output);
  return [prefix.join(' · '), body].filter(Boolean).join('\n');
}

function normalizePatchChanges(changes) {
  if (Array.isArray(changes)) {
    return changes.map((change, index) => {
      if (!change || typeof change !== 'object') {
        return { path: `change-${index + 1}`, kind: '', diff: '' };
      }
      return {
        path: change.path || change.file || change.name || `change-${index + 1}`,
        kind: change.kind || change.type || '',
        diff: change.diff || change.unified_diff || change.content || '',
      };
    });
  }
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([file, change]) => ({
    path: file,
    kind: change && typeof change === 'object' ? change.kind || change.type || '' : '',
    diff: change && typeof change === 'object' ? change.diff || change.unified_diff || change.content || '' : '',
  }));
}

function summarizePatchChanges(changes) {
  const normalized = normalizePatchChanges(changes);
  const rows = normalized.slice(0, 16).map(change => {
    const stats = patchChangeStats(change);
    const statLabel = [
      stats.added > 0 ? `+${stats.added}` : '',
      stats.removed > 0 ? `-${stats.removed}` : '',
    ].filter(Boolean).join(' ');
    return `${change.kind ? `${change.kind} ` : ''}${change.path}${statLabel ? ` ${statLabel}` : ''}`;
  });
  if (normalized.length > 16) rows.push(`... +${normalized.length - 16} files`);
  return rows.join('\n');
}

function diffStats(diff) {
  const text = normalizeText(diff);
  if (!text) return { added: 0, removed: 0 };
  return text.split('\n').reduce((stats, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return stats;
    if (line.startsWith('+')) stats.added += 1;
    else if (line.startsWith('-')) stats.removed += 1;
    return stats;
  }, { added: 0, removed: 0 });
}

function rawContentLineCount(content) {
  const text = normalizeText(content);
  if (!text) return 0;
  return text.split('\n').length;
}

function patchChangeStats(change) {
  const stats = diffStats(change.diff);
  if (stats.added > 0 || stats.removed > 0) return stats;
  const kind = String(change.kind || '').toLowerCase();
  const lines = rawContentLineCount(change.diff);
  if (!lines) return stats;
  if (kind === 'add' || kind === 'added') return { added: lines, removed: 0 };
  if (kind === 'delete' || kind === 'deleted') return { added: 0, removed: lines };
  return stats;
}

function titleForPatch(payload) {
  if (payload.success === false) return 'Patch failed';
  const changes = normalizePatchChanges(payload.changes).length;
  if (changes === 1) return 'Edited 1 file';
  if (changes > 1) return `Edited ${changes} files`;
  return 'Applied patch';
}

function titleForReviewAction(action) {
  if (!action || typeof action !== 'object') return 'approval';
  const type = String(action.type || '').replace(/[_-]/g, '').toLowerCase();
  if (type === 'command') return compactInline(action.command, 'command');
  if (type === 'execve') return compactInline([action.program, ...(Array.isArray(action.argv) ? action.argv : [])].filter(Boolean).join(' '), 'exec');
  if (type === 'applypatch') {
    const files = Array.isArray(action.files) ? action.files : [];
    return files.length ? `patch ${files.slice(0, 3).join(', ')}` : 'patch';
  }
  if (type === 'networkaccess') return compactInline(action.target || action.host, 'network access');
  if (type === 'mcptoolcall') return compactInline([action.server, action.toolName || action.toolTitle].filter(Boolean).join('/'), 'MCP tool');
  if (type === 'requestpermissions') return compactInline(action.reason, 'permission request');
  return compactInline(action.type, 'approval');
}

function detailForReview(payload) {
  const review = payload && typeof payload.review === 'object' ? payload.review : {};
  const action = payload && typeof payload.action === 'object' ? payload.action : {};
  return [
    review.status ? `status: ${review.status}` : '',
    review.riskLevel ? `risk: ${review.riskLevel}` : '',
    review.rationale || '',
    action.cwd ? `cwd: ${action.cwd}` : '',
    payload.decisionSource ? `decision: ${payload.decisionSource}` : '',
  ].filter(Boolean).join('\n');
}

function detailForHook(run) {
  const entries = Array.isArray(run.entries)
    ? run.entries
        .map(entry => {
          if (!entry || typeof entry !== 'object') return '';
          const kind = compactInline(entry.kind || '');
          const text = normalizeText(entry.text);
          return [kind, text].filter(Boolean).join(': ');
        })
        .filter(Boolean)
    : [];
  return [
    run.statusMessage || run.status_message || '',
    run.sourcePath || run.source_path ? `source: ${run.sourcePath || run.source_path}` : '',
    Number.isFinite(run.durationMs) ? `duration: ${run.durationMs}ms` : '',
    Number.isFinite(run.duration_ms) ? `duration: ${run.duration_ms}ms` : '',
    ...entries,
  ].filter(Boolean).join('\n');
}

function statusForHook(run, fallback = 'running') {
  const status = String(run && run.status || '').toLowerCase();
  if (status === 'failed' || status === 'blocked' || status === 'stopped') return 'failed';
  if (status === 'completed') return 'completed';
  return fallback;
}

function titleForMcp(payload) {
  const invocation = payload.invocation && typeof payload.invocation === 'object' ? payload.invocation : {};
  const server = compactInline(invocation.server || payload.server || '');
  const tool = compactInline(invocation.tool || payload.tool || '');
  if (server && tool) return `Used ${server}/${tool}`;
  if (tool) return `Used ${tool}`;
  return 'Used MCP tool';
}

function detailForMcp(payload) {
  const invocation = payload.invocation && typeof payload.invocation === 'object' ? payload.invocation : {};
  const result = payload.result;
  const detail = [];
  if (invocation.arguments) detail.push(JSON.stringify(invocation.arguments, null, 2));
  else if (payload.arguments) detail.push(JSON.stringify(payload.arguments, null, 2));
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) {
      const text = result.content
        .map(part => (part && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
      if (text) detail.push(text);
    }
    if (result.is_error) detail.push('is_error: true');
  }
  return summarizeOutput(detail.join('\n'));
}

function textFromUserInput(content) {
  if (typeof content === 'string') return normalizeText(content);
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'Text' && typeof part.text === 'string') return part.text;
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'mention') return compactInline(part.name || part.path || '');
      if (part.type === 'skill') {
        const name = compactInline(part.name || path.basename(part.path || ''));
        return name ? `$${name}` : '';
      }
      if (typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim();
}

function textFromUserMessagePayload(payload) {
  const direct = normalizeText(payload.message);
  if (direct) return direct;
  const textElements = Array.isArray(payload.text_elements)
    ? payload.text_elements
    : (Array.isArray(payload.textElements) ? payload.textElements : []);
  return textElements
    .map(element => {
      if (typeof element === 'string') return element;
      if (!element || typeof element !== 'object') return '';
      if (typeof element.text === 'string') return element.text;
      if (typeof element.content === 'string') return element.content;
      if (Array.isArray(element.content)) return textFromContent(element.content);
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function turnItemType(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.type || '').trim().replace(/[_-]/g, '').toLowerCase();
}

function itemStatus(item, fallback = '') {
  return item.status || item.statusText || fallback;
}

function responseItemTurnId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const metadata = payload.internal_chat_message_metadata_passthrough || payload.internalChatMessageMetadataPassthrough;
  return payload.turn_id || payload.turnId || (metadata && (metadata.turn_id || metadata.turnId)) || '';
}

function normalizeEventEnvelope(event) {
  if (!event || typeof event !== 'object') return { type: '', payload: null };
  if (typeof event.method === 'string') {
    return {
      type: event.method,
      payload: event.params && typeof event.params === 'object' ? event.params : {},
    };
  }
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  return {
    type: String(event.type || ''),
    payload,
  };
}

function isIgnoredEventType(type) {
  return [
    'token_count',
    'thread_goal_updated',
    'thread_name_updated',
  ].includes(type);
}

function detailForPlanSteps(steps) {
  if (!Array.isArray(steps)) return '';
  return steps
    .map(step => {
      if (!step || typeof step !== 'object') return '';
      const status = String(step.status || '').replace(/[_-]/g, '').toLowerCase();
      const marker = status === 'completed' || step.completed === true
        ? '[x]'
        : status === 'inprogress'
          ? '[>]'
          : '[ ]';
      return `${marker} ${compactInline(step.step || step.text || step.title || '')}`;
    })
    .filter(line => line.trim() !== '[ ]' && line.trim() !== '[x]' && line.trim() !== '[>]')
    .join('\n');
}

function applyUserMessageToTurn(turn, { id = '', message = '', images = [], audios = [] } = {}) {
  if (!turn) return;
  const subagentNotification = parseSubagentNotification(message);
  if (subagentNotification) {
    appendProcess(turn, {
      id: id || `${turn.id}-subagent-notification-${turn.processItems.length + 1}`,
      type: 'subagent',
      title: subagentNotification.title,
      detail: subagentNotification.detail,
      status: subagentNotification.status,
    });
    return;
  }
  const userImages = Array.isArray(images) ? images.filter(Boolean) : [];
  const userAudios = Array.isArray(audios) ? audios.filter(Boolean) : [];
  const pastedTranscript = extractReferencedPastedTranscriptContext(message);
  const approvalTranscript = extractCodexApprovalTranscriptContext(pastedTranscript.text);
  const userFiles = [
    ...pastedTranscript.files,
    ...approvalTranscript.files,
    ...extractComposerFileAttachments(approvalTranscript.text).files,
  ].slice(0, MAX_USER_FILES_PER_TURN);
  const text = visibleUserMessageText(approvalTranscript.text, {
    renderedAttachmentKinds: renderedAttachmentKindsForAttachments({
      images: userImages,
      audios: userAudios,
      files: userFiles,
    }),
  });
  if (!text && userImages.length <= 0 && userAudios.length <= 0 && userFiles.length <= 0) return;

  if (!turn.userMessage) {
    if (text) turn.userMessage = text;
    if (userImages.length) turn.userImages = userImages;
    if (userAudios.length) turn.userAudios = userAudios;
    if (userFiles.length) turn.userFiles = userFiles;
    return;
  }

  if (
    text &&
    turn.userMessage === text &&
    userImages.length === 0 &&
    userAudios.length === 0 &&
    userFiles.length === 0
  ) {
    return;
  }

  appendProcess(turn, {
    id: id || `${turn.id}-user-steer-${turn.processItems.length + 1}`,
    type: 'user-steer',
    title: text || 'User added context',
    detail: text,
    images: userImages,
    audios: userAudios,
    files: userFiles,
    status: 'completed',
  });
}

function appendTurnItem(turn, item, status = '') {
  const type = turnItemType(item);
  if (!type) return false;
  if (type === 'usermessage') {
    const images = imagesFromContent(item.content);
    const audios = audiosFromContent(item.content);
    applyUserMessageToTurn(turn, {
      id: item.id,
      message: textFromUserInput(item.content),
      images,
      audios,
    });
    return true;
  }
  if (type === 'hookprompt') {
    const fragments = Array.isArray(item.fragments) ? item.fragments : [];
    const text = fragments.map(fragment => fragment && fragment.text).filter(Boolean).join('\n\n');
    if (text) appendProcess(turn, { id: item.id, type: 'hook', title: 'Hook prompt', detail: text, status });
    return true;
  }
  if (type === 'agentmessage') {
    const text = Array.isArray(item.content)
      ? item.content.map(part => part && part.text).filter(Boolean).join('\n\n')
      : normalizeText(item.text);
    if (text && (item.phase === 'final_answer' || !item.phase)) {
      turn.finalMessage = finalMessageText(text, turn, item.id, item.memoryCitation || item.memory_citation);
    } else if (text) {
      const extracted = extractMemoryCitationBlock(text);
      appendMemoryCitation(turn, item.id, item.memoryCitation || item.memory_citation, extracted.detail);
      if (extracted.text) appendProcess(turn, { id: item.id, type: 'message', title: extracted.text.split('\n')[0], detail: extracted.text });
    }
    return true;
  }
  if (type === 'plan') {
    appendProcess(turn, { id: item.id, type: 'plan', title: 'Updated plan', detail: item.text, status });
    return true;
  }
  if (type === 'todolist') {
    const detail = detailForPlanSteps(Array.isArray(item.items) ? item.items : []);
    appendProcess(turn, { id: item.id, type: 'plan', title: 'Updated todos', detail, status });
    return true;
  }
  if (type === 'reasoning') {
    const text = [
      item.text,
      ...(Array.isArray(item.summary_text) ? item.summary_text : []),
      ...(Array.isArray(item.summary) ? item.summary : []),
      ...(Array.isArray(item.content) ? item.content : []),
    ].map(textFromContent).filter(Boolean).join('\n');
    if (text) appendProcess(turn, { id: item.id, type: 'reasoning', title: 'Reasoned', detail: text, status });
    return true;
  }
  if (type === 'commandexecution') {
    appendProcess(turn, {
      id: item.id,
      type: 'command',
      title: titleForCommandExecution(item),
      detail: summarizeCommandOutput(item),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'filechange') {
    appendProcess(turn, {
      id: item.id,
      type: 'patch',
      title: titleForPatch(item),
      detail: summarizePatchChanges(item.changes),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'mcptoolcall') {
    appendProcess(turn, {
      id: item.id,
      type: 'mcp',
      title: titleForMcp(item),
      detail: detailForMcp(item),
      images: imagesFromStructuredOutput(item.result),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'dynamictoolcall') {
    const name = [item.namespace, item.tool].filter(Boolean).join('/');
    appendProcess(turn, {
      id: item.id,
      type: 'tool',
      title: name ? `Used ${name}` : 'Used tool',
      detail: summarizeOutput(JSON.stringify(item.arguments || item.content_items || item.contentItems || '', null, 2)),
      images: imagesFromStructuredOutput(item.content_items || item.contentItems),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'collabagenttoolcall') {
    const tool = compactInline(item.tool, 'agent tool');
    const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : item.receiverThreadIds;
    appendProcess(turn, {
      id: item.id,
      type: 'agent-tool',
      title: `Agent ${tool}`,
      detail: summarizeOutput([item.prompt, Array.isArray(receivers) && receivers.length ? `receivers: ${receivers.join(', ')}` : ''].filter(Boolean).join('\n')),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'subagentactivity') {
    const kind = compactInline(item.kind, 'activity');
    const agentPath = compactInline(item.agent_path || item.agentPath || item.agent_thread_id || item.agentThreadId);
    appendProcess(turn, {
      id: item.id,
      type: 'sub-agent',
      title: agentPath ? `${kind} ${agentPath}` : `Sub-agent ${kind}`,
      status,
    });
    return true;
  }
  if (type === 'websearch') {
    appendProcess(turn, { id: item.id, type: 'web-search', title: compactInline(item.query, 'Searched web'), status });
    return true;
  }
  if (type === 'imageview') {
    appendProcess(turn, {
      id: item.id,
      type: 'image',
      title: compactInline(item.path, 'Viewed image'),
      images: imagesFromImageItem(item),
      status,
    });
    return true;
  }
  if (type === 'sleep') {
    const duration = item.duration_ms || item.durationMs;
    appendProcess(turn, {
      id: item.id,
      type: 'sleep',
      title: duration ? `Slept for ${Math.round(duration / 1000)}s` : 'Slept',
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'imagegeneration') {
    const detail = [
      item.saved_path || item.savedPath,
      item.revised_prompt || item.revisedPrompt,
      item.status,
    ].map(value => compactInline(value)).filter(Boolean).join('\n');
    appendProcess(turn, {
      id: item.id,
      type: 'image-generation',
      title: 'Generated image',
      detail,
      images: imagesFromImageItem(item),
      status: status || itemStatus(item),
    });
    return true;
  }
  if (type === 'enteredreviewmode' || type === 'exitedreviewmode') {
    appendProcess(turn, {
      id: item.id,
      type: 'review',
      title: type === 'enteredreviewmode' ? 'Entered review mode' : 'Exited review mode',
      detail: item.review || '',
      status,
    });
    return true;
  }
  if (type === 'contextcompaction') {
    appendProcess(turn, { id: item.id, type: 'compaction', title: 'Compacted context', status });
    return true;
  }
  if (type === 'error') {
    appendProcess(turn, {
      id: item.id,
      type: 'error',
      title: compactInline(item.message, 'Error'),
      detail: item.detail || item.error || '',
      status: itemStatus(item, 'failed'),
    });
    return true;
  }
  appendProcess(turn, {
    id: item.id,
    type: 'event',
    title: humanizeType(item.type, 'Codex event'),
    detail: summarizeOutput(JSON.stringify(item, null, 2)),
    status: status || itemStatus(item),
  });
  return true;
}

function appendResponseItem(turn, payload, functionCalls) {
  if (!turn || !payload || typeof payload !== 'object') return false;
  if (payload.type === 'message') {
    const text = textFromContent(payload.content);
    const images = imagesFromContent(payload.content);
    if (!text && images.length <= 0) return true;
    if (payload.role === 'user') {
      applyUserMessageToTurn(turn, {
        id: payload.id,
        message: text,
        images,
      });
    } else if (payload.role === 'assistant' && text && (payload.phase === 'final_answer' || (!payload.phase && !turn.finalMessage))) {
      turn.finalMessage = finalMessageText(text, turn, payload.id, payload.memoryCitation || payload.memory_citation);
    } else if (payload.role === 'assistant' && text) {
      const extracted = extractMemoryCitationBlock(text);
      appendMemoryCitation(turn, payload.id, payload.memoryCitation || payload.memory_citation, extracted.detail);
      appendProcess(turn, {
        id: payload.id,
        type: 'message',
        title: (extracted.text || text).split('\n')[0],
        detail: extracted.text || text,
      });
    }
    return true;
  }

  if (payload.type === 'agent_message') {
    const text = textFromContent(payload.content);
    appendProcess(turn, {
      id: payload.id,
      type: 'agent-message',
      title: [payload.author, payload.recipient].filter(Boolean).join(' -> ') || 'Agent message',
      detail: text,
    });
    return true;
  }

  if (payload.type === 'reasoning') {
    const summary = [
      ...(Array.isArray(payload.summary) ? payload.summary.map(textFromContent) : []),
      ...(Array.isArray(payload.content) ? payload.content.map(textFromContent) : []),
    ].filter(Boolean).join('\n');
    if (summary) {
      appendProcess(turn, {
        id: payload.id,
        type: 'reasoning',
        title: 'Reasoned',
        detail: summary,
      });
    }
    return true;
  }

  if (payload.type === 'additional_tools') {
    const count = Array.isArray(payload.tools) ? payload.tools.length : 0;
    appendProcess(turn, {
      id: payload.id,
      type: 'tool',
      title: count ? `Added ${count} tools` : 'Added tools',
      detail: summarizeOutput(JSON.stringify(payload.tools || '', null, 2)),
      status: 'completed',
    });
    return true;
  }

  if (payload.type === 'local_shell_call') {
    appendProcess(turn, {
      id: payload.call_id || payload.id,
      type: 'command',
      title: titleForLocalShell(payload),
      detail: detailForLocalShell(payload),
      status: payload.status || 'completed',
    });
    return true;
  }

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const title = processTitleForFunctionCall(payload);
    const processType = processTypeForFunctionCall(payload);
    const callId = payload.call_id || payload.id || '';
    if (callId) functionCalls.set(callId, { title, type: processType });
    appendProcess(turn, {
      id: callId || payload.id,
      type: processType,
      title,
      detail: detailForFunctionCall(payload),
      status: 'running',
    });
    return true;
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const callId = payload.call_id || '';
    const callMeta = functionCalls.get(callId);
    appendProcess(turn, {
      id: callId || payload.id,
      type: callMeta?.type || 'tool-output',
      title: callMeta?.title || 'Tool output',
      detail: summarizeStructuredOutput(payload.output),
      images: imagesFromStructuredOutput(payload.output),
      mergeDetail: true,
      status: 'completed',
    });
    return true;
  }

  if (payload.type === 'web_search_call') {
    appendProcess(turn, {
      id: payload.id,
      type: 'web-search',
      title: compactInline(payload.action && payload.action.query, 'Searched web'),
      detail: payload.action ? summarizeOutput(JSON.stringify(payload.action, null, 2)) : '',
      status: payload.status || 'completed',
    });
    return true;
  }

  if (payload.type === 'tool_search_call' || payload.type === 'tool_search_output') {
    const callId = payload.call_id || payload.id || '';
    appendProcess(turn, {
      id: callId,
      type: 'tool',
      title: 'Searched tools',
      detail: summarizeOutput(JSON.stringify(payload.arguments || payload.tools || '', null, 2)),
      status: payload.type === 'tool_search_call' ? (payload.status || 'running') : (payload.status || 'completed'),
    });
    return true;
  }

  if (payload.type === 'image_generation_call') {
    appendProcess(turn, {
      id: payload.id,
      type: 'image-generation',
      title: 'Generated image',
      detail: compactInline(payload.revised_prompt || payload.status || ''),
      images: imagesFromImageItem(payload),
      status: payload.status || 'running',
    });
    return true;
  }

  if (
    payload.type === 'compaction' ||
    payload.type === 'compaction_summary' ||
    payload.type === 'compaction_trigger' ||
    payload.type === 'context_compaction'
  ) {
    appendProcess(turn, {
      id: payload.id,
      type: 'compaction',
      title: payload.type === 'compaction_trigger' ? 'Compaction triggered' : 'Compacted context',
      detail: compactInline(payload.encrypted_content || payload.status || ''),
      status: payload.status || 'completed',
    });
    return true;
  }

  appendProcess(turn, {
    id: payload.id || payload.call_id,
    type: 'event',
    title: humanizeType(payload.type, 'Codex response item'),
    detail: summarizeOutput(JSON.stringify(payload, null, 2)),
    status: payload.status || '',
  });
  return true;
}

function newTurn(id = '') {
  return {
    id: id || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userMessage: '',
    userImages: [],
    userAudios: [],
    userFiles: [],
    finalMessage: '',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    status: 'inProgress',
    model: '',
    effort: '',
    cwd: '',
    processItems: [],
  };
}

function isEmptyTurn(turn) {
  return !turn.userMessage &&
    (!Array.isArray(turn.userImages) || turn.userImages.length === 0) &&
    (!Array.isArray(turn.userAudios) || turn.userAudios.length === 0) &&
    (!Array.isArray(turn.userFiles) || turn.userFiles.length === 0) &&
    !turn.finalMessage &&
    turn.processItems.length === 0;
}

function hasRunningProcessItems(turn) {
  return turn.processItems.some(item => {
    const status = String(item.status || '').replace(/[_-]/g, '').toLowerCase();
    return status === 'running' || status === 'inprogress' || status === 'pending';
  });
}

function isStandaloneThreadSettingsTurn(turn) {
  if (!turn || turn.status !== 'inProgress' || turn.userMessage || turn.finalMessage) return false;
  const items = Array.isArray(turn.processItems) ? turn.processItems : [];
  return items.length > 0 && items.every(item => (
    item && item.type === 'event' && item.title === 'Thread Settings Applied'
  ));
}

function processItemIdentity(item) {
  return [
    String(item?.type || ''),
    String(item?.title || '').trim(),
    String(item?.detail || '').trim(),
    String(item?.status || '').trim(),
  ].join('\u0000');
}

function dedupeAdjacentProcessItems(items) {
  const deduped = [];
  let previousKey = '';
  for (const item of items || []) {
    const key = processItemIdentity(item);
    if (key && key === previousKey) continue;
    deduped.push(item);
    previousKey = key;
  }
  return deduped;
}

function sanitizeProcessItemForOutput(item) {
  if (!item || typeof item !== 'object') return null;
  const title = stripCodexInternalContextBlocks(item.title);
  const detail = stripCodexInternalContextBlocks(item.detail);
  if (
    !title
    && !detail
    && (!Array.isArray(item.images) || item.images.length <= 0)
    && (!Array.isArray(item.audios) || item.audios.length <= 0)
    && (!Array.isArray(item.files) || item.files.length <= 0)
  ) {
    return null;
  }
  return {
    ...item,
    title: title || item.title,
    detail,
  };
}

function normalizeTurnForOutput(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  turn.userMessage = visibleUserMessageText(turn.userMessage, {
    renderedAttachmentKinds: renderedAttachmentKindsForTurn(turn),
  });
  turn.finalMessage = stripCodexInternalContextBlocks(turn.finalMessage);
  turn.processItems = dedupeAdjacentProcessItems(turn.processItems)
    .map(sanitizeProcessItemForOutput)
    .filter(Boolean);
  if (turn.status === 'inProgress' && turn.finalMessage && !hasRunningProcessItems(turn)) {
    turn.status = 'completed';
  }
  return turn;
}

function completeTurn(turn, payload = {}) {
  if (!turn) return;
  turn.status = payload.type === 'turn_aborted' || payload.type === 'task_aborted' ? 'interrupted' : 'completed';
  if (typeof payload.completed_at === 'number') turn.completedAt = payload.completed_at;
  if (typeof payload.completedAt === 'number') turn.completedAt = payload.completedAt;
  if (payload.turn && typeof payload.turn === 'object' && typeof payload.turn.completedAt === 'number') {
    turn.completedAt = payload.turn.completedAt;
  }
  if (typeof payload.duration_ms === 'number') turn.durationMs = payload.duration_ms;
  if (typeof payload.durationMs === 'number') turn.durationMs = payload.durationMs;
  if (payload.turn && typeof payload.turn === 'object' && typeof payload.turn.durationMs === 'number') {
    turn.durationMs = payload.turn.durationMs;
  }
  if (!turn.finalMessage && typeof payload.last_agent_message === 'string') {
    turn.finalMessage = finalMessageText(payload.last_agent_message, turn, `${turn.id}-last-agent-message`);
  }
}

function appendTurnSnapshot(turns, turn) {
  if (!turn || typeof turn !== 'object') return false;
  const normalizedTurn = newTurn(turn.id);
  normalizedTurn.status = turn.status || normalizedTurn.status;
  normalizedTurn.startedAt = typeof turn.startedAt === 'number' ? turn.startedAt : null;
  normalizedTurn.completedAt = typeof turn.completedAt === 'number' ? turn.completedAt : null;
  normalizedTurn.durationMs = typeof turn.durationMs === 'number' ? turn.durationMs : null;
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) {
      appendTurnItem(normalizedTurn, item, itemStatus(item, normalizedTurn.status));
    }
  }
  if (turn.error) {
    appendTurnItem(normalizedTurn, { type: 'error', id: `${normalizedTurn.id}-error`, ...turn.error }, 'failed');
  }
  if (!isEmptyTurn(normalizedTurn)) turns.push(normalizedTurn);
  return true;
}

function appendProcess(turn, item) {
  if (!turn || !item || !item.title) return;
  const id = item.id || `${turn.id}-process-${turn.processItems.length + 1}`;
  const detail = normalizeText(item.detail);
  const files = Array.isArray(item.files) ? item.files.slice(0, MAX_USER_FILES_PER_TURN) : [];
  const next = {
    id,
    type: item.type || 'event',
    title: normalizeText(item.title).slice(0, 240),
    detail: detail.slice(0, 4000),
    images: Array.isArray(item.images) ? item.images.slice(0, MAX_USER_IMAGES_PER_TURN) : [],
    files,
    status: item.status || '',
  };
  const existing = turn.processItems.find(entry => entry.id === id);
  if (existing) {
    existing.type = next.type || existing.type;
    if (!item.mergeDetail) existing.title = next.title || existing.title;
    if (item.mergeDetail && existing.detail && next.detail && existing.detail !== next.detail) {
      existing.detail = `${existing.detail}\n\n${next.detail}`.slice(0, 4000);
    } else {
      existing.detail = next.detail || existing.detail;
    }
    if (next.images.length) {
      const urls = new Set((existing.images || []).map(image => image.url));
      existing.images = [
        ...(existing.images || []),
        ...next.images.filter(image => image && image.url && !urls.has(image.url)),
      ].slice(0, MAX_USER_IMAGES_PER_TURN);
    }
    if (next.files.length) {
      const keys = new Set((existing.files || []).map(file => `${file.name}\0${file.content}\0${file.error}`));
      existing.files = [
        ...(existing.files || []),
        ...next.files.filter(file => file && !keys.has(`${file.name}\0${file.content}\0${file.error}`)),
      ].slice(0, MAX_USER_FILES_PER_TURN);
    }
    existing.status = next.status || existing.status;
    return;
  }
  turn.processItems.push(next);
}

function appendProcessDelta(turn, item) {
  if (!turn || !item || !item.title) return;
  const id = item.id || `${turn.id}-process-${turn.processItems.length + 1}`;
  const delta = normalizeDeltaText(item.delta);
  const existing = turn.processItems.find(entry => entry.id === id);
  if (existing) {
    existing.type = item.type || existing.type;
    existing.title = item.title || existing.title;
    if (delta) existing.detail = `${existing.detail || ''}${delta}`.slice(0, 4000);
    existing.status = item.status || existing.status;
    return;
  }
  turn.processItems.push({
    id,
    type: item.type || 'event',
    title: normalizeText(item.title).slice(0, 240),
    detail: delta.slice(0, 4000),
    images: [],
    files: [],
    status: item.status || '',
  });
}

function buildTranscriptFromLines(lines, options = {}) {
  const turns = [];
  let active = null;
  const functionCalls = new Map();

  // `thread/read` is a full snapshot, but Codex can continue emitting live
  // events for the same in-progress turn after that snapshot. Reuse the
  // snapshot turn instead of creating a second visual turn for the stream.
  const resumeSnapshotTurn = (id) => {
    if (!id) return null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index] && turns[index].id === id && turns[index].status === 'inProgress') {
        return turns.splice(index, 1)[0] || null;
      }
    }
    return null;
  };

  const ensureActive = (id = '') => {
    if (active && (!id || active.id === id)) return active;
    if (active && !isEmptyTurn(active)) turns.push(active);
    active = resumeSnapshotTurn(id) || newTurn(id);
    return active;
  };

  const finishActive = (payload = {}) => {
    if (!active) return;
    completeTurn(active, payload);
    if (!isEmptyTurn(active)) turns.push(active);
    active = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const { type: eventType, payload } = normalizeEventEnvelope(event);
    if (!payload) continue;

    if (eventType === 'turn_context') {
      const turn = ensureActive(payload.turn_id);
      turn.cwd = typeof payload.cwd === 'string' ? payload.cwd : turn.cwd;
      turn.model = typeof payload.model === 'string' ? payload.model : turn.model;
      turn.effort = typeof payload.effort === 'string' ? payload.effort : turn.effort;
      continue;
    }

    if (eventType === 'compacted') {
      appendProcess(ensureActive(), {
        type: 'compaction',
        title: 'Compacted context',
        detail: payload.message || '',
      });
      continue;
    }

    if (eventType === 'thread/read' && payload.thread && Array.isArray(payload.thread.turns)) {
      if (active && !isEmptyTurn(active)) turns.push(active);
      active = null;
      // A later thread/read replaces the previous snapshot; retaining both
      // makes the same historical session appear twice in the chat.
      turns.length = 0;
      for (const turn of payload.thread.turns) appendTurnSnapshot(turns, turn);
      continue;
    }

    if (eventType === 'thread/items/list' && Array.isArray(payload.data)) {
      if (active && !isEmptyTurn(active)) turns.push(active);
      active = newTurn(payload.turnId || payload.turn_id || 'thread-items-list');
      active.status = 'completed';
      for (const item of payload.data) {
        appendTurnItem(active, item, itemStatus(item, active.status));
      }
      if (!isEmptyTurn(active)) turns.push(active);
      active = null;
      continue;
    }

    if (eventType === 'turn' || eventType === 'turn/snapshot') {
      if (appendTurnSnapshot(turns, payload.turn || payload)) continue;
    }

    if (eventType === 'turn.started' || eventType === 'turn_started' || eventType === 'turn/started') {
      const turn = ensureActive(payload.turn_id || payload.turnId || payload.turn?.id);
      turn.status = 'inProgress';
      if (payload.turn && typeof payload.turn === 'object') {
        if (typeof payload.turn.startedAt === 'number') turn.startedAt = payload.turn.startedAt;
        if (typeof payload.turn.status === 'string') turn.status = payload.turn.status;
      }
      if (typeof payload.startedAtMs === 'number') turn.startedAt = payload.startedAtMs;
      continue;
    }

    if (
      eventType === 'item.started' ||
      eventType === 'item.updated' ||
      eventType === 'item.completed' ||
      eventType === 'item/started' ||
      eventType === 'item/updated' ||
      eventType === 'item/completed'
    ) {
      const status = eventType === 'item.started' || eventType === 'item/started'
        ? 'running'
        : eventType === 'item.updated' || eventType === 'item/updated'
          ? itemStatus(payload.item, 'running')
          : itemStatus(payload.item, 'completed');
      if (appendTurnItem(ensureActive(payload.turn_id || payload.turnId), payload.item, status)) continue;
    }

    if (eventType === 'turn.completed' || eventType === 'turn_complete' || eventType === 'turn/completed') {
      if (payload.turn && Array.isArray(payload.turn.items)) {
        const turn = ensureActive(payload.turn.id);
        for (const item of payload.turn.items) {
          appendTurnItem(turn, item, itemStatus(item, payload.turn.status || 'completed'));
        }
      }
      finishActive({
        ...payload,
        type: 'turn_complete',
        turn_id: payload.turn_id || payload.turnId || payload.turn?.id,
        duration_ms: payload.duration_ms || payload.durationMs || payload.turn?.durationMs,
      });
      continue;
    }

    if (eventType === 'turn/plan/updated') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.id || `${payload.turnId || payload.turn_id || 'turn'}-plan`,
        type: 'plan',
        title: 'Updated plan',
        detail: detailForPlanSteps(payload.plan),
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'item/agentMessage/delta') {
      const turn = ensureActive(payload.turn_id || payload.turnId);
      const delta = normalizeDeltaText(payload.delta);
      if (delta) {
        turn.finalMessage = `${turn.finalMessage || ''}${delta}`;
      }
      continue;
    }

    if (eventType === 'item/plan/delta') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'plan',
        title: 'Updated plan',
        delta: payload.delta,
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/reasoning/summaryTextDelta' || eventType === 'item/reasoning/textDelta') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'reasoning',
        title: 'Reasoned',
        delta: payload.delta,
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/reasoning/summaryPartAdded') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'reasoning',
        title: 'Reasoned',
        delta: '\n',
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/commandExecution/outputDelta') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'command',
        title: 'Ran command',
        delta: payload.delta,
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/fileChange/outputDelta') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'patch',
        title: 'Applied patch',
        delta: payload.delta,
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/fileChange/patchUpdated') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'patch',
        title: titleForPatch(payload),
        detail: summarizePatchChanges(payload.changes),
        status: 'running',
      });
      continue;
    }

    if (eventType === 'turn/diff/updated') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-diff`,
        type: 'patch',
        title: 'Updated diff',
        detail: summarizeOutput(payload.diff),
        status: 'running',
      });
      continue;
    }

    if (eventType === 'item/autoApprovalReview/started' || eventType === 'item/autoApprovalReview/completed') {
      const completed = eventType.endsWith('/completed');
      const actionTitle = titleForReviewAction(payload.action);
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.reviewId || payload.review_id || payload.targetItemId || payload.target_item_id,
        type: 'review',
        title: completed ? `Reviewed ${actionTitle}` : `Reviewing ${actionTitle}`,
        detail: detailForReview(payload),
        status: completed ? 'completed' : 'running',
      });
      continue;
    }

    if (eventType === 'item/commandExecution/terminalInteraction') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'command',
        title: 'Interacted with terminal',
        detail: normalizeText(payload.stdin),
        status: 'running',
        mergeDetail: true,
      });
      continue;
    }

    if (eventType === 'item/mcpToolCall/progress') {
      appendProcessDelta(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.item_id || payload.itemId,
        type: 'mcp',
        title: 'MCP progress',
        delta: payload.message ? `${payload.message}\n` : '',
        status: 'running',
      });
      continue;
    }

    if (eventType === 'hook/started' || eventType === 'hook/completed') {
      const run = payload.run && typeof payload.run === 'object' ? payload.run : {};
      const completed = eventType.endsWith('/completed');
      const eventName = run.eventName || run.event_name;
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: run.id || `${payload.turnId || payload.turn_id || 'turn'}-hook`,
        type: 'hook',
        title: completed
          ? `Completed ${compactInline(eventName, 'hook')}`
          : `Running ${compactInline(eventName, 'hook')}`,
        detail: detailForHook(run),
        status: statusForHook(run, completed ? 'completed' : 'running'),
      });
      continue;
    }

    if (eventType === 'serverRequest/resolved') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: payload.requestId || payload.request_id,
        type: 'event',
        title: 'Resolved server request',
        detail: payload.requestId || payload.request_id || '',
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'thread/compacted') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-compacted`,
        type: 'compaction',
        title: 'Compacted context',
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'model/rerouted') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-model-rerouted`,
        type: 'event',
        title: `Rerouted ${compactInline(payload.fromModel || payload.from_model, 'model')} to ${compactInline(payload.toModel || payload.to_model, 'model')}`,
        detail: compactInline(payload.reason),
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'model/verification') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-model-verification`,
        type: 'event',
        title: 'Verified model',
        detail: summarizeOutput(JSON.stringify(payload.verifications || [], null, 2)),
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'model/safetyBuffering/updated') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-safety-buffering`,
        type: 'warning',
        title: payload.showBufferingUi === false ? 'Safety buffering hidden' : 'Safety buffering',
        detail: [
          payload.model ? `model: ${payload.model}` : '',
          Array.isArray(payload.useCases) && payload.useCases.length ? `use cases: ${payload.useCases.join(', ')}` : '',
          Array.isArray(payload.reasons) && payload.reasons.length ? `reasons: ${payload.reasons.join(', ')}` : '',
          payload.fasterModel ? `faster model: ${payload.fasterModel}` : '',
        ].filter(Boolean).join('\n'),
        status: payload.showBufferingUi === false ? 'completed' : 'warning',
      });
      continue;
    }

    if (eventType === 'turn/moderationMetadata') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        id: `${payload.turnId || payload.turn_id || 'turn'}-moderation`,
        type: 'event',
        title: 'Updated moderation metadata',
        detail: summarizeOutput(JSON.stringify(payload.metadata || {}, null, 2)),
        status: 'completed',
      });
      continue;
    }

    if (eventType === 'rawResponseItem/completed') {
      const turn = ensureActive(payload.turn_id || payload.turnId);
      if (appendResponseItem(turn, payload.item, functionCalls)) continue;
    }

    if (eventType === 'turn.failed' || eventType === 'error') {
      const turn = ensureActive(payload.turn_id || payload.turnId);
      const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
      appendProcess(turn, {
        type: 'error',
        title: compactInline(error.message || error.code, 'Error'),
        detail: error.detail || error.error || '',
        status: 'failed',
      });
      finishActive({
        ...payload,
        type: 'turn_aborted',
      });
      continue;
    }

    if (eventType === 'warning' || eventType === 'guardianWarning' || eventType === 'configWarning' || eventType === 'deprecationNotice') {
      const message = payload.message || payload.summary || payload.title || 'Warning';
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        type: 'warning',
        title: compactInline(message, 'Warning'),
        detail: payload.details || payload.path || '',
        status: 'warning',
      });
      continue;
    }

    if (eventType === 'windows/worldWritableWarning') {
      const paths = Array.isArray(payload.samplePaths) ? payload.samplePaths : [];
      appendProcess(ensureActive(payload.turn_id || payload.turnId), {
        type: 'warning',
        title: 'World-writable paths detected',
        detail: paths.concat(payload.extraCount ? [`... +${payload.extraCount} more`] : []).join('\n'),
        status: 'warning',
      });
      continue;
    }

    if (eventType === 'thread/realtime/transcript/delta' || eventType === 'thread/realtime/transcript/done') {
      const turn = ensureActive(payload.turn_id || payload.turnId || `${payload.threadId || payload.thread_id || 'realtime'}-realtime`);
      const text = eventType.endsWith('/done') ? normalizeText(payload.text) : normalizeDeltaText(payload.delta);
      const role = String(payload.role || '').toLowerCase();
      if (role === 'user') {
        const nextMessage = eventType.endsWith('/done') ? text : `${turn.userMessage || ''}${text}`;
        turn.userMessage = visibleUserMessageText(nextMessage, {
          renderedAttachmentKinds: renderedAttachmentKindsForTurn(turn),
        });
      } else if (text) {
        turn.finalMessage = eventType.endsWith('/done') ? text : `${turn.finalMessage || ''}${text}`;
      }
      continue;
    }

    if (eventType === 'thread/realtime/itemAdded') {
      const turn = ensureActive(payload.turn_id || payload.turnId || `${payload.threadId || payload.thread_id || 'realtime'}-realtime`);
      if (appendTurnItem(turn, payload.item, itemStatus(payload.item, 'completed'))) continue;
      if (appendResponseItem(turn, payload.item, functionCalls)) continue;
    }

    if (eventType === 'thread/realtime/error') {
      appendProcess(ensureActive(payload.turn_id || payload.turnId || `${payload.threadId || payload.thread_id || 'realtime'}-realtime`), {
        type: 'error',
        title: 'Realtime error',
        detail: payload.message || JSON.stringify(payload),
        status: 'failed',
      });
      continue;
    }

    if (eventType === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        const turn = ensureActive(payload.turn_id);
        if (typeof payload.started_at === 'number') turn.startedAt = payload.started_at;
        turn.status = 'inProgress';
        continue;
      }

      if (payload.type === 'user_message') {
        if (active && active.userMessage && (active.finalMessage || active.status !== 'inProgress')) {
          finishActive();
        }
        const turn = ensureActive(payload.turn_id);
        const images = imagesFromUserMessagePayload(payload);
        applyUserMessageToTurn(turn, {
          id: payload.id || payload.call_id,
          message: textFromUserMessagePayload(payload),
          images,
        });
        continue;
      }

      if (payload.type === 'agent_message') {
        const message = normalizeText(payload.message);
        if (!message) continue;
        const turn = ensureActive(payload.turn_id);
        if (payload.phase === 'final_answer' || !payload.phase) {
          turn.finalMessage = finalMessageText(message, turn, payload.id || payload.call_id || `${turn.id}-agent-message`, payload.memoryCitation || payload.memory_citation);
        } else {
          const extracted = extractMemoryCitationBlock(message);
          appendMemoryCitation(turn, payload.id || payload.call_id || `${turn.id}-agent-message`, payload.memoryCitation || payload.memory_citation, extracted.detail);
          appendProcess(turn, {
            type: 'message',
            title: (extracted.text || message).split('\n')[0],
            detail: extracted.text || message,
          });
        }
        continue;
      }

      if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content') {
        const text = normalizeText(payload.text || payload.message);
        if (text) {
          appendProcess(ensureActive(payload.turn_id), {
            type: 'reasoning',
            title: 'Reasoned',
            detail: text,
          });
        }
        continue;
      }

      if (payload.type === 'item_completed' || payload.type === 'item_started' || payload.type === 'item_updated') {
        const turn = ensureActive(payload.turn_id);
        const status = payload.type === 'item_started'
          ? 'running'
          : payload.type === 'item_updated'
            ? itemStatus(payload.item, 'running')
            : itemStatus(payload.item, 'completed');
        if (appendTurnItem(turn, payload.item, status)) continue;
      }

      if (payload.type === 'plan_update') {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id || payload.id || 'plan-update',
          type: 'plan',
          title: 'Updated plan',
          detail: [
            normalizeText(payload.explanation || ''),
            detailForPlanSteps(payload.plan),
          ].filter(Boolean).join('\n'),
          status: 'completed',
        });
        continue;
      }

      if (payload.type === 'raw_response_item') {
        const turn = ensureActive(payload.turn_id);
        if (appendResponseItem(turn, payload.item, functionCalls)) continue;
      }

      if (payload.type === 'patch_apply_end') {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id,
          type: 'patch',
          title: titleForPatch(payload),
          detail: [summarizePatchChanges(payload.changes), summarizeOutput([payload.stdout, payload.stderr].filter(Boolean).join('\n'))]
            .filter(Boolean)
            .join('\n'),
          status: payload.success === false ? 'failed' : 'completed',
        });
        continue;
      }

      if (payload.type === 'exec_command_end') {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id || payload.process_id,
          type: 'command',
          title: titleForCommandExecution(payload),
          detail: summarizeCommandOutput(payload),
          status: Number.isFinite(payload.exit_code) && payload.exit_code !== 0 ? 'failed' : 'completed',
        });
        continue;
      }

      if (payload.type === 'mcp_tool_call_end') {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id,
          type: 'mcp',
          title: titleForMcp(payload),
          detail: detailForMcp(payload),
          images: imagesFromStructuredOutput(payload.result),
          status: payload.result && payload.result.is_error ? 'failed' : 'completed',
        });
        continue;
      }

      if (payload.type === 'web_search_end') {
        const query = payload.query || (payload.action && payload.action.query);
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id,
          type: 'web-search',
          title: compactInline(query, 'Searched web'),
          detail: payload.action ? summarizeOutput(JSON.stringify(payload.action, null, 2)) : '',
          status: 'completed',
        });
        continue;
      }

      if (payload.type === 'image_generation_end') {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.call_id,
          type: 'image-generation',
          title: 'Generated image',
          detail: compactInline(payload.saved_path || payload.revised_prompt || payload.status || ''),
          images: imagesFromImageItem(payload),
          status: payload.status || 'completed',
        });
        continue;
      }

      if (payload.type === 'dynamic_tool_call_request' || payload.type === 'dynamic_tool_call_response') {
        appendProcess(ensureActive(payload.turn_id || payload.turnId), {
          id: payload.call_id || payload.callId,
          type: 'tool',
          title: payload.tool ? `Used ${payload.tool}` : 'Used tool',
          detail: summarizeOutput(JSON.stringify(payload.arguments || payload.content_items || payload.contentItems || '', null, 2)),
          images: imagesFromStructuredOutput(payload.content_items || payload.contentItems),
          mergeDetail: payload.type === 'dynamic_tool_call_response',
          status: payload.type === 'dynamic_tool_call_request' ? 'running' : (payload.success === false ? 'failed' : 'completed'),
        });
        continue;
      }

      if (payload.type === 'sub_agent_activity') {
        const kind = compactInline(payload.kind, 'activity');
        const agentPath = compactInline(payload.agent_path || payload.agentPath || payload.agent_thread_id || payload.agentThreadId);
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.id || payload.call_id,
          type: 'sub-agent',
          title: agentPath ? `${kind} ${agentPath}` : `Sub-agent ${kind}`,
          status: 'completed',
        });
        continue;
      }

      if (payload.type === 'entered_review_mode' || payload.type === 'exited_review_mode') {
        appendProcess(ensureActive(payload.turn_id), {
          type: 'review',
          title: payload.type === 'entered_review_mode' ? 'Entered review mode' : 'Exited review mode',
          detail: summarizeOutput(payload.user_facing_hint || JSON.stringify(payload.review_output || payload.target || '', null, 2)),
        });
        continue;
      }

      if (payload.type === 'error' || payload.type === 'warning' || payload.type === 'guardian_warning' || payload.type === 'stream_error') {
        appendProcess(ensureActive(payload.turn_id), {
          type: payload.type === 'error' ? 'error' : 'warning',
          title: payload.type === 'error' ? 'Error' : 'Warning',
          detail: payload.message || payload.error || JSON.stringify(payload),
          status: payload.type === 'error' ? 'failed' : 'warning',
        });
        continue;
      }

      if (payload.type === 'task_complete' || payload.type === 'turn_complete' || payload.type === 'task_aborted' || payload.type === 'turn_aborted') {
        finishActive(payload);
        continue;
      }

      if (payload.type === 'context_compacted') {
        appendProcess(ensureActive(payload.turn_id), {
          type: 'compaction',
          title: 'Compacted context',
        });
        continue;
      }

      if (payload.type === 'thread_rolled_back') {
        appendProcess(ensureActive(payload.turn_id), {
          type: 'rollback',
          title: 'Rolled back thread',
          detail: payload.message || payload.rollback_to_item_id || '',
        });
        continue;
      }

      if (!isIgnoredEventType(payload.type)) {
        appendProcess(ensureActive(payload.turn_id), {
          id: payload.id || payload.call_id,
          type: 'event',
          title: humanizeType(payload.type, 'Codex event'),
          detail: summarizeOutput(JSON.stringify(payload, null, 2)),
          status: payload.status || '',
        });
      }
    }

    if (eventType === 'response_item') {
      const turn = ensureActive(responseItemTurnId(payload));
      if (appendResponseItem(turn, payload, functionCalls)) continue;
    }
  }

  if (active && !isEmptyTurn(active)) turns.push(active);

  const maxTurns = Number.isFinite(options.maxTurns) ? Math.max(1, Math.floor(options.maxTurns)) : DEFAULT_MAX_TURNS;
  return turns
    .map(normalizeTurnForOutput)
    .filter(turn => turn && !isEmptyTurn(turn) && !isStandaloneThreadSettingsTurn(turn))
    .slice(-maxTurns);
}

async function readTailLines(filePath, maxReadBytes = DEFAULT_MAX_READ_BYTES) {
  const stat = await fsp.stat(filePath);
  const start = Math.max(0, stat.size - maxReadBytes);
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const result = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return {
      truncated: start > 0,
      lines: text.split('\n'),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function isUserMessageLine(line) {
  if (!line.trim()) return false;
  try {
    const event = JSON.parse(line);
    const { type: eventType, payload } = normalizeEventEnvelope(event);
    if (!payload) return false;
    if (eventType === 'event_msg') {
      if (payload.type !== 'user_message') return false;
      const text = textFromUserMessagePayload(payload);
      const images = imagesFromUserMessagePayload(payload);
      const files = extractComposerFileAttachments(text).files;
      return Boolean(visibleUserMessageText(text, {
        renderedAttachmentKinds: renderedAttachmentKindsForAttachments({ images, files }),
      }) || images.length > 0 || files.length > 0);
    }
    if (eventType === 'response_item') {
      if (payload.type !== 'message' || payload.role !== 'user') return false;
      const text = textFromContent(payload.content);
      const images = imagesFromContent(payload.content);
      const files = extractComposerFileAttachments(text).files;
      return Boolean(visibleUserMessageText(text, {
        renderedAttachmentKinds: renderedAttachmentKindsForAttachments({ images, files }),
      }) || images.length > 0 || files.length > 0);
    }
    if (eventType === 'item/started' || eventType === 'item/completed' || eventType === 'item.started' || eventType === 'item.completed') {
      if (turnItemType(payload.item) !== 'usermessage') return false;
      const text = textFromUserInput(payload.item?.content);
      const images = imagesFromContent(payload.item?.content);
      const audios = audiosFromContent(payload.item?.content);
      const files = extractComposerFileAttachments(text).files;
      return Boolean(visibleUserMessageText(text, {
        renderedAttachmentKinds: renderedAttachmentKindsForAttachments({ images, audios, files }),
      }) || images.length > 0 || audios.length > 0 || files.length > 0);
    }
    return false;
  } catch {
    return false;
  }
}

function dropLeadingPartialTurn(lines) {
  const firstUserIndex = lines.findIndex(isUserMessageLine);
  return firstUserIndex > 0 ? lines.slice(firstUserIndex) : lines;
}

async function readCodexTranscript(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return { available: false, reason: 'missing-session-id', sessionId: '', turns: [] };
  }

  const filePath = findCodexRolloutFile(normalizedSessionId, {
    codexHome: options.codexHome || path.join(os.homedir(), '.codex'),
  });
  if (!filePath) {
    return { available: false, reason: 'history-not-found', sessionId: normalizedSessionId, turns: [] };
  }

  const tail = await readTailLines(filePath, options.maxReadBytes);
  const lines = tail.truncated ? dropLeadingPartialTurn(tail.lines) : tail.lines;
  const stat = fs.statSync(filePath);
  const maxTurns = Number.isFinite(options.maxTurns) ? Math.max(1, Math.floor(options.maxTurns)) : DEFAULT_MAX_TURNS;
  const allTurns = buildTranscriptFromLines(lines, { maxTurns: Number.MAX_SAFE_INTEGER });
  const turns = allTurns.slice(-maxTurns);
  return {
    available: true,
    sessionId: normalizedSessionId,
    filePath,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    source: 'codex-rollout-jsonl',
    hasMoreBefore: allTurns.length > maxTurns || tail.truncated,
    turnLimit: maxTurns,
    turns,
  };
}

async function readCodexHistoryImageData(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return new Map();
  const filePath = findCodexRolloutFile(normalizedSessionId, {
    codexHome: options.codexHome || path.join(os.homedir(), '.codex'),
  });
  if (!filePath) return new Map();
  const tail = await readTailLines(filePath, options.maxReadBytes);
  const imageDataByPath = new Map();
  for (const line of tail.lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const { type: eventType, payload } = normalizeEventEnvelope(event);
      if (!payload) continue;
      if (eventType === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        appendHistoryImageDataFromContent(imageDataByPath, payload.content);
        continue;
      }
      if (['item/started', 'item/completed', 'item.started', 'item.completed'].includes(eventType)) {
        const item = payload.item;
        if (turnItemType(item) === 'usermessage') appendHistoryImageDataFromContent(imageDataByPath, item?.content);
      }
    } catch {
      // Ignore malformed or partial tail records; history replay remains usable without image recovery.
    }
  }
  return imageDataByPath;
}

function buildTranscriptFromEvents(events, options = {}) {
  const lines = Array.isArray(events)
    ? events.filter(event => event && typeof event === 'object').map(event => JSON.stringify(event))
    : [];
  return buildTranscriptFromLines(lines, options);
}

module.exports = {
  DEFAULT_MAX_TURNS,
  buildTranscriptFromEvents,
  buildTranscriptFromLines,
  codexHistoryImageTargets,
  dropLeadingPartialTurn,
  readCodexHistoryImageData,
  readCodexTranscript,
  stripUserMessagePrefix,
  textFromContent,
  visibleUserMessageText,
};
