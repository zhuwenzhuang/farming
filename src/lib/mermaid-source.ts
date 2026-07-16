const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"',
}

export function decodeMermaidCharacterReferences(source: string) {
  return source.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, decimal, hexadecimal, name) => {
    if (decimal || hexadecimal) {
      const value = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16)
      if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return match
      try {
        return String.fromCodePoint(value)
      } catch {
        return match
      }
    }
    return NAMED_CHARACTER_REFERENCES[String(name || '').toLowerCase()] ?? match
  })
}
