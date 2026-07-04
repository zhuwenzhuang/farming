const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInputPart(part) {
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

function normalizeTerminalInputParts(input) {
  const rawParts = Array.isArray(input) ? input : [input];
  return rawParts
    .map(normalizeInputPart)
    .filter(part => part !== null);
}

function inputPartsFromMessage(data) {
  if (Array.isArray(data && data.inputParts)) {
    return normalizeTerminalInputParts(data.inputParts);
  }
  return typeof (data && data.input) === 'string' ? [data.input] : [];
}

function terminalInputToPtyString(input) {
  return normalizeTerminalInputParts(input)
    .map(part => (
      typeof part === 'string'
        ? part
        : `${BRACKETED_PASTE_START}${part.text}${BRACKETED_PASTE_END}`
    ))
    .join('');
}

module.exports = {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  inputPartsFromMessage,
  normalizeInputPart,
  normalizeTerminalInputParts,
  terminalInputToPtyString,
};
