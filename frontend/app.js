let ws = null;
let state = null;
let focusedAgentId = null;
let keyMap = {};
let agents = [];
let waitingForAgent = false;
let selectedAgentIndex = null;
let terminal = null;
let fitAddon = null;
let availableThemes = [];
let currentTheme = 'terminal';
let themeSettings = {};
let currentSessionSkin = null;
let currentSessionTitle = 'Agent Session';
let sessionClient = null;
let globalSettings = {
  workspace: '',
  workspaceHistory: [],
  codingAgentEngine: 'local',
  dangerouslySkipAgentPermissionsByDefault: false,
  vtBaseUrl: 'http://localhost:4020'
};
let workspaceHistorySelection = -1;
let workspaceHistoryExpanded = false;
let pendingMainAgentLaunch = false;
let sessionRuntime = null;
let legacySessionPoller = null;
let terminalInputBridge = null;
let terminalInputComposing = false;
let terminalInputLastBackspaceAt = 0;
let terminalInputLastDeleteAt = 0;
let terminalInputPendingTexts = [];
const SESSION_INPUT_SETTINGS = {
  imeEnabled: true
};
const SESSION_LINK_LIMIT = 6;
let sessionSearchMatches = [];
let sessionSearchIndex = -1;
const MAX_WORKSPACE_HISTORY = 5;
const TERMINAL_THEME = typeof window !== 'undefined' && window.FarmingTerminalBridge
  ? window.FarmingTerminalBridge.DEFAULT_THEME
  : {
      background: '#090b09',
      foreground: '#7CFF76',
      cursor: '#8CFF83',
      cursorAccent: '#050605',
      selectionBackground: 'rgba(124, 255, 118, 0.22)',
      black: '#0b120b',
      red: '#ff5f56',
      green: '#7CFF76',
      yellow: '#f3f99d',
      blue: '#55c7ff',
      magenta: '#ff7bf1',
      cyan: '#78ffd6',
      white: '#f2fff0',
      brightBlack: '#4f6b4c',
      brightRed: '#ff8a7a',
      brightGreen: '#a7ff9f',
      brightYellow: '#fbffb8',
      brightBlue: '#8dddff',
      brightMagenta: '#ffacef',
      brightCyan: '#a9ffec',
      brightWhite: '#ffffff'
    };
const TERMINAL_FONT_FAMILY = typeof window !== 'undefined' && window.FarmingTerminalBridge
  ? window.FarmingTerminalBridge.DEFAULT_FONT_FAMILY
  : '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Sarasa Mono SC", "PingFang SC", "Hiragino Sans GB", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace';
const SESSION_MODAL_BRIDGE = (() => {
  if (typeof window !== 'undefined' && window.FarmingSessionModalBridge) {
    return window.FarmingSessionModalBridge;
  }

  if (typeof require === 'function') {
    try {
      return require('./session-modal-bridge.js');
    } catch {
      return null;
    }
  }

  return null;
})();

function isBrowserShortcut(event) {
  const pressed = event.key.toLowerCase();
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const wrongPrimary = isMac ? event.ctrlKey : event.metaKey;

  if (wrongPrimary || !primary) {
    if (!isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && pressed === 'f4') {
      return true;
    }
    return false;
  }

  const noModifiers = !event.shiftKey && !event.altKey;
  const withShift = event.shiftKey && !event.altKey;
  const withAlt = event.altKey && !event.shiftKey;

  const baseKeys = isMac ? ['t', 'n', 'w', 'q', 'h', 'm', ','] : ['t', 'n', 'w', 'h'];
  const shiftKeys = isMac ? ['t', 'n', 'a', 'z', ']', '[', 'j', 'c'] : ['t', 'n', 'j', 'c'];
  const altKeys = isMac ? ['w'] : [];

  if (noModifiers && (baseKeys.includes(pressed) || /^[0-9]$/.test(event.key) || ['c', 'x', 'v'].includes(pressed))) {
    return true;
  }
  if (withShift && shiftKeys.includes(pressed)) {
    return true;
  }
  if (withAlt && altKeys.includes(pressed)) {
    return true;
  }

  return false;
}

function isPrimaryModifierPressed(event) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return isMac ? event.metaKey : event.ctrlKey;
}

function isCopyShortcut(event) {
  return isPrimaryModifierPressed(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c';
}

function isPasteShortcut(event) {
  return isPrimaryModifierPressed(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v';
}

function disposeTerminal() {
  if (terminal) {
    terminal.dispose();
    terminal = null;
  }
  fitAddon = null;
}

function destroyTerminalInputBridge() {
  if (terminalInputBridge) {
    terminalInputBridge.remove();
    terminalInputBridge = null;
  }
  clearPendingPrintableInput();
  terminalInputComposing = false;
  document.body.removeAttribute('data-ime-input-focused');
  document.body.removeAttribute('data-ime-composing');
}

function clearPendingPrintableInput() {
  terminalInputPendingTexts.forEach((pending) => {
    clearTimeout(pending.timeoutId);
  });
  terminalInputPendingTexts = [];
}

function resetTerminalInputBridgeValue() {
  if (!terminalInputBridge) return;
  terminalInputBridge.value = ' ';
  terminalInputBridge.setSelectionRange(1, 1);
}

function schedulePrintableInput(text) {
  const pending = {
    text,
    timeoutId: setTimeout(() => {
      if (!terminalInputComposing) {
        sendTerminalInput(text);
        resetTerminalInputBridgeValue();
      }
      terminalInputPendingTexts = terminalInputPendingTexts.filter((item) => item !== pending);
    }, 10)
  };
  terminalInputPendingTexts.push(pending);
}

function focusTerminalInputBridge() {
  if (!SESSION_INPUT_SETTINGS.imeEnabled) return;
  if (!terminalInputBridge) return;
  if (isOverlayBlockingTerminalInput()) return;
  terminalInputBridge.focus();
  resetTerminalInputBridgeValue();
}

function isOverlayBlockingTerminalInput() {
  const inputDialog = document.getElementById('input-dialog');
  if (inputDialog && inputDialog.classList.contains('active')) {
    return true;
  }

  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal && settingsModal.classList.contains('active')) {
    return true;
  }

  return false;
}

function focusSessionTerminal() {
  if (terminal && typeof terminal.focus === 'function') {
    terminal.focus();
  }
  focusTerminalInputBridge();
}

function getDocumentSelectionText() {
  const selection = window.getSelection();
  return selection ? selection.toString() : '';
}

function getTerminalSelectionText() {
  if (!terminal || typeof terminal.getSelection !== 'function') {
    return '';
  }
  return normalizeTerminalSelectionText(terminal);
}

function normalizeTerminalSelectionText(terminalInstance) {
  const selection = terminalInstance && typeof terminalInstance.getSelection === 'function'
    ? terminalInstance.getSelection() || ''
    : '';

  const position = terminalInstance && typeof terminalInstance.getSelectionPosition === 'function'
    ? terminalInstance.getSelectionPosition()
    : null;
  const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
  if (!position || !buffer || typeof buffer.getLine !== 'function') {
    return selection;
  }

  const rebuiltSelection = rebuildTerminalSelectionFromBuffer(position, buffer);
  if (rebuiltSelection !== null) {
    return rebuiltSelection;
  }

  if (!selection.includes('\n')) {
    return selection;
  }

  const ordered = getOrderedSelectionPosition(position);
  const startRow = ordered.start.y;
  return selection.split('\n').reduce((text, part, index) => {
    if (index === 0) {
      return part;
    }

    const currentLine = buffer.getLine(startRow + index);
    const separator = currentLine && currentLine.isWrapped ? '' : '\n';
    return `${text}${separator}${part}`;
  }, '');
}

function getOrderedSelectionPosition(position) {
  const start = { ...position.start };
  const end = { ...position.end };
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
    return { start: end, end: start };
  }
  return { start, end };
}

function readTerminalLineSelectionText(line, startCol, endCol) {
  if (!line || typeof line.getCell !== 'function') {
    return null;
  }

  let text = '';
  const maxCol = Math.max(startCol, endCol);
  for (let col = Math.max(0, startCol); col <= maxCol; col += 1) {
    const cell = line.getCell(col);
    if (!cell) continue;

    if (typeof cell.getChars === 'function') {
      text += cell.getChars();
      continue;
    }

    const code = typeof cell.getCode === 'function' ? cell.getCode() : 0;
    if (code > 0) {
      text += String.fromCodePoint(code);
    }
  }

  return text.trimEnd();
}

function rebuildTerminalSelectionFromBuffer(position, buffer) {
  const ordered = getOrderedSelectionPosition(position);
  const rows = [];

  for (let row = ordered.start.y; row <= ordered.end.y; row += 1) {
    const line = buffer.getLine(row);
    const startCol = row === ordered.start.y ? ordered.start.x : 0;
    const fallbackEndCol = typeof (line && line.length) === 'number' ? line.length - 1 : ordered.end.x;
    const endCol = row === ordered.end.y ? ordered.end.x : fallbackEndCol;
    const text = readTerminalLineSelectionText(line, startCol, endCol);
    if (text === null) {
      return null;
    }

    const separator = row === ordered.start.y ? '' : line && line.isWrapped ? '' : '\n';
    rows.push(`${separator}${text}`);
  }

  return rows.join('');
}

