type MarkdownLine = {
  start: number
  content: string
}

type MarkdownFence = {
  marker: string
  length: number
}

type MarkdownDefinition = {
  source: string
  start: number
  end: number
}

type MarkdownHeading = {
  start: number
  depth: number
  value: string
}

export type LargeMarkdownSection = {
  source: string
  renderSource: string
  estimatedHeight: number
  headingIds: string[]
}

export function markdownHeadingSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
  return slug || 'heading'
}

function estimateSectionHeight(source: string) {
  let fence: MarkdownFence | null = null
  let visualLines = 0

  for (const line of source.split('\n')) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const fenceSequence = fenceMatch[1]
      const marker = fenceSequence?.[0]
      if (!fenceSequence || !marker) continue
      if (!fence) fence = { marker, length: fenceSequence.length }
      else if (marker === fence.marker && fenceSequence.length >= fence.length) fence = null
      visualLines += 1
      continue
    }
    visualLines += fence ? 1 : Math.max(1, Math.ceil(line.length / 96))
  }

  return Math.max(96, (visualLines * 18) + 32)
}

function markdownLines(source: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let start = 0
  while (start <= source.length) {
    const newline = source.indexOf('\n', start)
    if (newline < 0) {
      lines.push({ start, content: source.slice(start).replace(/\r$/, '') })
      break
    }
    lines.push({ start, content: source.slice(start, newline).replace(/\r$/, '') })
    start = newline + 1
  }
  return lines
}

function openingFence(line: string): MarkdownFence | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
  const sequence = match?.[1]
  const marker = sequence?.[0]
  return sequence && marker ? { marker, length: sequence.length } : null
}

function closesFence(line: string, fence: MarkdownFence) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
  const sequence = match?.[1]
  return Boolean(sequence && sequence[0] === fence.marker && sequence.length >= fence.length)
}

function atxHeading(line: string) {
  const match = line.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/)
  if (!match?.[1]) return null
  return {
    depth: match[1].length,
    value: (match[2] ?? '').replace(/[\t ]+#+[\t ]*$/, '').trim(),
  }
}

