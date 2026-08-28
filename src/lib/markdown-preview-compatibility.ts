import katex from 'katex'
import type { Root as HastRoot } from 'hast'
import type { Root as MdastRoot } from 'mdast'
import type { Plugin } from 'unified'

type MutableMarkdownNode = {
  type: string
  value?: string
  meta?: string | null
  data?: Record<string, unknown>
  children?: MutableMarkdownNode[]
}

type MutableHastNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: MutableHastNode[]
  value?: string
}

type SimpleTableColumns = {
  starts: number[]
}

const PANDOC_ANCHOR_PATTERN = /\[\]\{#([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\}/g

function tableColumns(separator: string): SimpleTableColumns | null {
  if (!/^ {0,3}-{3,}(?:[ \t]+-{3,})+[ \t]*$/.test(separator)) return null
  const starts = [...separator.matchAll(/-{3,}/g)]
    .map(match => match.index)
    .filter((start): start is number => start !== undefined)
  return starts.length >= 2 ? { starts } : null
}

function characterDisplayWidth(character: string) {
  if (/\p{Mark}/u.test(character)) return 0
  return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(character)
    ? 2
    : 1
}

function displayColumnSlice(line: string, start: number, end = Number.POSITIVE_INFINITY) {
  let column = 0
  let result = ''
  for (const character of line) {
    const width = characterDisplayWidth(character)
    if (column >= start && column < end) result += character
    column += width
  }
  return result
}

function displayWidth(value: string) {
  let width = 0
  for (const character of value) width += characterDisplayWidth(character)
  return width
}

function boundaryCutsToken(line: string, boundary: number) {
  const before = displayColumnSlice(line, Math.max(0, boundary - 1), boundary)
  const after = displayColumnSlice(line, boundary, boundary + 1)
  return Boolean(before && after && !/\s/u.test(before) && !/\s/u.test(after))
}

function looselyAlignedCells(line: string, starts: readonly number[]) {
  const cells = starts.map(() => '')
  for (const match of line.matchAll(/\S(?:.*?\S)?(?=[ \t]{2,}|$)/g)) {
    if (match.index === undefined) continue
    const column = displayWidth(line.slice(0, match.index))
    let nearestIndex = 0
    for (let index = 1; index < starts.length; index += 1) {
      if (Math.abs((starts[index] ?? 0) - column) < Math.abs((starts[nearestIndex] ?? 0) - column)) {
        nearestIndex = index
      }
    }
    cells[nearestIndex] = cells[nearestIndex] ? `${cells[nearestIndex]} ${match[0]}` : match[0]
  }
  return cells
}

function fixedWidthCells(line: string, starts: readonly number[]) {
  if (starts.slice(1).some(start => boundaryCutsToken(line, start))) {
    return looselyAlignedCells(line, starts)
  }
  return starts.map((start, index) => displayColumnSlice(line, start, starts[index + 1]).trim())
}

function headerCells(line: string, starts: readonly number[]) {
  const tokens = line.trim().split(/[ \t]+/)
  return tokens.length === starts.length ? tokens : fixedWidthCells(line, starts)
}

function escapeTableCell(value: string) {
  let escaped = false
  let inlineMath = false
  let result = ''

  for (const character of value) {
    if (character === '$' && !escaped) inlineMath = !inlineMath
    if (character === '|' && !escaped) result += inlineMath ? '\\vert{}' : '\\|'
    else result += character
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
  }

  return result
}

function gfmTableRow(cells: readonly string[]) {
  return `| ${cells.map(escapeTableCell).join(' | ')} |`
}

function openingFence(line: string) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
  const sequence = match?.[1]
  const marker = sequence?.[0]
  return sequence && marker ? { marker, length: sequence.length } : null
}

function closesFence(line: string, fence: { marker: string; length: number }) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
  const sequence = match?.[1]
  return Boolean(sequence && sequence[0] === fence.marker && sequence.length >= fence.length)
}

function normalizedCompactDisplayMath(lines: readonly string[], start: number) {
  const normalizeMath = (value: string) => value.replace(
    /\\mspace\{([+-]?(?:\d+(?:\.\d*)?|\.\d+)mu)\}/g,
    '\\mskip$1',
  )
  const line = lines[start] ?? ''
  const singleLine = line.match(/^( {0,3})\$\$(.+)\$\$[ \t]*$/)
  if (singleLine?.[2]) {
    return {
      end: start,
      lines: [`${singleLine[1]}$$`, `${singleLine[1]}${normalizeMath(singleLine[2])}`, `${singleLine[1]}$$`],
    }
  }

  const opening = line.match(/^( {0,3})\$\$(\S.*)$/)
  if (!opening?.[2]) return null
  for (let end = start + 1; end < lines.length; end += 1) {
    if (!lines[end]?.trim()) return null
    const closing = lines[end]?.match(/^(.*\S)\$\$[ \t]*$/)
    if (!closing?.[1]) continue
    return {
      end,
      lines: [
        `${opening[1]}$$`,
        `${opening[1]}${normalizeMath(opening[2])}`,
        ...lines.slice(start + 1, end).map(normalizeMath),
        normalizeMath(closing[1]),
        `${opening[1]}$$`,
      ],
    }
  }
  return null
}