function hasAnySelection() {
  return Boolean(getTerminalSelectionText() || getDocumentSelectionText());
}

function setClipboardText(event, text) {
  if (!event || !event.clipboardData || !text) {
    return false;
  }

  event.clipboardData.setData('text/plain', text);
  return true;
}

async function copyTerminalSelection() {
  const text = getTerminalSelectionText() || getDocumentSelectionText();
  if (!text) {
    return false;
  }

  if (fallbackCopyText(text)) {
    focusSessionTerminal();
    return true;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('Clipboard API copy failed, falling back:', error);
  }

  return false;
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function pasteTerminalText(text) {
  if (!text || !focusedAgentId) {
    return false;
  }

  sendTerminalInput(text.replace(/\r\n/g, '\n'));
  focusSessionTerminal();
  return true;
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    return false;
  }

  try {
    const text = await navigator.clipboard.readText();
    return pasteTerminalText(text);
  } catch (error) {
    console.warn('Clipboard API paste failed:', error);
    return false;
  }
}

function routeSessionKey(event) {
  if (!focusedAgentId || terminalInputComposing || isBrowserShortcut(event)) {
    return false;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== 'Enter') {
    const controlChar = getControlChar(event.key);
    if (controlChar) {
      sendTerminalInput(controlChar);
      return true;
    }
  }

  const sequence = getTerminalSequenceForKey(event);
  if (sequence) {
    sendTerminalInput(sequence);
    return true;
  }

  return false;
}

function getControlChar(key) {
  const lower = key.toLowerCase();
  if (!/^[a-z]$/.test(lower)) return null;
  return String.fromCharCode(lower.charCodeAt(0) - 96);
}

function getSessionClient() {
  if (!window.FarmingSessionBridge || !window.FarmingSessionBridge.createClient) {
    return null;
  }

  if (!sessionClient) {
    sessionClient = window.FarmingSessionBridge.createClient({
      getSocket: () => ws,
      fetchImpl: (...args) => fetch(...args)
    });
  }

  return sessionClient;
}

function getTerminalSequenceForKey(event) {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = event;

  if (metaKey) return null;

  if (altKey && !ctrlKey) {
    if (key === 'ArrowLeft') return '\x1bb';
    if (key === 'ArrowRight') return '\x1bf';
    if (key === 'Backspace') return '\x17';
  }

  switch (key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return shiftKey ? '\x1b[Z' : '\t';
    case 'Delete':
      return '\x1b[3~';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      return null;
  }
}

function setupTerminalInputBridge() {
  destroyTerminalInputBridge();

  if (!SESSION_INPUT_SETTINGS.imeEnabled) {
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'absolute';
  input.style.top = '0';
  input.style.left = '0';
  input.style.width = '200px';
  input.style.height = '24px';
  input.style.opacity = '0.01';
  input.style.background = 'transparent';
  input.style.color = 'transparent';
  input.style.caretColor = 'transparent';
  input.style.border = 'none';
  input.style.outline = 'none';
  input.style.fontSize = '16px';
  input.style.pointerEvents = 'none';
  input.style.zIndex = '2';

  input.addEventListener('compositionstart', () => {
    clearPendingPrintableInput();
    terminalInputComposing = true;
    document.body.setAttribute('data-ime-composing', 'true');
  });

  input.addEventListener('compositionend', (event) => {
    terminalInputComposing = false;
    document.body.removeAttribute('data-ime-composing');
    clearPendingPrintableInput();
    if (event.data) {
      sendTerminalInput(event.data);
    }
    resetTerminalInputBridgeValue();
  });

  input.addEventListener('beforeinput', (event) => {
    if (terminalInputComposing) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'insertText' && inputEvent.data) {
      clearPendingPrintableInput();
      event.preventDefault();
      sendTerminalInput(inputEvent.data);
      resetTerminalInputBridgeValue();
    }
  });

  input.addEventListener('input', (event) => {
    if (terminalInputComposing) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'deleteContentBackward') {
      clearPendingPrintableInput();
      const now = Date.now();
      if (now - terminalInputLastBackspaceAt > 50) {
        sendTerminalInput('\x7f');
      }
      terminalInputLastBackspaceAt = now;
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    if (inputEvent.inputType === 'deleteContentForward') {
      clearPendingPrintableInput();
      const now = Date.now();
      if (now - terminalInputLastDeleteAt > 50) {
        sendTerminalInput('\x1b[3~');
      }
      terminalInputLastDeleteAt = now;
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    clearPendingPrintableInput();
    resetTerminalInputBridgeValue();
  });

  input.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {
      return;
    }

    if (isOverlayBlockingTerminalInput()) {
      return;
    }

    if (isBrowserShortcut(event)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Escape') {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
      return;
    }

    if (terminalInputComposing) {
      return;
    }

    if (['Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== 'Enter') {
      clearPendingPrintableInput();
      const controlChar = getControlChar(event.key);
      if (controlChar) {
        event.preventDefault();
        sendTerminalInput(controlChar);
        resetTerminalInputBridgeValue();
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      schedulePrintableInput(event.key);
      return;
    }

    if (event.key === 'Backspace') {
      clearPendingPrintableInput();
      terminalInputLastBackspaceAt = Date.now();
      sendTerminalInput('\x7f');
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    const sequence = getTerminalSequenceForKey(event);
    if (!sequence) {
      return;
    }

    if (event.key === 'Delete') {
      terminalInputLastDeleteAt = Date.now();
    }

    event.preventDefault();
    sendTerminalInput(sequence);
    if (event.key !== 'Tab') {
      resetTerminalInputBridgeValue();
    }
  });

  input.addEventListener('focus', () => {
    document.body.setAttribute('data-ime-input-focused', 'true');
    requestAnimationFrame(() => {
      if (document.activeElement === input) {
        resetTerminalInputBridgeValue();
      }
    });
  });

  input.addEventListener('blur', () => {
    document.body.removeAttribute('data-ime-input-focused');
    setTimeout(() => {
      const sessionActive = document.getElementById('session-modal')?.classList.contains('active');
      if (!sessionActive || terminalInputComposing || !terminalInputBridge || isOverlayBlockingTerminalInput()) {
        return;
      }
      focusTerminalInputBridge();
    }, 0);
  });

  const sessionModal = document.getElementById('session-modal');
  if (sessionModal) {
    sessionModal.appendChild(input);
  } else {
    document.body.appendChild(input);
  }
  terminalInputBridge = input;
}

async function createTerminalInstance() {
  if (window.FarmingTerminalBridge && window.FarmingTerminalBridge.createInstance) {
    return window.FarmingTerminalBridge.createInstance({
      theme: currentSessionSkin && currentSessionSkin.terminalTheme
        ? currentSessionSkin.terminalTheme
        : TERMINAL_THEME,
      fontSize: 14,
      fontFamily: TERMINAL_FONT_FAMILY,
      cursorBlink: false,
      smoothScrollDuration: 120,
      disableStdin: true,
      scrollback: 20000
    });
  }

  return null;
}

function shouldUseLiveSessionText(agent) {
  return Boolean(agent && agent.sessionSource === 'live-text');
}

function getAgentDisplayText(agent) {
  if (!agent) return '';
  return stripAnsi(agent.previewText || agent.output || '');
}

function normalizeSessionLink(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '';
  }

  let trimmed = rawUrl.trim();
  const trailingPunctuation = new Set(['.', ',', ';', '!', '?', '\u3002', '\uff0c', '\uff1b', '\uff01', '\uff1f']);

  while (trimmed.length > 0) {
    const lastChar = trimmed[trimmed.length - 1];
    if (trailingPunctuation.has(lastChar)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }

    if (lastChar === ')' || lastChar === ']') {
      const openChar = lastChar === ')' ? '(' : '[';
      const closeChar = lastChar;
      const openCount = (trimmed.match(new RegExp(`\\${openChar}`, 'g')) || []).length;
      const closeCount = (trimmed.match(new RegExp(`\\${closeChar}`, 'g')) || []).length;
      if (closeCount > openCount) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }

    break;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return '';
  }
}

function extractSessionLinks(text, limit = SESSION_LINK_LIMIT) {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set();
  const links = [];

  matches.forEach((match) => {
    const normalized = normalizeSessionLink(match);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    links.push(normalized);
  });

  return links.slice(-limit);
}

function formatSelectionStatus(selectionPosition, selectionText = '') {
  if (!selectionPosition || !selectionPosition.start || !selectionPosition.end) {
    return 'No selection';
  }

  const charCount = typeof selectionText === 'string' ? selectionText.length : 0;
  const start = `${selectionPosition.start.y + 1}:${selectionPosition.start.x + 1}`;
  const end = `${selectionPosition.end.y + 1}:${selectionPosition.end.x + 1}`;
  return `Sel ${start} -> ${end}${charCount ? ` • ${charCount} chars` : ''}`;
}

function deriveSessionSearchMatchesFromLines(lines, query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) {
    return [];
  }

  const matches = [];
  lines.forEach((lineText, lineIndex) => {
    const normalizedLine = String(lineText || '').toLowerCase();
    let searchStart = 0;

    while (searchStart < normalizedLine.length) {
      const matchIndex = normalizedLine.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }

      matches.push({
        line: lineIndex,
        startColumn: matchIndex,
        length: normalizedQuery.length,
        preview: String(lineText || '').trim(),
      });
      searchStart = matchIndex + Math.max(1, normalizedQuery.length);
    }
  });

  return matches;
}

