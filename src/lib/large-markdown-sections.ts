import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

type MarkdownNode = {
  type: string
  depth?: number
  identifier?: string
  value?: string
  children?: MarkdownNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
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
  let fence: { marker: string; length: number } | null = null
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

function nodeText(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value
  return node.children?.map(nodeText).join('') ?? ''
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void) {
  callback(node)
  node.children?.forEach(child => visit(child, callback))
}

function sectionIndexForOffset(starts: number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? Number.POSITIVE_INFINITY) <= offset) low = middle
    else high = middle - 1
  }
  return low
}

export function splitLargeMarkdownSections(source: string, maximumSectionBlocks: number): LargeMarkdownSection[] {
  // Segmentation only needs CommonMark block boundaries and source positions.
  // GFM and math are still applied when a visible section is rendered; running
  // those transforms over the complete oversized document needlessly delays
  // its first paint and creates a much larger temporary tree.
  const processor = unified().use(remarkParse)
  const tree = processor.runSync(processor.parse(source) as Root) as unknown as MarkdownNode
  const children = tree.children ?? []
  if (children.length === 0) {
    return [{
      source,
      renderSource: source,
      estimatedHeight: estimateSectionHeight(source),
      headingIds: [],
    }]
  }

  const starts = [0]
  let sectionBlocks = 0
  for (const child of children) {
    const offset = child.position?.start.offset
    const startsMajorSection = child.type === 'heading' && (child.depth ?? 7) <= 2
    if (
      sectionBlocks > 0
      && (sectionBlocks >= maximumSectionBlocks || startsMajorSection)
      && typeof offset === 'number'
      && offset > (starts[starts.length - 1] ?? 0)
    ) {
      starts.push(offset)
      sectionBlocks = 0
    }
    sectionBlocks += 1
  }

  const definitions = new Map<string, { source: string; start: number; end: number }>()
  for (const child of children) {
    if (child.type !== 'definition' && child.type !== 'footnoteDefinition') continue
    const identifier = child.identifier
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (!identifier || typeof start !== 'number' || typeof end !== 'number') continue
    definitions.set(identifier, { source: source.slice(start, end), start, end })
  }

  const headingIds = starts.map(() => [] as string[])
  const headingCounts = new Map<string, number>()
  visit(tree, node => {
    if (node.type !== 'heading') return
    const offset = node.position?.start.offset
    if (typeof offset !== 'number') return
    const base = markdownHeadingSlug(nodeText(node))
    const count = headingCounts.get(base) ?? 0
    headingCounts.set(base, count + 1)
    headingIds[sectionIndexForOffset(starts, offset)]?.push(count === 0 ? base : `${base}-${count}`)
  })

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? source.length
    const sectionSource = source.slice(start, end)
    const referencedDefinitions = new Set<string>()
    const sectionNodes = children.filter(child => {
      const childOffset = child.position?.start.offset
      return typeof childOffset === 'number' && childOffset >= start && childOffset < end
    })
    sectionNodes.forEach(node => visit(node, child => {
      if (
        (child.type === 'linkReference' || child.type === 'imageReference' || child.type === 'footnoteReference')
        && child.identifier
      ) {
        referencedDefinitions.add(child.identifier)
      }
    }))
    const definitionSource = [...referencedDefinitions]
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