function inlineHeadingText(value: string) {
  return value
    .replace(/<((?:https?:\/\/|mailto:)[^ >]+)>/gi, (_, target: string) => target.replace(/^mailto:/i, ''))
    .replace(/<([^ <>@]+@[^ <>@]+)>/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, reference: string) => {
      const normalized = reference.toLowerCase()
      if (normalized === 'amp') return '&'
      if (normalized === 'lt') return '<'
      if (normalized === 'gt') return '>'
      if (normalized === 'quot') return '"'
      if (normalized === 'apos') return "'"
      const radix = normalized.startsWith('#x') ? 16 : 10
      const codePoint = Number.parseInt(normalized.slice(radix === 16 ? 2 : 1), radix)
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ''
    })
    .replace(/[`*_~]/g, '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
}

function isBlank(line: string) {
  return /^[\t ]*$/.test(line)
}

function canStartBoundedSection(line: string) {
  if (/^[\t ]/.test(line)) return false
  if (/^ {0,3}(?:>|[-+*][\t ]+|\d{1,9}[.)][\t ]+)/.test(line)) return false
  return true
}

function protectedMarkdownLineIndexes(lines: MarkdownLine[]) {
  const protectedLines = new Set<number>()
  let fence: MarkdownFence | null = null
  let mathBlock = false
  let htmlBlockEnd: RegExp | null = null

  lines.forEach((line, index) => {
    if (fence) {
      protectedLines.add(index)
      if (closesFence(line.content, fence)) fence = null
      return
    }
    if (mathBlock) {
      protectedLines.add(index)
      if (/^ {0,3}\$\$[\t ]*$/.test(line.content)) mathBlock = false
      return
    }
    if (htmlBlockEnd) {
      protectedLines.add(index)
      if (htmlBlockEnd.test(line.content)) htmlBlockEnd = null
      return
    }

    const nextFence = openingFence(line.content)
    if (nextFence) {
      protectedLines.add(index)
      fence = nextFence
      return
    }
    if (/^ {0,3}\$\$[\t ]*$/.test(line.content)) {
      protectedLines.add(index)
      mathBlock = true
      return
    }
    if (/^ {0,3}<!--/.test(line.content)) {
      protectedLines.add(index)
      if (!line.content.includes('-->')) htmlBlockEnd = /-->/
      return
    }
    const rawHtmlTag = line.content.match(/^ {0,3}<(pre|script|style|textarea)(?:[\t >]|$)/i)?.[1]
    if (!rawHtmlTag) return
    protectedLines.add(index)
    if (!new RegExp(`</${rawHtmlTag}>`, 'i').test(line.content)) {
      htmlBlockEnd = new RegExp(`</${rawHtmlTag}>`, 'i')
    }
  })

  return protectedLines
}

function canBeSetextHeadingLine(line: string) {
  if (!canStartBoundedSection(line)) return false
  if (/^ {0,3}(?:#{1,6}(?:[\t ]+|$)|\[[^\]]+\]:|<)/.test(line)) return false
  return true
}

function markdownHeadings(lines: MarkdownLine[], protectedLines: ReadonlySet<number>) {
  const headings: MarkdownHeading[] = []
  let paragraphLines: MarkdownLine[] = []

  lines.forEach((line, index) => {
    if (protectedLines.has(index) || isBlank(line.content)) {
      paragraphLines = []
      return
    }

    const heading = atxHeading(line.content)
    if (heading) {
      headings.push({ start: line.start, ...heading })
      paragraphLines = []
      return
    }

    const setext = line.content.match(/^ {0,3}(=+|-+)[\t ]*$/)?.[1]
    if (setext && paragraphLines.length > 0) {
      headings.push({
        start: paragraphLines[0]?.start ?? line.start,
        depth: setext[0] === '=' ? 1 : 2,
        value: paragraphLines.map(paragraphLine => paragraphLine.content.trim()).join('\n'),
      })
      paragraphLines = []
      return
    }

    if (canBeSetextHeadingLine(line.content)) paragraphLines.push(line)
    else paragraphLines = []
  })

  return headings
}

function sectionStarts(
  lines: MarkdownLine[],
  protectedLines: ReadonlySet<number>,
  headings: readonly MarkdownHeading[],
  maximumSectionBlocks: number,
) {
  const starts = [0]
  const blockLimit = Math.max(1, maximumSectionBlocks)
  const headingsByStart = new Map(headings.map(heading => [heading.start, heading]))
  let blocks = 0
  let afterBlank = true

  const beginBlock = (line: MarkdownLine, maySplit: boolean) => {
    if (blocks >= blockLimit && maySplit && line.start > (starts[starts.length - 1] ?? 0)) {
      starts.push(line.start)
      blocks = 0
    }
    blocks += 1
  }

  lines.forEach((line, index) => {
    if (isBlank(line.content)) {
      afterBlank = true
      return
    }
    if (protectedLines.has(index)) {
      if (!protectedLines.has(index - 1)) beginBlock(line, canStartBoundedSection(line.content))
      afterBlank = false
      return
    }

    const heading = headingsByStart.get(line.start)
    if (heading && heading.depth <= 2 && blocks > 0 && line.start > (starts[starts.length - 1] ?? 0)) {
      starts.push(line.start)
      blocks = 0
    }

    const startsNewBlock = afterBlank || blocks === 0 || Boolean(heading)
    if (startsNewBlock) beginBlock(line, canStartBoundedSection(line.content))
    afterBlank = Boolean(atxHeading(line.content))
  })

  return starts
}

function normalizeDefinitionIdentifier(value: string) {
  return value.trim().replace(/[\t\n ]+/g, ' ').toLowerCase()
}

function markdownDefinitions(source: string, lines: MarkdownLine[], protectedLines: ReadonlySet<number>) {
  const definitions = new Map<string, MarkdownDefinition>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || protectedLines.has(index)) continue
    const match = line.content.match(/^ {0,3}\[([^\]]+)\]:/)
    const identifier = match?.[1]
    if (!identifier) continue

    let endIndex = index + 1
    while (endIndex < lines.length) {
      const continuation = lines[endIndex]
      if (!continuation || !/^(?: {2,}|\t)\S/.test(continuation.content)) break
      endIndex += 1
    }
    const end = lines[endIndex]?.start ?? source.length
    definitions.set(normalizeDefinitionIdentifier(identifier), {
      source: source.slice(line.start, end).replace(/\n$/, ''),
      start: line.start,
      end,
    })
    index = endIndex - 1
  }
  return definitions
}

function referencedDefinitionsBySection(
  lines: readonly MarkdownLine[],
  protectedLines: ReadonlySet<number>,
  starts: readonly number[],
) {
  const referencesBySection = starts.map(() => new Set<string>())
  lines.forEach((line, index) => {
    if (protectedLines.has(index)) return
    const source = line.content.replace(/(`+).*?\1/g, '')
    const references = referencesBySection[sectionIndexForOffset(starts, line.start)]
    if (!references) return

    for (const match of source.matchAll(/!?\[([^\]]*)\]\[([^\]]*)\]|\[\^([^\]]+)\]/g)) {
      const identifier = match[3] ? `^${match[3]}` : (match[2] || match[1])
      if (identifier) references.add(normalizeDefinitionIdentifier(identifier))
    }
    for (const match of source.matchAll(/!?\[([^\]]+)\](?![[(])/g)) {
      const identifier = match[1]
      if (identifier) references.add(normalizeDefinitionIdentifier(identifier))
    }
  })
  return referencesBySection
}