function buildTerminalLineProjection(line) {
  if (!line || typeof line.length !== 'number' || typeof line.getCell !== 'function') {
    return { text: '', offsetToCell: [0] };
  }

  let text = '';
  const offsetToCell = [0];

  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      continue;
    }

    const chars = typeof cell.getChars === 'function'
      ? cell.getChars()
      : (typeof cell.getCodepoint === 'function' && cell.getCodepoint() > 0
        ? String.fromCodePoint(cell.getCodepoint())
        : '');

    if (!chars) {
      continue;
    }

    const startOffset = text.length;
    text += chars;
    for (let offset = startOffset; offset < text.length; offset += 1) {
      offsetToCell[offset] = column;
    }
  }

  offsetToCell[text.length] = line.length;
  return { text, offsetToCell };
}

function collectWrappedLinkContext(buffer, row) {
  if (!buffer || typeof buffer.getLine !== 'function') {
    return null;
  }

  let startRow = row;
  while (startRow > 0) {
    const previousLine = buffer.getLine(startRow - 1);
    if (!previousLine || !previousLine.isWrapped) {
      break;
    }
    startRow -= 1;
  }

  const segments = [];
  let currentRow = startRow;
  while (true) {
    const line = buffer.getLine(currentRow);
    if (!line) {
      break;
    }

    const projection = buildTerminalLineProjection(line);
    segments.push({
      row: currentRow,
      text: projection.text,
      offsetToCell: projection.offsetToCell,
    });

    if (!line.isWrapped) {
      break;
    }
    currentRow += 1;
  }

  if (!segments.length) {
    return null;
  }

  let mergedText = '';
  const segmentOffsets = [];
  segments.forEach((segment) => {
    segmentOffsets.push(mergedText.length);
    mergedText += segment.text;
  });

  return { mergedText, segments, segmentOffsets };
}

function mapMergedOffsetToTerminalPosition(context, offset) {
  const clampedOffset = Math.max(0, Math.min(offset, context.mergedText.length));

  for (let index = context.segments.length - 1; index >= 0; index -= 1) {
    const segment = context.segments[index];
    const segmentStart = context.segmentOffsets[index];
    if (clampedOffset >= segmentStart) {
      const localOffset = Math.min(clampedOffset - segmentStart, segment.text.length);
      const cell = segment.offsetToCell[localOffset] ?? segment.offsetToCell[segment.offsetToCell.length - 1] ?? 0;
      return { x: cell, y: segment.row };
    }
  }

  return { x: 0, y: context.segments[0].row };
}

function collectTerminalHyperlinkRange(buffer, row, column, hyperlinkId) {
  let startRow = row;
  let startColumn = column;

  while (true) {
    if (startColumn > 0) {
      const currentLine = buffer.getLine(startRow);
      const previousCell = currentLine && currentLine.getCell(startColumn - 1);
      if (previousCell && typeof previousCell.getHyperlinkId === 'function' && previousCell.getHyperlinkId() === hyperlinkId) {
        startColumn -= 1;
        continue;
      }
    }

    const previousRow = startRow - 1;
    const previousLine = previousRow >= 0 ? buffer.getLine(previousRow) : null;
    if (!previousLine || !previousLine.isWrapped || previousLine.length === 0) {
      break;
    }

    const previousTail = previousLine.getCell(previousLine.length - 1);
    if (!previousTail || typeof previousTail.getHyperlinkId !== 'function' || previousTail.getHyperlinkId() !== hyperlinkId) {
      break;
    }

    startRow = previousRow;
    startColumn = previousLine.length;
  }

  let endRow = row;
  let endColumn = column + 1;

  while (true) {
    const currentLine = buffer.getLine(endRow);
    const nextCell = currentLine && endColumn < currentLine.length ? currentLine.getCell(endColumn) : null;
    if (nextCell && typeof nextCell.getHyperlinkId === 'function' && nextCell.getHyperlinkId() === hyperlinkId) {
      endColumn += 1;
      continue;
    }

    const nextRow = endRow + 1;
    const nextLine = buffer.getLine(nextRow);
    const currentLineWraps = currentLine && currentLine.isWrapped;
    if (!currentLineWraps || !nextLine || nextLine.length === 0) {
      break;
    }

    const nextHead = nextLine.getCell(0);
    if (!nextHead || typeof nextHead.getHyperlinkId !== 'function' || nextHead.getHyperlinkId() !== hyperlinkId) {
      break;
    }

    endRow = nextRow;
    endColumn = 0;
  }

  return {
    start: { x: startColumn, y: startRow },
    end: { x: endColumn, y: endRow },
  };
}

