const { domainToUnicode } = require('url');

const BIDI_NAMES = new Map([
  [0x061c, 'arabic letter mark'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
]);

const INVISIBLE_NAMES = new Map([
  [0x00a0, 'no-break space'],
  [0x00ad, 'soft hyphen'],
  [0x180e, 'mongolian vowel separator'],
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x2060, 'word joiner'],
  [0x3000, 'ideographic space'],
  [0xfeff, 'zero-width no-break space'],
]);

function codePointLabel(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function scriptName(character) {
  const scripts = [
    ['Cyrillic', /\p{Script=Cyrillic}/u],
    ['Greek', /\p{Script=Greek}/u],
    ['Arabic', /\p{Script=Arabic}/u],
    ['Hebrew', /\p{Script=Hebrew}/u],
    ['Han', /\p{Script=Han}/u],
    ['Hiragana', /\p{Script=Hiragana}/u],
    ['Katakana', /\p{Script=Katakana}/u],
    ['Latin', /\p{Script=Latin}/u],
  ];
  return scripts.find(([, matcher]) => matcher.test(character))?.[0] || 'Unicode';
}

function classifyCharacter(character) {
  const point = character.codePointAt(0);
  if (BIDI_NAMES.has(point)) {
    return { character: '', codePoint: codePointLabel(character), kind: 'bidi-control', description: BIDI_NAMES.get(point) };
  }
  if (
    INVISIBLE_NAMES.has(point)
    || (point >= 0x2061 && point <= 0x2064)
    || (point >= 0x2000 && point <= 0x200a)
    || [0x1680, 0x202f, 0x205f].includes(point)
    || /\p{Control}|\p{Format}/u.test(character)
  ) {
    return {
      character: '',
      codePoint: codePointLabel(character),
      kind: 'invisible',
      description: INVISIBLE_NAMES.get(point) || 'invisible or formatting character',
    };
  }
  return {
    character,
    codePoint: codePointLabel(character),
    kind: 'confusable',
    description: `${scriptName(character)} character`,
  };
}

function scanUnicode(value) {
  const seen = new Set();
  const findings = [];
  for (const character of String(value || '')) {
    if (character.codePointAt(0) <= 0x7f || seen.has(character)) continue;
    seen.add(character);
    findings.push(classifyCharacter(character));
  }
  return findings;
}

function permissionSecurityWarnings(request) {
  const meta = { ...(request?._meta || {}), ...(request?.toolCall?._meta || {}) };
  const sandbox = meta.sandbox_authorization;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return [];
  const warnings = [];
  const add = (targetType, value, displayValue = value) => {
    const characters = scanUnicode(displayValue);
    if (characters.length > 0) warnings.push({ targetType, value, displayValue, characters });
  };
  for (const host of Array.isArray(sandbox.network_hosts) ? sandbox.network_hosts : []) {
    const value = String(host || '');
    add('host', value, domainToUnicode(value) || value);
  }
  for (const targetPath of Array.isArray(sandbox.write_paths) ? sandbox.write_paths : []) {
    add('path', String(targetPath || ''));
  }
  return warnings;
}

module.exports = {
  permissionSecurityWarnings,
  scanUnicode,
};
