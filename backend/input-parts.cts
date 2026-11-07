const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

interface PasteInputPart {
  type: 'paste';
  text: string;
}

interface TerminalInputMessage {
  input?: unknown;
  inputParts?: unknown;
}

type TerminalInputPart = string | PasteInputPart;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInputPart(part: unknown): TerminalInputPart | null {
  if (typeof part === 'string') {
    return part;
  }

  if (isObject(part) && part.type === 'paste' && typeof part.text === 'string') {
    return {
      type: 'paste',
      text: part.text,
    };
  }

  return null;
}

function normalizeTerminalInputParts(input: unknown): TerminalInputPart[] {
  const rawParts = Array.isArray(input) ? input : [input];
  return rawParts
    .map(normalizeInputPart)
    .filter(part => part !== null);
}

function inputPartsFromMessage(data: TerminalInputMessage | null | undefined): TerminalInputPart[] {
  if (Array.isArray(data?.inputParts)) {
    return normalizeTerminalInputParts(data.inputParts);
  }
  return typeof data?.input === 'string' ? [data.input] : [];
}

function terminalInputToPtyString(input: unknown): string {
  return normalizeTerminalInputParts(input)
    .map(part => (
      typeof part === 'string'
        ? part
        : `${BRACKETED_PASTE_START}${part.text}${BRACKETED_PASTE_END}`
    ))
    .join('');
}

const DEFAULT_PTY_WRITE_CHUNK_BYTES = 512;

function splitPtyInputChunks(payload: string, maxChunkBytes = DEFAULT_PTY_WRITE_CHUNK_BYTES): string[] {
  if (!payload) return [];
  if (Buffer.byteLength(payload, 'utf8') <= maxChunkBytes) {
    return [payload];
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of payload) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + charBytes > maxChunkBytes) {
      const lastNewline = current.lastIndexOf('\n');
      if (lastNewline >= 0 && lastNewline < current.length - 1) {
        const lineChunk = current.slice(0, lastNewline + 1);
        chunks.push(lineChunk);
        current = current.slice(lastNewline + 1) + char;
        currentBytes = Buffer.byteLength(current, 'utf8');
      } else {
        chunks.push(current);
        current = char;
        currentBytes = charBytes;
      }
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  DEFAULT_PTY_WRITE_CHUNK_BYTES,
  inputPartsFromMessage,
  normalizeInputPart,
  normalizeTerminalInputParts,
  splitPtyInputChunks,
  terminalInputToPtyString,
};