function createTerminalOsc8LinkProvider(terminalInstance) {
  return {
    provideLinks(row, callback) {
      const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
      const line = buffer && typeof buffer.getLine === 'function' ? buffer.getLine(row) : null;
      const wasmTerm = terminalInstance ? terminalInstance.wasmTerm : null;
      if (!line || !wasmTerm || typeof wasmTerm.getHyperlinkUri !== 'function') {
        callback(undefined);
        return;
      }

      const links = [];
      const seen = new Set();

      for (let column = 0; column < line.length; column += 1) {
        const cell = line.getCell(column);
        const hyperlinkId = cell && typeof cell.getHyperlinkId === 'function' ? cell.getHyperlinkId() : 0;
        if (!hyperlinkId || seen.has(hyperlinkId)) {
          continue;
        }

        const uri = normalizeSessionLink(wasmTerm.getHyperlinkUri(hyperlinkId) || '');
        if (!uri) {
          continue;
        }

        seen.add(hyperlinkId);
        links.push({
          text: uri,
          range: collectTerminalHyperlinkRange(buffer, row, column, hyperlinkId),
          activate: () => {
            window.open(uri, '_blank', 'noopener,noreferrer');
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

function createTerminalUrlLinkProvider(terminalInstance) {
  return {
    provideLinks(row, callback) {
      const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
      const context = collectWrappedLinkContext(buffer, row);
      if (!context || !context.mergedText) {
        callback(undefined);
        return;
      }

      const links = [];
      const matches = context.mergedText.matchAll(/https?:\/\/[^\s<>"']+/gi);
      for (const match of matches) {
        const normalized = normalizeSessionLink(match[0]);
        if (!normalized) {
          continue;
        }

        const startOffset = match.index;
        const endOffset = startOffset + normalized.length;
        const start = mapMergedOffsetToTerminalPosition(context, startOffset);
        const end = mapMergedOffsetToTerminalPosition(context, endOffset);

        if (row < start.y || row > end.y) {
          continue;
        }

        links.push({
          text: normalized,
          range: { start, end },
          activate: () => {
            window.open(normalized, '_blank', 'noopener,noreferrer');
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

function registerTerminalLinks(terminalInstance) {
  if (!terminalInstance || typeof terminalInstance.registerLinkProvider !== 'function') {
    return;
  }

  terminalInstance.registerLinkProvider(createTerminalOsc8LinkProvider(terminalInstance));
  terminalInstance.registerLinkProvider(createTerminalUrlLinkProvider(terminalInstance));
}

function getTerminalBufferLines(terminalInstance) {
  const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
  if (!buffer || typeof buffer.length !== 'number' || typeof buffer.getLine !== 'function') {
    return [];
  }

  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    lines.push(line && typeof line.translateToString === 'function' ? line.translateToString(false) : '');
  }
  return lines;
}

function updateSessionTitleDisplay(title = currentSessionTitle) {
  currentSessionTitle = title || 'Agent Session';
  const titleNode = document.getElementById('session-title');
  if (titleNode) {
    titleNode.textContent = currentSessionTitle;
  }
}

function updateSessionSelectionStatus() {
  const statusNode = document.getElementById('session-selection-status');
  if (!statusNode) {
    return;
  }

  const selectionPosition = terminal && typeof terminal.getSelectionPosition === 'function'
    ? terminal.getSelectionPosition()
    : undefined;
  const selectionText = terminal && typeof terminal.getSelection === 'function'
    ? terminal.getSelection()
    : '';
  const statusText = formatSelectionStatus(selectionPosition, selectionText);
  statusNode.textContent = statusText;
  statusNode.classList.toggle('is-empty', statusText === 'No selection');
}

function updateSessionSearchStatus(text = 'No search') {
  const statusNode = document.getElementById('session-search-status');
  if (!statusNode) {
    return;
  }

  statusNode.textContent = text;
  statusNode.classList.toggle('is-empty', text === 'No search' || text === 'No matches');
}

function applyCurrentSearchMatch({ selectLine = false } = {}) {
  if (!terminal || sessionSearchIndex < 0 || sessionSearchIndex >= sessionSearchMatches.length) {
    updateSessionSearchStatus(sessionSearchMatches.length ? 'No active match' : 'No matches');
    return;
  }

  const match = sessionSearchMatches[sessionSearchIndex];
  terminal.scrollToLine(match.line);
  if (selectLine && typeof terminal.selectLines === 'function') {
    terminal.selectLines(match.line, match.line);
  } else if (typeof terminal.select === 'function') {
    terminal.select(match.startColumn, match.line, Math.max(1, match.length));
  }

  updateSessionSearchStatus(`Match ${sessionSearchIndex + 1}/${sessionSearchMatches.length} • L${match.line + 1}`);
  updateSessionSelectionStatus();
}

function refreshSessionSearchMatches({ preserveIndex = false } = {}) {
  const searchInput = document.getElementById('session-search-input');
  const query = searchInput ? searchInput.value : '';
  sessionSearchMatches = deriveSessionSearchMatchesFromLines(getTerminalBufferLines(terminal), query);
  if (!sessionSearchMatches.length) {
    sessionSearchIndex = -1;
    if (terminal && typeof terminal.clearSelection === 'function') {
      terminal.clearSelection();
    }
    updateSessionSearchStatus(query.trim() ? 'No matches' : 'No search');
    updateSessionSelectionStatus();
    return;
  }

  sessionSearchIndex = preserveIndex && sessionSearchIndex >= 0
    ? Math.min(sessionSearchIndex, sessionSearchMatches.length - 1)
    : 0;
  applyCurrentSearchMatch();
}

function navigateSessionSearchMatch(direction) {
  if (!sessionSearchMatches.length) {
    refreshSessionSearchMatches();
    return;
  }

  sessionSearchIndex = (sessionSearchIndex + direction + sessionSearchMatches.length) % sessionSearchMatches.length;
  applyCurrentSearchMatch();
}

function setupSessionSearchControls() {
  const searchInput = document.getElementById('session-search-input');
  const prevButton = document.getElementById('session-search-prev');
  const nextButton = document.getElementById('session-search-next');
  const lineButton = document.getElementById('session-search-line');
  if (!searchInput || searchInput.dataset.bound === 'true') {
    return;
  }

  searchInput.dataset.bound = 'true';

  searchInput.addEventListener('input', () => {
    refreshSessionSearchMatches();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigateSessionSearchMatch(event.shiftKey ? -1 : 1);
    }
  });
  prevButton.addEventListener('click', () => navigateSessionSearchMatch(-1));
  nextButton.addEventListener('click', () => navigateSessionSearchMatch(1));
  lineButton.addEventListener('click', () => applyCurrentSearchMatch({ selectLine: true }));
}

function resetSessionUiState() {
  sessionSearchMatches = [];
  sessionSearchIndex = -1;
  const searchInput = document.getElementById('session-search-input');
  if (searchInput) {
    searchInput.value = '';
  }
  updateSessionSearchStatus('No search');
  updateSessionSelectionStatus();
}

function refreshSessionTerminalUi({ preserveSearchIndex = false } = {}) {
  const searchInput = document.getElementById('session-search-input');
  if (searchInput && searchInput.value.trim()) {
    refreshSessionSearchMatches({ preserveIndex: preserveSearchIndex });
    return;
  }

  updateSessionSearchStatus('No search');
  updateSessionSelectionStatus();
}

function deriveSessionTextPatch(fullText, previousLength, forceReplace = false) {
  if (typeof fullText !== 'string') {
    return {
      mode: 'noop',
      text: '',
      nextLength: previousLength
    };
  }

  if (forceReplace || fullText.length < previousLength) {
    return {
      mode: 'replace',
      text: fullText,
      nextLength: fullText.length
    };
  }

  if (fullText.length > previousLength) {
    return {
      mode: 'append',
      text: fullText.slice(previousLength),
      nextLength: fullText.length
    };
  }

  return {
    mode: 'noop',
    text: '',
    nextLength: previousLength
  };
}

function normalizeSessionViewPayload(payload, fallbackAgent = null) {
  const session = payload && payload.session ? payload.session : {};

  return {
    agentId: session.agentId || (fallbackAgent && fallbackAgent.id) || null,
    command: session.command || (fallbackAgent && fallbackAgent.command) || '',
    cwd: session.cwd || (fallbackAgent && fallbackAgent.cwd) || '',
    status: session.status || (fallbackAgent && fallbackAgent.status) || 'running',
    sessionSource: session.sessionSource || (fallbackAgent && fallbackAgent.sessionSource) || 'buffer',
    output: typeof session.output === 'string' ? session.output : ((fallbackAgent && fallbackAgent.output) || ''),
    previewText: typeof session.previewText === 'string' ? session.previewText : ((fallbackAgent && fallbackAgent.previewText) || ''),
    isMain: typeof session.isMain === 'boolean' ? session.isMain : Boolean(fallbackAgent && fallbackAgent.isMain),
    activityLevel: session.activityLevel || (fallbackAgent && fallbackAgent.activityLevel) || 'cold',
    lastActivity: session.lastActivity || (fallbackAgent && fallbackAgent.lastActivity) || null,
    startedAt: session.startedAt || null,
    exitedAt: session.exitedAt || null
  };
}

function deriveSessionStreamPatch(stream, currentFocusedAgentId, currentSessionSource) {
  if (!stream) return null;
  if (stream.agentId !== currentFocusedAgentId) return null;
  if (!currentSessionSource) return null;
  if (typeof stream.data !== 'string' || stream.data.length === 0) return null;

  return {
    text: stream.data,
    nextLengthDelta: stream.data.length
  };
}

function createSessionModalState(agent, themeId, currentThemeSettings) {
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.createModalState) {
    return SESSION_MODAL_BRIDGE.createModalState(agent, themeId, currentThemeSettings);
  }

  const sessionSource = agent && agent.sessionSource ? agent.sessionSource : 'buffer';
  return {
    agentId: agent ? agent.id : null,
    sessionSource,
    sessionSkin: null,
    title: agent ? `${agent.command} (${agent.id})` : 'Agent Session'
  };
}

function shouldPollSessionView(sessionSource) {
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.shouldPollSessionView) {
    return SESSION_MODAL_BRIDGE.shouldPollSessionView(sessionSource);
  }
  return sessionSource === 'live-text';
}

function getSessionModalDomState(documentRef) {
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.getDomState) {
    return SESSION_MODAL_BRIDGE.getDomState(documentRef);
  }
  return {
    modal: documentRef.getElementById('session-modal'),
    terminalContainer: documentRef.getElementById('terminal-output'),
    title: documentRef.getElementById('session-title')
  };
}

function getSessionRuntime() {
  if (!sessionRuntime && SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.createRuntime) {
    sessionRuntime = SESSION_MODAL_BRIDGE.createRuntime({
      deriveSessionStreamPatch,
      refreshSessionView,
      schedulePoll: (handler) => setInterval(handler, 350),
      clearPoll: (poller) => clearInterval(poller)
    });
  }

  return sessionRuntime;
}

function syncSessionRuntimeState() {
  const runtime = getSessionRuntime();
  if (!runtime) return;

  focusedAgentId = runtime.getFocusedAgentId();
}

function getActiveSessionSource() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getSessionSource() : null;
}

function getSessionOutputLength() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getLastOutputLength() : 0;
}

function getCurrentSessionToken() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getSessionToken() : 0;
}

function isAwaitingInitialSessionSync() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.isAwaitingInitialSync() : false;
}

function setSessionOutputLength(length) {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.setLastOutputLength(length);
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
            .replace(/\[\?[0-9;]*[a-zA-Z]/g, '')
            .replace(/\[>[0-9;]*[a-zA-Z]/g, '');
}

async function loadThemes() {
  try {
    const response = await fetch('/api/themes');
    const data = await response.json();
    availableThemes = data.themes;
    currentTheme = data.current;
    
    const settingsResponse = await fetch(`/api/themes/${currentTheme}/settings`);
    const settingsData = await settingsResponse.json();
    themeSettings = settingsData.settings || {};
    
    if (themeSettings.crtEffects !== undefined) {
      applyCRTEffects(themeSettings.crtEffects);
    }
  } catch (error) {
    console.error('Failed to load themes:', error);
  }
}

async function loadGlobalSettings() {
  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    globalSettings = {
      ...globalSettings,
      ...(data.settings || {})
    };
    syncWorkspaceSettings();
    refreshWorkspaceMemoryUI();
  } catch (error) {
    console.error('Failed to load global settings:', error);
  }
}

async function saveGlobalSettings() {
  try {
    syncWorkspaceSettings();
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(globalSettings)
    });

    const data = await response.json();
    if (data.success) {
      globalSettings = {
        ...globalSettings,
        ...(data.settings || {})
      };
      syncWorkspaceSettings();
    }
  } catch (error) {
    console.error('Failed to save global settings:', error);
  }
}

async function setTheme(themeId) {
  try {
    const response = await fetch(`/api/themes/${themeId}/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      currentTheme = themeId;
      // 重新加载页面应用新主题
      location.reload();
    }
  } catch (error) {
    console.error('Failed to set theme:', error);
  }
}

async function saveThemeSettings() {
  try {
    const response = await fetch(`/api/themes/${currentTheme}/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(themeSettings)
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log('Theme settings saved');
    }
  } catch (error) {
    console.error('Failed to save theme settings:', error);
  }
}

function applyCRTEffects(enabled) {
  const body = document.body;
  
  if (enabled) {
    body.classList.remove('no-crt');
  } else {
    body.classList.add('no-crt');
  }
}

function renderThemeList() {
  const container = document.getElementById('theme-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  availableThemes.forEach((theme, index) => {
    const item = document.createElement('div');
    item.className = 'theme-item';
    item.style.cssText = `
      border: 1px solid ${theme.id === currentTheme ? '#00ff00' : '#444'};
      padding: 10px;
      margin: 10px 0;
      cursor: pointer;
      background: ${theme.id === currentTheme ? '#1a2a1a' : '#1a1a1a'};
      position: relative;
    `;
    
    const keyNum = index < 9 ? index + 1 : 0;
    
    item.innerHTML = `
      <div style="position: absolute; top: 5px; right: 5px; background: #00ff00; color: #1a1a1a; padding: 2px 5px; font-size: 10px; font-weight: bold;">[${keyNum}]</div>
      <div style="font-weight: bold; color: #00ff00;">${theme.displayName}</div>
      <div style="font-size: 12px; color: #888; margin-top: 5px;">${theme.description}</div>
    `;
    
    item.onclick = () => setTheme(theme.id);
    container.appendChild(item);
  });
}

function initDisplaySettings() {
  const crtContainer = document.getElementById('crt-effects-container');
  const crtToggle = document.getElementById('crt-effects');
  
  if (crtContainer) {
    if (currentTheme === 'terminal') {
      crtContainer.style.display = 'block';
      if (crtToggle) {
        crtToggle.checked = themeSettings.crtEffects || false;
        crtToggle.onchange = () => {
          themeSettings.crtEffects = crtToggle.checked;
          applyCRTEffects(crtToggle.checked);
          saveThemeSettings();
        };
      }
    } else {
      crtContainer.style.display = 'none';
    }
  }
  
  if (themeSettings.crtEffects !== undefined) {
    applyCRTEffects(themeSettings.crtEffects);
  }
}

function initSessionEngineSettings() {
  const engineSelect = document.getElementById('coding-agent-engine');
  const skipPermissionCheckToggle = document.getElementById('skip-permission-check-by-default');
  const vtBaseUrlInput = document.getElementById('vt-base-url');
  const vtSettingsContainer = document.getElementById('vt-settings-container');

  if (!engineSelect || !skipPermissionCheckToggle || !vtBaseUrlInput || !vtSettingsContainer) return;

  engineSelect.value = globalSettings.codingAgentEngine || 'local';
  skipPermissionCheckToggle.checked = globalSettings.dangerouslySkipAgentPermissionsByDefault === true;
  vtBaseUrlInput.value = globalSettings.vtBaseUrl || 'http://localhost:4020';
  vtSettingsContainer.style.display = engineSelect.value === 'vt' ? 'block' : 'none';

  engineSelect.onchange = async () => {
    globalSettings.codingAgentEngine = engineSelect.value;
    vtSettingsContainer.style.display = engineSelect.value === 'vt' ? 'block' : 'none';
    await saveGlobalSettings();
  };

  skipPermissionCheckToggle.onchange = async () => {
    globalSettings.dangerouslySkipAgentPermissionsByDefault = skipPermissionCheckToggle.checked;
    await saveGlobalSettings();
  };

  vtBaseUrlInput.onchange = async () => {
    globalSettings.vtBaseUrl = vtBaseUrlInput.value.trim() || 'http://localhost:4020';
    vtBaseUrlInput.value = globalSettings.vtBaseUrl;
    await saveGlobalSettings();
  };
}

function showSettings() {
  renderThemeList();
  initDisplaySettings();
  initSessionEngineSettings();
  document.getElementById('settings-modal').classList.add('active');
}

function hideSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

function loadAgents() {
  fetch('/api/executables')
    .then(res => res.json())
    .then(data => {
      agents = data.agents || [];
      renderAgentList();
      console.log(`Loaded ${agents.length} CLI agents`);
    })
    .catch(err => console.error('Failed to load agents:', err));
}

function renderAgentList() {
  const container = document.getElementById('agent-list');
  
  if (agents.length === 0) {
    container.innerHTML = '<p style="color: #888; font-size: 12px;">No CLI agents found in PATH</p>';
    return;
  }
  
  container.innerHTML = '';

  const groups = [
    {
      title: 'coding agents',
      items: agents
        .map((agent, index) => ({ agent, index }))
        .filter(({ agent }) => agent.category === 'coding')
    },
    {
      title: 'others',
      items: agents
        .map((agent, index) => ({ agent, index }))
        .filter(({ agent }) => agent.category !== 'coding')
    }
  ];

  groups.forEach((group) => {
    if (group.items.length === 0) return;

    const title = document.createElement('div');
    title.className = 'agent-list-group-title';
    title.textContent = group.title;
    container.appendChild(title);

    group.items.forEach(({ agent, index }) => {
      const item = document.createElement('div');
      item.className = 'agent-item';
      item.dataset.index = index;
      
      const keyNum = index < 9 ? index + 1 : 0;
      
      item.innerHTML = `
        <div class="name">${agent.name}<span class="key-hint">[${keyNum}]</span></div>
        <div class="description">${agent.description}</div>
      `;
      
      item.onclick = () => selectAgent(index);
      container.appendChild(item);
    });
  });
}

function getRememberedWorkspace() {
  return normalizeWorkspaceValue(globalSettings.workspace);
}

function needsMainAgent(currentState = state) {
  const mainAgent = currentState && currentState.mainAgentId
    ? currentState.agents.find((agent) => agent.id === currentState.mainAgentId)
    : null;
  return !currentState || !currentState.mainAgentId || (mainAgent && mainAgent.status === 'dead');
}

function getDefaultWorkspaceForDialog(asMainAgent) {
  return asMainAgent ? getRememberedWorkspace() : '';
}

function resolveWorkspaceToStart(workspaceInput, asMainAgent) {
  const normalizedInput = normalizeWorkspaceValue(workspaceInput);
  if (normalizedInput) {
    return normalizedInput;
  }

  return asMainAgent ? (getDefaultWorkspaceForDialog(true) || null) : null;
}

function normalizeWorkspaceValue(workspace) {
  return typeof workspace === 'string' ? workspace.trim() : '';
}

function shouldRememberWorkspace(workspace) {
  const value = normalizeWorkspaceValue(workspace);
  return Boolean(value)
    && value !== '/tmp'
    && !value.startsWith('/tmp/')
    && value !== '/private/tmp'
    && !value.startsWith('/private/tmp/')
    && value !== '/var/tmp'
    && !value.startsWith('/var/tmp/')
    && value !== '/private/var/tmp'
    && !value.startsWith('/private/var/tmp/')
    && value !== '/var/folders'
    && !value.startsWith('/var/folders/')
    && value !== '/private/var/folders'
    && !value.startsWith('/private/var/folders/');
}

function buildWorkspaceHistory(workspace, history = []) {
  const merged = [workspace, ...(Array.isArray(history) ? history : [])]
    .map(normalizeWorkspaceValue)
    .filter((entry) => shouldRememberWorkspace(entry));
  const deduped = [];
  const seen = new Set();

  merged.forEach((entry) => {
    if (seen.has(entry)) {
      return;
    }
    seen.add(entry);
    deduped.push(entry);
  });

  return deduped.slice(0, MAX_WORKSPACE_HISTORY);
}

function syncWorkspaceSettings() {
  const history = buildWorkspaceHistory(globalSettings.workspace, globalSettings.workspaceHistory);
  globalSettings.workspaceHistory = history;
  const normalizedWorkspace = normalizeWorkspaceValue(globalSettings.workspace);
  globalSettings.workspace = shouldRememberWorkspace(normalizedWorkspace)
    ? (history[0] || normalizedWorkspace)
    : (history[0] || '');
}

function getWorkspaceHistory() {
  if (!Array.isArray(globalSettings.workspaceHistory)) {
    return [];
  }
  return globalSettings.workspaceHistory;
}

function rememberWorkspace(workspace) {
  if (!shouldRememberWorkspace(workspace)) {
    return;
  }
  const history = buildWorkspaceHistory(workspace, getWorkspaceHistory());
  globalSettings.workspaceHistory = history;
}

function formatWorkspaceForDisplay(workspace) {
  const value = normalizeWorkspaceValue(workspace);
  if (!value) {
    return '~/.farming';
  }

  const homeDir = '/Users/';
  if (value.startsWith(homeDir)) {
    const parts = value.split('/');
    if (parts.length > 3) {
      return `~/${parts.slice(3).join('/')}`;
    }
  }

  return value;
}

function syncWorkspaceHistorySelectionWithInput() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) return;
  const currentValue = normalizeWorkspaceValue(workspaceInput.value);
  workspaceHistorySelection = getWorkspaceHistory().findIndex((entry) => entry === currentValue);
  renderWorkspaceHistoryUI();
}

function resetWorkspaceHistorySelection() {
  workspaceHistorySelection = -1;
  workspaceHistoryExpanded = false;
  renderWorkspaceHistoryUI();
}

function selectWorkspaceHistory(index, { focusInput = true } = {}) {
  const history = getWorkspaceHistory();
  if (!history.length) {
    return false;
  }

  const normalizedIndex = ((index % history.length) + history.length) % history.length;
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) {
    return false;
  }

  workspaceHistorySelection = normalizedIndex;
  workspaceHistoryExpanded = true;
  workspaceInput.value = history[normalizedIndex];
  workspaceInput.placeholder = history[normalizedIndex];
  renderWorkspaceHistoryUI();

  if (focusInput) {
    workspaceInput.focus();
    workspaceInput.setSelectionRange(workspaceInput.value.length, workspaceInput.value.length);
  }

  return true;
}

function moveWorkspaceHistorySelection(direction) {
  const history = getWorkspaceHistory();
  if (!history.length) {
    return false;
  }

  workspaceHistoryExpanded = true;
  const nextIndex = workspaceHistorySelection === -1
    ? (direction > 0 ? 0 : history.length - 1)
    : workspaceHistorySelection + direction;
  return selectWorkspaceHistory(nextIndex);
}

function renderWorkspaceHistoryUI() {
  const wrapper = document.getElementById('workspace-history');
  const list = document.getElementById('workspace-history-list');
  if (!wrapper || !list) return;

  const history = getWorkspaceHistory();
  list.innerHTML = '';

  if (!history.length) {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = workspaceHistoryExpanded ? 'block' : 'none';

  if (!workspaceHistoryExpanded) {
    return;
  }

  history.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'workspace-history-item';
    if (index === workspaceHistorySelection) {
      item.classList.add('active');
    }
    item.innerHTML = `
      <span class="workspace-history-index">[${index + 1}]</span>
      <span class="workspace-history-path">${formatWorkspaceForDisplay(entry)}</span>
      ${index === 0 ? '<span class="workspace-history-badge">latest</span>' : ''}
    `;
    item.onmousedown = (event) => {
      event.preventDefault();
      selectWorkspaceHistory(index);
    };
    list.appendChild(item);
  });
}

function refreshWorkspaceMemoryUI() {
  renderWorkspaceHistoryUI();
}

function seedWorkspaceInput() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) return;
  workspaceInput.value = '';
  workspaceInput.placeholder = pendingMainAgentLaunch
    ? formatWorkspaceForDisplay(getDefaultWorkspaceForDialog(true))
    : '/path/to/workspace';
  workspaceHistorySelection = -1;
  refreshWorkspaceMemoryUI();
}