export function normalizeMarkdownPreviewSource(source: string) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let fence: { marker: string; length: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (fence) {
      output.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    const nextFence = openingFence(line)
    if (nextFence) {
      fence = nextFence
      output.push(line)
      continue
    }

    const compactDisplayMath = normalizedCompactDisplayMath(lines, index)
    if (compactDisplayMath) {
      output.push(...compactDisplayMath.lines)
      index = compactDisplayMath.end
      continue
    }

    const columns = tableColumns(line)
    const header = output[output.length - 1]
    if (!columns || header === undefined || !header.trim()) {
      output.push(line)
      continue
    }

    let bodyEnd = index + 1
    while (bodyEnd < lines.length && lines[bodyEnd]?.trim()) bodyEnd += 1
    const body = lines.slice(index + 1, bodyEnd)
    if (body.length === 0) {
      output.push(line)
      continue
    }

    output.pop()
    output.push(gfmTableRow(headerCells(header, columns.starts)))
    output.push(gfmTableRow(columns.starts.map(() => '---')))
    body.forEach(row => output.push(gfmTableRow(fixedWidthCells(row, columns.starts))))
    index = bodyEnd - 1
  }

  return output.join('\n')
}

function pandocAnchorNode(id: string): MutableMarkdownNode {
  return {
    type: 'emphasis',
    data: {
      hName: 'span',
      hProperties: {
        id,
        className: ['code-markdown-pandoc-anchor'],
      },
    },
    children: [],
  }
}

function splitPandocAnchors(value: string) {
  const children: MutableMarkdownNode[] = []
  let start = 0

  for (const match of value.matchAll(PANDOC_ANCHOR_PATTERN)) {
    const index = match.index
    const id = match[1]
    if (index === undefined || !id) continue
    if (index > start) children.push({ type: 'text', value: value.slice(start, index) })
    children.push(pandocAnchorNode(id))
    start = index + match[0].length
  }

  if (start < value.length) children.push({ type: 'text', value: value.slice(start) })
  return children
}

function transformMarkdownNode(node: MutableMarkdownNode) {
  const children = node.children
  if (!children || node.type === 'code' || node.type === 'inlineCode') return

  if (
    node.type === 'paragraph'
    && children.length === 1
    && children[0]?.type === 'text'
    && children[0].value
  ) {
    const match = children[0].value.match(/^\[\]\{#([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\}$/)
    const id = match?.[1]
    if (id) {
      node.data = pandocAnchorNode(id).data
      node.children = []
      return
    }
  }

  const nextChildren: MutableMarkdownNode[] = []
  for (const child of children) {
    if (child.type === 'text' && child.value && PANDOC_ANCHOR_PATTERN.test(child.value)) {
      PANDOC_ANCHOR_PATTERN.lastIndex = 0
      nextChildren.push(...splitPandocAnchors(child.value))
    } else {
      transformMarkdownNode(child)
      nextChildren.push(child)
    }
    PANDOC_ANCHOR_PATTERN.lastIndex = 0
  }
  node.children = nextChildren
}

export const remarkMarkdownPreviewCompatibility: Plugin<[], MdastRoot> = () => tree => {
  transformMarkdownNode(tree as MutableMarkdownNode)
}

function hastText(node: MutableHastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return node.children?.map(hastText).join('') ?? ''
}

function guardInvalidMath(node: MutableHastNode, parent?: MutableHastNode) {
  if (node.type === 'element') {
    const classes = Array.isArray(node.properties?.className)
      ? node.properties.className.filter((value): value is string => typeof value === 'string')
      : []
    const mathClasses = ['language-math', 'math-display', 'math-inline']
    const rendersMath = classes.some(className => mathClasses.includes(className))
    if (rendersMath) {
      const source = hastText(node.tagName === 'code' && parent?.tagName === 'pre' ? parent : node)
      const displayMode = classes.includes('math-display') || classes.includes('language-math') && parent?.tagName === 'pre'
      try {
        katex.renderToString(source, { displayMode, strict: 'ignore', throwOnError: true })
      } catch (error) {
        node.properties = {
          ...node.properties,
          className: [...classes.filter(className => !mathClasses.includes(className)), 'code-markdown-math-error'],
          dataMathError: 'true',
          title: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }

  node.children?.forEach(child => guardInvalidMath(child, node))
}

export const rehypeGuardInvalidKatex: Plugin<[], HastRoot> = () => tree => {
  guardInvalidMath(tree as MutableHastNode)
}
