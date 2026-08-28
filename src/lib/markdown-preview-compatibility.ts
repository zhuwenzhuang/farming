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

type MathFence = {
  outputIndex: number
  sequence: string
}

const PANDOC_ANCHOR_PATTERN = /\[\]\{#([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\}/g
const PANDOC_MATH_SPACE_PATTERN = /\\mspace\{([+-]?(?:\d+(?:\.\d*)?|\.\d+)mu)\}/g

function tableColumns(separator: string): SimpleTableColumns | null {
  if (!/^ {0,3}-{3,}(?:[ \t]+-{3,})+[ \t]*$/.test(separator)) return null
  const starts = [...separator.matchAll(/-{3,}/g)]
    .map(match => match.index)
    .filter((start): start is number => start !== undefined)
  return starts.length >= 2 ? { starts } : null
}

function sameTableColumns(left: SimpleTableColumns, right: SimpleTableColumns) {
  return left.starts.length === right.starts.length
    && left.starts.every((start, index) => start === right.starts[index])
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

function openingMathFence(line: string) {
  const match = line.match(/^( {0,3})(\${2,})([^$]*)$/)
  const sequence = match?.[2]
  return sequence ? { sequence } : null
}

function closesMathFence(line: string, fence: MathFence) {
  const match = line.match(/^ {0,3}(\${2,})[ \t]*$/)
  return match?.[1] === fence.sequence
}

function escapedMathFence(line: string, sequence: string) {
  const start = line.indexOf(sequence)
  if (start < 0) return line
  return `${line.slice(0, start)}${sequence.replace(/\$/g, '\\$')}${line.slice(start + sequence.length)}`
}

function normalizedCompactDisplayMath(lines: readonly string[], start: number) {
  const line = lines[start] ?? ''
  const singleLine = line.match(/^( {0,3})\$\$(.+)\$\$[ \t]*$/)
  if (singleLine?.[2]) {
    return {
      end: start,
      lines: [`${singleLine[1]}$$`, `${singleLine[1]}${singleLine[2]}`, `${singleLine[1]}$$`],
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
        `${opening[1]}${opening[2]}`,
        ...lines.slice(start + 1, end),
        closing[1],
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
  let mathFence: MathFence | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (fence) {
      output.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    if (mathFence) {
      output.push(line)
      if (closesMathFence(line, mathFence)) mathFence = null
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

    const nextMathFence = openingMathFence(line)
    if (nextMathFence) {
      mathFence = { ...nextMathFence, outputIndex: output.length }
      output.push(line)
      continue
    }

    const columns = tableColumns(line)
    if (!columns) {
      output.push(line)
      continue
    }
    const headerIndex = index - 1
    const header = headerIndex >= 0 ? lines[headerIndex] ?? '' : ''
    const hasHeader = Boolean(header.trim())
      && (headerIndex === 0 || !lines[headerIndex - 1]?.trim())

    let blockEnd = index + 1
    while (blockEnd < lines.length && lines[blockEnd]?.trim()) blockEnd += 1
    const block = lines.slice(index + 1, blockEnd)
    const closingIndex = block.findIndex(candidate => {
      const closingColumns = tableColumns(candidate)
      return Boolean(closingColumns && sameTableColumns(columns, closingColumns))
    })
    const hasClosingSeparator = closingIndex >= 0
    const body = hasClosingSeparator ? block.slice(0, closingIndex) : block
    if (body.length === 0) {
      output.push(line)
      continue
    }

    if (!hasHeader && !hasClosingSeparator) {
      output.push(line)
      continue
    }
    if (hasHeader) output.pop()
    output.push(gfmTableRow(hasHeader
      ? headerCells(header, columns.starts)
      : columns.starts.map(() => '')))
    output.push(gfmTableRow(columns.starts.map(() => '---')))
    body.forEach(row => output.push(gfmTableRow(fixedWidthCells(row, columns.starts))))
    index = hasClosingSeparator ? index + closingIndex + 1 : blockEnd - 1
  }

  if (mathFence) {
    const opening = output[mathFence.outputIndex]
    if (opening !== undefined) output[mathFence.outputIndex] = escapedMathFence(opening, mathFence.sequence)
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

function normalizePandocMath(value: string) {
  return value.replace(PANDOC_MATH_SPACE_PATTERN, '\\mskip$1')
}

function replaceFirstHastText(nodes: unknown, value: string): boolean {
  if (!Array.isArray(nodes)) return false
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== 'object') continue
    const node = candidate as MutableHastNode
    if (node.type === 'text') {
      node.value = value
      return true
    }
    if (replaceFirstHastText(node.children, value)) return true
  }
  return false
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
  if ((node.type === 'math' || node.type === 'inlineMath') && node.value) {
    const normalized = normalizePandocMath(node.value)
    if (normalized !== node.value) {
      node.value = normalized
      replaceFirstHastText(node.data?.hChildren, normalized)
    }
  }

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