function setupWorkspaceHistoryControls() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput || workspaceInput.dataset.historyReady === 'true') {
    return;
  }

  workspaceInput.dataset.historyReady = 'true';

  workspaceInput.addEventListener('focus', () => {
    syncWorkspaceHistorySelectionWithInput();
  });

  workspaceInput.addEventListener('input', () => {
    syncWorkspaceHistorySelectionWithInput();
    if (!workspaceInput.value.trim()) {
      workspaceHistorySelection = -1;
    }
    workspaceHistoryExpanded = false;
    renderWorkspaceHistoryUI();
  });

  workspaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      if (moveWorkspaceHistorySelection(1)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      if (moveWorkspaceHistorySelection(-1)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      confirmStartAgent();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      backToAgentList();
    }
  });
}

async function confirmStartAgent() {
  if (waitingForAgent || selectedAgentIndex === null || selectedAgentIndex < 0 || selectedAgentIndex >= agents.length) return;
  
  const agent = agents[selectedAgentIndex];
  const workspaceInput = normalizeWorkspaceValue(document.getElementById('workspace-input').value);
  const asMainAgent = pendingMainAgentLaunch;
  const workspaceToUse = resolveWorkspaceToStart(workspaceInput, asMainAgent);
  
  console.log('Starting agent:', agent.name, 'workspace:', workspaceToUse || 'default');
  
  waitingForAgent = true;
  const previousHistory = JSON.stringify(getWorkspaceHistory());
  if (workspaceToUse) {
    rememberWorkspace(workspaceToUse);
  }
  if (JSON.stringify(getWorkspaceHistory()) !== previousHistory) {
    refreshWorkspaceMemoryUI();
    await saveGlobalSettings();
  }
  
  ws.send(JSON.stringify({
    type: 'start-agent',
    command: agent.name,
    workspace: workspaceToUse,
    asMain: asMainAgent
  }));
}