function sectionIndexForOffset(starts: readonly number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? Number.POSITIVE_INFINITY) <= offset) low = middle
    else high = middle - 1
  }
  return low
}

function headingIdsBySection(headings: readonly MarkdownHeading[], starts: number[]) {
  const headingIds = starts.map(() => [] as string[])
  const headingCounts = new Map<string, number>()

  headings.forEach(heading => {
    const base = markdownHeadingSlug(inlineHeadingText(heading.value))
    const count = headingCounts.get(base) ?? 0
    headingCounts.set(base, count + 1)
    headingIds[sectionIndexForOffset(starts, heading.start)]?.push(count === 0 ? base : `${base}-${count}`)
  })

  return headingIds
}

export function splitLargeMarkdownSections(source: string, maximumSectionBlocks: number): LargeMarkdownSection[] {
  if (!source) {
    return [{ source, renderSource: source, estimatedHeight: estimateSectionHeight(source), headingIds: [] }]
  }

  // Large previews only need safe source boundaries before first paint. Parsing
  // the complete document into an mdast made opening time proportional to the
  // whole file even though only the first sections render. Visible sections
  // still use the full GFM and math pipeline in FileEditorMarkdownPreview.
  const lines = markdownLines(source)
  const protectedLines = protectedMarkdownLineIndexes(lines)
  const headings = markdownHeadings(lines, protectedLines)
  const starts = sectionStarts(lines, protectedLines, headings, maximumSectionBlocks)
  const definitions = markdownDefinitions(source, lines, protectedLines)
  const headingIds = headingIdsBySection(headings, starts)
  const referencesBySection = referencedDefinitionsBySection(lines, protectedLines, starts)

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? source.length
    const sectionSource = source.slice(start, end)
    const definitionSource = [...(referencesBySection[index] ?? [])]
      .map(identifier => definitions.get(identifier))
      .filter(definition => definition && (definition.start < start || definition.end > end))
      .map(definition => definition?.source)
      .filter((definition): definition is string => Boolean(definition))
      .join('\n\n')

    return {
      source: sectionSource,
      renderSource: definitionSource ? `${sectionSource}\n\n${definitionSource}` : sectionSource,
      estimatedHeight: estimateSectionHeight(sectionSource),
      headingIds: headingIds[index] ?? [],
    }
  })
}
