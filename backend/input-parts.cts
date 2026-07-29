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

export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  inputPartsFromMessage,
  normalizeInputPart,
  normalizeTerminalInputParts,
  terminalInputToPtyString,
};