function backToAgentList() {
  selectedAgentIndex = null;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  resetWorkspaceHistorySelection();
}

function selectAgent(index) {
  if (index < 0 || index >= agents.length) return;
  
  const agent = agents[index];

  console.log('Selected agent:', agent.name);
  selectedAgentIndex = index;
  
  if (pendingMainAgentLaunch) {
    document.getElementById('agent-list').style.display = 'none';
    document.getElementById('workspace-input-container').style.display = 'none';
    
    setTimeout(() => {
      confirmStartAgent();
    }, 100);
  } else {
    document.getElementById('agent-list').style.display = 'none';
    document.getElementById('workspace-input-container').style.display = 'block';
    seedWorkspaceInput();
    const workspaceInput = document.getElementById('workspace-input');
    workspaceInput.focus();
    workspaceInput.setSelectionRange(workspaceInput.value.length, workspaceInput.value.length);
  }
}

function connect() {
  loadThemes();
  loadGlobalSettings();
  
  ws = new WebSocket(`ws://${location.hostname}:${location.port}`);
  
  ws.onopen = () => {
    console.log('Connected to server');
    loadAgents();
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'state') {
      const prevAgentCount = state ? state.agents.length : 0;
      state = data.state;
      renderState();
      generateKeyMap();
      checkMainAgentStatus();
      
      if (waitingForAgent && state.agents.length > prevAgentCount) {
        waitingForAgent = false;
        hideInputDialog();
      }
      const runtime = getSessionRuntime();
      if (runtime) {
        const sessionState = runtime.handleStateMessage(state);
        focusedAgentId = sessionState.focusedAgentId;
      }
    } else if (data.type === 'session-output') {
      const runtime = getSessionRuntime();
      const sessionToken = runtime ? runtime.getSessionToken() : 0;
      const runtimeResult = runtime ? runtime.handleStreamMessage(data.stream) : null;
      const patch = runtimeResult
        ? runtimeResult.patch
        : deriveSessionStreamPatch(data.stream, focusedAgentId, getActiveSessionSource());
      const shouldApply = runtime
        ? runtime.isCurrentSession(runtimeResult.focusedAgentId, sessionToken)
        : Boolean(focusedAgentId && focusedAgentId === data.stream.agentId);
      if (patch && terminal && shouldApply) {
        terminal.write(patch.text);
        refreshSessionTerminalUi({ preserveSearchIndex: true });
        if (runtimeResult) {
          focusedAgentId = runtimeResult.focusedAgentId;
        } else if (focusedAgentId) {
          setSessionOutputLength(getSessionOutputLength() + patch.nextLengthDelta);
        }
      }
    } else if (data.type === 'system-stats') {
      updateSystemStats(data.stats, data.uptime);
    } else if (data.type === 'error') {
      waitingForAgent = false;
      alert('Error: ' + data.message);
    }
  };
  
  ws.onclose = () => {
    console.log('Disconnected from server');
    setTimeout(connect, 1000);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function checkMainAgentStatus() {
  if (!state) return;
  
  const mainAgent = state.mainAgentId 
    ? state.agents.find(a => a.id === state.mainAgentId)
    : null;
  
  if (!state.mainAgentId || (mainAgent && mainAgent.status === 'dead')) {
    showInputDialog();
  }
}

function updateSystemStats(stats, uptime) {
  if (stats.cpu !== undefined) {
    document.getElementById('cpu-usage').textContent = stats.cpu;
  }
  
  if (stats.memory) {
    document.getElementById('mem-percentage').textContent = stats.memory.percentage;
  }
  
  if (uptime !== undefined) {
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    let uptimeStr = '';
    if (hours > 0) {
      uptimeStr = `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      uptimeStr = `${minutes}m ${seconds}s`;
    } else {
      uptimeStr = `${seconds}s`;
    }
    
    document.getElementById('uptime').textContent = uptimeStr;
  }
}

function renderState() {
  if (!state) return;
  
  // 更新吊顶的 Agent 数量
  const activeAgents = state.agents.filter(a => a.status === 'running').length;
  const totalAgents = state.agents.length;
  document.getElementById('active-agents').textContent = activeAgents;
  document.getElementById('total-agents').textContent = totalAgents;
  
  const mapArea = document.getElementById('map-area');
  const emptyState = document.getElementById('empty-state');
  const mainAgentPanel = document.getElementById('main-agent-panel');
  const mainAgentBlock = document.getElementById('main-agent-block');
  
  const agentBlocks = mapArea.querySelectorAll('.agent-block');
  agentBlocks.forEach(block => block.remove());
  
  mainAgentBlock.innerHTML = '';
  
  if (state.agents.length === 0) {
    emptyState.style.display = 'flex';
    mainAgentPanel.style.display = 'none';
    showInputDialog();
    return;
  }
  
  emptyState.style.display = 'none';
  
  // 渲染 Main Agent 到右下角
  if (state.mainAgentId) {
    const mainAgent = state.agents.find(a => a.id === state.mainAgentId);
    if (mainAgent) {
      mainAgentPanel.style.display = 'block';
      
      const header = document.createElement('div');
      header.className = 'agent-header';
      header.textContent = mainAgent.command.split(' ')[0];
      mainAgentBlock.appendChild(header);
      
      const status = document.createElement('div');
      status.className = 'agent-status';
      status.textContent = `${mainAgent.status} | ${mainAgent.activityLevel}`;
      mainAgentBlock.appendChild(status);
      
      const output = document.createElement('div');
      output.className = 'agent-output';
      output.style.height = '80px';
      const cleanOutput = getAgentDisplayText(mainAgent);
      output.textContent = cleanOutput.slice(-150) || 'No output yet...';
      mainAgentBlock.appendChild(output);
      
      mainAgentBlock.onclick = () => openSession(mainAgent.id);
    } else {
      mainAgentPanel.style.display = 'none';
    }
  } else {
    mainAgentPanel.style.display = 'none';
  }
  
  // 渲染其他普通 agents 到地图
  let keyIndex = 1;
  state.agents.forEach((agent) => {
    if (agent.id === state.mainAgentId) return; // 跳过 Main Agent
    
    const block = document.createElement('div');
    block.className = `agent-block ${agent.activityLevel} ${agent.status}`;
    block.dataset.agentId = agent.id;
    
    const keyHint = document.createElement('div');
    keyHint.className = 'key-hint';
    keyHint.textContent = `[${keyIndex}]`;
    block.appendChild(keyHint);
    
    const header = document.createElement('div');
    header.className = 'agent-header';
    header.textContent = agent.command.split(' ')[0];
    block.appendChild(header);
    
    const status = document.createElement('div');
    status.className = 'agent-status';
    status.textContent = `${agent.status} | ${agent.activityLevel} | ${agent.cwd}`;
    block.appendChild(status);
    
    const output = document.createElement('div');
    output.className = 'agent-output';
    const cleanOutput = getAgentDisplayText(agent);
    output.textContent = cleanOutput.slice(-200) || 'No output yet...';
    block.appendChild(output);
    
    block.onclick = () => openSession(agent.id);
    
    mapArea.appendChild(block);
    keyIndex++;
  });
}

function generateKeyMap() {
  if (!state) return;
  
  keyMap = {};
  let keyIndex = 1;
  state.agents.forEach((agent) => {
    if (agent.id === state.mainAgentId) return; // 跳过 Main Agent
    keyMap[keyIndex] = agent.id;
    keyIndex++;
  });
}

function showInputDialog() {
  const title = document.getElementById('dialog-title');
  const cancelButtonContainer = document.getElementById('cancel-button-container');
  const needMainAgent = needsMainAgent();
  pendingMainAgentLaunch = needMainAgent;
  
  if (needMainAgent) {
    title.textContent = 'Start Main Agent';
    cancelButtonContainer.style.display = 'none';
  } else {
    title.textContent = 'Start New Agent';
    cancelButtonContainer.style.display = 'block';
  }
  
  selectedAgentIndex = null;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  document.getElementById('map-area').classList.add('hidden');
  document.getElementById('input-dialog').classList.add('active');
  resetWorkspaceHistorySelection();
  refreshWorkspaceMemoryUI();
}

function hideInputDialog() {
  const needMainAgent = needsMainAgent();
  
  if (needMainAgent) {
    return;
  }
  
  selectedAgentIndex = null;
  pendingMainAgentLaunch = false;
  waitingForAgent = false;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  document.getElementById('input-dialog').classList.remove('active');
  document.getElementById('map-area').classList.remove('hidden');
  resetWorkspaceHistorySelection();
}

function teardownSessionSurface() {
  stopSessionViewPolling();
  disposeTerminal();
  destroyTerminalInputBridge();
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.resetTerminalShell) {
    SESSION_MODAL_BRIDGE.resetTerminalShell(document);
    return;
  }

  const domState = getSessionModalDomState(document);
  if (domState.terminalContainer) {
    domState.terminalContainer.innerHTML = '';
    domState.terminalContainer.textContent = '';
  }
}

async function openSession(agentId) {
  if (!state) return;
  
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) return;

  const sessionModal = document.getElementById('session-modal');
  if (sessionModal && sessionModal.classList.contains('active')) {
    closeSession();
  }

  const modalState = createSessionModalState(agent, currentTheme, themeSettings);
  const runtime = getSessionRuntime();
  focusedAgentId = modalState.agentId;
  currentSessionTitle = modalState.title;
  resetSessionUiState();
  setupSessionSearchControls();
  const openResult = runtime ? runtime.open(document, modalState) : null;
  const sessionToken = runtime ? openResult.sessionToken : 0;
  if (runtime) {
    syncSessionRuntimeState();
  }
  updateSessionTitleDisplay(modalState.title);
  
  // 更新吊顶的"当前关注地域"
  const focusRegion = document.getElementById('focus-region');
  const focusRegionName = document.getElementById('focus-region-name');
  if (focusRegion && focusRegionName) {
    focusRegion.style.display = 'block';
    focusRegionName.textContent = agent.command.split(' ')[0];
  }
  
  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.focusAgent(agentId);
  }
  
  currentSessionSkin = modalState.sessionSkin;
  const domState = runtime
    ? openResult.domState
    : (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.openShell
      ? SESSION_MODAL_BRIDGE.openShell(document, modalState)
      : getSessionModalDomState(document));
  const terminalContainer = domState.terminalContainer;
  
  const terminalBundle = await createTerminalInstance();
  if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
    return;
  }
  if (!terminalBundle) {
    terminalContainer.innerHTML = '';
    terminalContainer.textContent = '';
    await refreshSessionView(true, agentId, sessionToken);
    if (shouldPollSessionView(modalState.sessionSource)) {
      startSessionViewPolling(agentId, sessionToken);
    }
    return;
  }

  disposeTerminal();
  const mountedTerminal = SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.mountTerminal
    ? SESSION_MODAL_BRIDGE.mountTerminal(document, terminalBundle, {
        initialOutput: runtime ? runtime.prepareInitialOutput(agent.output) : agent.output,
        onData: (data) => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          sendTerminalInput(data);
        },
        onResize: (cols, rows) => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          if (!focusedAgentId) return;
          const sessionClient = getSessionClient();
          if (!sessionClient) return;
          sessionClient.resizeAgent(focusedAgentId, cols, rows);
        },
        hasSelection: hasAnySelection,
        focusTerminal: focusSessionTerminal,
        isSessionActive: () => runtime ? runtime.isCurrentSession(agentId, sessionToken) : focusedAgentId === agentId,
        afterFit: () => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          sendSessionResize(agentId);
        }
      })
    : null;

  if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
    if (terminalBundle.terminal && typeof terminalBundle.terminal.dispose === 'function') {
      terminalBundle.terminal.dispose();
    }
    return;
  }

  terminal = mountedTerminal ? mountedTerminal.terminal : terminalBundle.terminal;
  fitAddon = mountedTerminal ? mountedTerminal.fitAddon : terminalBundle.fitAddon;
  registerTerminalLinks(terminal);
  if (terminal && typeof terminal.onTitleChange === 'function') {
    terminal.onTitleChange((title) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      updateSessionTitleDisplay(title || modalState.title);
    });
  }
  if (terminal && typeof terminal.onSelectionChange === 'function') {
    terminal.onSelectionChange(() => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      updateSessionSelectionStatus();
    });
  }
  if (runtime) {
    runtime.setLastOutputLength(mountedTerminal ? mountedTerminal.outputLength : (runtime.prepareInitialOutput(agent.output)).length);
    syncSessionRuntimeState();
  }
  setupTerminalInputBridge();

  if (!mountedTerminal) {
    terminal.loadAddon(fitAddon);
    terminal.onData((data) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      sendTerminalInput(data);
    });
    terminal.onResize(({ cols, rows }) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!focusedAgentId) return;
      const sessionClient = getSessionClient();
      if (!sessionClient) return;
      sessionClient.resizeAgent(focusedAgentId, cols, rows);
    });

    terminalContainer.innerHTML = '';
    terminal.open(terminalContainer);
    const restoreTerminalFocus = () => {
      if (hasAnySelection()) {
        return;
      }
      requestAnimationFrame(() => {
        focusSessionTerminal();
      });
    };
    terminalContainer.onclick = restoreTerminalFocus;
    terminalContainer.onwheel = restoreTerminalFocus;
    terminalContainer.onmouseup = restoreTerminalFocus;
    terminalContainer.ontouchstart = restoreTerminalFocus;
    requestAnimationFrame(() => {
      if (!terminal || !fitAddon) return;
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      fitAddon.fit();
      const initialOutput = runtime ? runtime.prepareInitialOutput(agent.output) : agent.output;
      if (initialOutput) {
        terminal.write(initialOutput);
      }
      refreshSessionTerminalUi();
      sendSessionResize(agentId);
      terminal.scrollToBottom();
      focusSessionTerminal();
    });
  }
  
  if (mountedTerminal && mountedTerminal.readyPromise) {
    await mountedTerminal.readyPromise;
    if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
      return;
    }
    refreshSessionTerminalUi();
  }

  await refreshSessionView(true, agentId, sessionToken);
  if (shouldPollSessionView(modalState.sessionSource)) {
    startSessionViewPolling(agentId, sessionToken);
  }
}

function closeSession() {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.close(document);
    syncSessionRuntimeState();
  } else if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.closeShell) {
    SESSION_MODAL_BRIDGE.closeShell(document);
  } else {
    const domState = getSessionModalDomState(document);
    domState.modal.classList.remove('active');
    document.body.classList.remove('session-open');
    if (window.FarmingSkinBridge) {
      window.FarmingSkinBridge.applySessionSkin(document, null);
    }
  }
  currentSessionSkin = null;
  focusedAgentId = null;
  teardownSessionSurface();
  resetSessionUiState();
  updateSessionTitleDisplay('Agent Session');
  
  // 隐藏吊顶的"当前关注地域"
  const focusRegion = document.getElementById('focus-region');
  if (focusRegion) {
    focusRegion.style.display = 'none';
  }
}

function killCurrentAgent() {
  if (!focusedAgentId) return;

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.killAgent(focusedAgentId);
  }
  
  closeSession();
}

function sendTerminalInput(input) {
  if (!focusedAgentId) return;

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.sendInput(focusedAgentId, input);
  }
}

function sendSessionResize(agentId = focusedAgentId) {
  if (!agentId || !terminal) return;
  if (!Number.isFinite(terminal.cols) || !Number.isFinite(terminal.rows)) return;
  const sessionClient = getSessionClient();
  if (!sessionClient) return;
  sessionClient.resizeAgent(agentId, terminal.cols, terminal.rows);
}

async function refreshSessionView(forceReplace = false, expectedAgentId = focusedAgentId, expectedSessionToken = getCurrentSessionToken()) {
  if (!expectedAgentId || !terminal) return;

  const runtime = getSessionRuntime();
  try {
    const sessionClient = getSessionClient();
    if (!sessionClient) return;
    const payload = await sessionClient.getSessionView(expectedAgentId);
    if (runtime && !runtime.isCurrentSession(expectedAgentId, expectedSessionToken)) {
      return;
    }
    const currentAgent = state && state.agents
      ? state.agents.find((agent) => agent.id === expectedAgentId)
      : null;
    const sessionView = normalizeSessionViewPayload(payload, currentAgent);
    const patch = deriveSessionTextPatch(sessionView.output, getSessionOutputLength(), forceReplace);

    if (patch.mode === 'replace') {
      terminal.clear();
      terminal.write(patch.text);
      refreshSessionTerminalUi({ preserveSearchIndex: true });
      if (runtime) {
        runtime.markHydrated(patch.nextLength);
        syncSessionRuntimeState();
      }
      return;
    }

    if (patch.mode === 'append') {
      terminal.write(patch.text);
      refreshSessionTerminalUi({ preserveSearchIndex: true });
      if (runtime) {
        if (isAwaitingInitialSessionSync()) {
          runtime.markHydrated(patch.nextLength);
        } else {
          runtime.setLastOutputLength(patch.nextLength);
        }
        syncSessionRuntimeState();
      }
    }
  } catch (error) {
    console.error('Failed to refresh session view:', error);
    if (runtime && runtime.isCurrentSession(expectedAgentId, expectedSessionToken) && runtime.isAwaitingInitialSync()) {
      runtime.markHydrated(getSessionOutputLength());
      syncSessionRuntimeState();
    }
  }
}

function startSessionViewPolling(agentId = focusedAgentId, sessionToken = getCurrentSessionToken()) {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.startPolling({ agentId, sessionToken });
    return;
  }
  stopSessionViewPolling();
  legacySessionPoller = setInterval(() => {
    refreshSessionView(false, agentId, sessionToken);
  }, 350);
}

function stopSessionViewPolling() {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.stopPolling();
    return;
  }
  if (legacySessionPoller) {
    clearInterval(legacySessionPoller);
    legacySessionPoller = null;
  }
}

if (typeof document !== 'undefined') {
  window.addEventListener('resize', () => {
    if (!terminal || !fitAddon || !focusedAgentId) return;

    fitAddon.fit();
    sendSessionResize();
  });

  document.addEventListener('keydown', (e) => {
    const dialogActive = document.getElementById('input-dialog').classList.contains('active');
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    const settingsActive = document.getElementById('settings-modal').classList.contains('active');
    const workspaceInputVisible = document.getElementById('workspace-input-container').style.display !== 'none';
    const workspaceInputFocused = document.activeElement === document.getElementById('workspace-input');
    
    if (settingsActive) {
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9) {
        const index = num - 1;
        if (index < availableThemes.length) {
          setTheme(availableThemes[index].id);
          e.preventDefault();
          return;
        }
      }
      if (e.key === '0' && availableThemes.length >= 10) {
        setTheme(availableThemes[9].id);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        hideSettings();
        e.preventDefault();
        return;
      }
    }
    
    if (dialogActive) {
      if (workspaceInputVisible) {
        if (workspaceInputFocused) {
          return;
        }
        if (e.key === 'ArrowDown') {
          if (moveWorkspaceHistorySelection(1)) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'ArrowUp') {
          if (moveWorkspaceHistorySelection(-1)) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Enter') {
          confirmStartAgent();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          backToAgentList();
          e.preventDefault();
          return;
        }
      } else {
        if (agents.length > 0) {
          const num = parseInt(e.key);
          if (num >= 1 && num <= 9) {
            const index = num - 1;
            if (index < agents.length) {
              selectAgent(index);
              e.preventDefault();
              return;
            }
          }
          if (e.key === '0' && agents.length >= 10) {
            selectAgent(9);
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Escape') {
          hideInputDialog();
          e.preventDefault();
          return;
        }
      }
    }
    
    if (e.key === 'n' || e.key === 'N') {
      if (!dialogActive && !sessionActive) {
        showInputDialog();
        e.preventDefault();
      }
    }
    
    if (e.key === '0') {
      if (!dialogActive && !sessionActive && state && state.mainAgentId) {
        openSession(state.mainAgentId);
        e.preventDefault();
      }
    }
    
    if (e.key === 's' || e.key === 'S') {
      if (!dialogActive && !sessionActive && !settingsActive) {
        showSettings();
        e.preventDefault();
      }
    }
    
    if (sessionActive) {
      if (isCopyShortcut(e)) {
        if (hasAnySelection()) {
          e.preventDefault();
          e.stopPropagation();
          copyTerminalSelection();
          return;
        }
        if (e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          sendTerminalInput('\x03');
          return;
        }
        return;
      }
      if (isPasteShortcut(e)) {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (isBrowserShortcut(e)) {
        return;
      }
      if (e.isComposing || terminalInputComposing) {
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Escape') {
        closeSession();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        killCurrentAgent();
        e.preventDefault();
        return;
      }
      if (
        SESSION_INPUT_SETTINGS.imeEnabled &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        document.activeElement !== terminalInputBridge
      ) {
        e.preventDefault();
        schedulePrintableInput(e.key);
        focusTerminalInputBridge();
        return;
      }
      if (routeSessionKey(e)) {
        e.preventDefault();
        focusTerminalInputBridge();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && e.key === 'Escape') {
        sendTerminalInput('\x1b');
        e.preventDefault();
        return;
      }
      return;
    }
    
    if (keyMap[e.key] && !sessionActive && !dialogActive) {
      openSession(keyMap[e.key]);
      e.preventDefault();
    }
    
  }, true);

  document.addEventListener('copy', (e) => {
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    if (!sessionActive) {
      return;
    }

    const text = getTerminalSelectionText() || getDocumentSelectionText();
    if (!text) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setClipboardText(e, text);
  }, true);

  document.addEventListener('paste', (e) => {
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    if (!sessionActive) {
      return;
    }

    const pastedText = e.clipboardData && e.clipboardData.getData
      ? e.clipboardData.getData('text/plain')
      : '';

    if (!pastedText) {
      return;
    }

    e.preventDefault();
    pasteTerminalText(pastedText);
  }, true);

}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isBrowserShortcut,
    isCopyShortcut,
    isPasteShortcut,
    getTerminalSequenceForKey,
    shouldUseLiveSessionText,
    shouldPollSessionView,
    deriveSessionTextPatch,
    normalizeSessionViewPayload,
    deriveSessionStreamPatch,
    getAgentDisplayText,
    extractSessionLinks,
    formatSelectionStatus,
    deriveSessionSearchMatchesFromLines,
    buildWorkspaceHistory,
    shouldRememberWorkspace,
    normalizeWorkspaceValue,
    needsMainAgent,
    getDefaultWorkspaceForDialog,
    resolveWorkspaceToStart,
    createSessionModalState,
    getSessionModalDomState
  };
} else {
  setupWorkspaceHistoryControls();
  connect();
}
