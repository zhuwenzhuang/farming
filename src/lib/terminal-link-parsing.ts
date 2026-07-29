/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code's terminalLinkParsing.ts. This module is deliberately
// lexical only; callers must validate every candidate against the filesystem.

export type TerminalPathStyle = 'posix' | 'windows' | 'auto'

export interface ParsedTerminalPathLink {
  path: {
    index: number
    text: string
  }
  prefix?: {
    index: number
    text: string
  }
  suffix?: {
    lineNumber?: number
    column?: number
    endLineNumber?: number
    endColumn?: number
    range: {
      index: number
      text: string
    }
  }
}

function generateLinkSuffixRegex(endOfLineOnly: boolean) {
  let lineIndex = 0
  let columnIndex = 0
  let endLineIndex = 0
  let endColumnIndex = 0
  const line = () => `(?<line${lineIndex++}>\\d+)`
  const column = () => `(?<column${columnIndex++}>\\d+)`
  const endLine = () => `(?<endLine${endLineIndex++}>\\d+)`
  const endColumn = () => `(?<endColumn${endColumnIndex++}>\\d+)`
  const end = endOfLineOnly ? '$' : ''
  const clauses = [
    `(?::|#| |['"],|, )${line()}([:.]${column()}(?:-(?:${endLine()}\\.)?${endColumn()})?)?${end}`,
    `['"]?(?:,? |: ?| on )lines? ${line()}(?:-${endLine()})?(?:,? (?:col(?:umn)?|characters?) ${column()}(?:-${endColumn()})?)?${end}`,
    `:? ?[\\[\\(]${line()}(?:(?:, ?|:)${column()})?[\\]\\)]${end}`,
  ]
  const source = clauses.join('|').replace(/ /g, '[\\u00a0 ]')
  return new RegExp(`(${source})`, endOfLineOnly ? undefined : 'g')
}

const LINK_SUFFIX_PATTERN = generateLinkSuffixRegex(false)
const LINK_WITH_SUFFIX_PATH_PATTERN = /(?<path>(?:file:\/\/\/)?[^\s|<>\[\({][^\s|<>]*)$/

function positiveInteger(value: string | undefined) {
  if (value === undefined) return undefined
  const number = Number.parseInt(value, 10)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function suffixFromMatch(match: RegExpExecArray) {
  const groups = match.groups || {}
  return {
    lineNumber: positiveInteger(groups.line0 || groups.line1 || groups.line2),
    column: positiveInteger(groups.column0 || groups.column1 || groups.column2),
    endLineNumber: positiveInteger(groups.endLine0 || groups.endLine1 || groups.endLine2),
    endColumn: positiveInteger(groups.endColumn0 || groups.endColumn1 || groups.endColumn2),
    range: {
      index: match.index,
      text: match[0],
    },
  }
}

function detectLinksViaSuffix(lineText: string) {
  const results: ParsedTerminalPathLink[] = []
  LINK_SUFFIX_PATTERN.lastIndex = 0
  for (;;) {
    const match = LINK_SUFFIX_PATTERN.exec(lineText)
    if (!match) break
    const suffix = suffixFromMatch(match)
    const suffixEnd = suffix.range.index + suffix.range.text.length
    if (lineText[suffixEnd] === '/') continue

    const beforeSuffix = lineText.slice(0, suffix.range.index)
    const pathMatch = beforeSuffix.match(LINK_WITH_SUFFIX_PATH_PATTERN)
    const matchedPath = pathMatch?.groups?.path
    if (!matchedPath || pathMatch.index === undefined) continue

    let pathText = matchedPath
    let pathIndex = pathMatch.index
    let prefix: ParsedTerminalPathLink['prefix']
    const prefixMatch = pathText.match(/^(?<prefix>['"]+)/)
    if (prefixMatch?.groups?.prefix) {
      prefix = { index: pathIndex, text: prefixMatch.groups.prefix }
      pathText = pathText.slice(prefix.text.length)
      if (!pathText.trim()) continue
      if (
        prefix.text.length > 1 &&
        /^['"]/.test(suffix.range.text) &&
        prefix.text[prefix.text.length - 1] === suffix.range.text[0]
      ) {
        const trim = prefix.text.length - 1
        prefix = { index: prefix.index + trim, text: prefix.text.slice(-1) }
        pathIndex += trim
      }
    }

    results.push({
      path: {
        index: pathIndex + (prefix?.text.length || 0),
        text: pathText,
      },
      ...(prefix ? { prefix } : {}),
      suffix,
    })

    for (const bracketMatch of pathText.matchAll(/[\[(](?![\])])/g)) {
      results.push({
        path: {
          index: pathIndex + (prefix?.text.length || 0) + bracketMatch.index + 1,
          text: pathText.slice(bracketMatch.index + 1),
        },
        ...(prefix ? { prefix } : {}),
        suffix,
      })
    }
  }
  return results
}

const REGEX_BACKTICK = '\x60'
const PATH_PREFIX = String.raw`(?:\.\.?|\~|file:\/\/)`
const PATH_SEPARATOR = String.raw`\/`
const EXCLUDED_PATH_CHARACTERS = String.raw`[^\0<>\?\s!${REGEX_BACKTICK}&*()'":;\\]`
const EXCLUDED_START_PATH_CHARACTERS = String.raw`[^\0<>\?\s!${REGEX_BACKTICK}&*()\[\]'":;\\]`
const POSIX_PATH = '(?:(?:' +
  PATH_PREFIX + '|(?:' + EXCLUDED_START_PATH_CHARACTERS + EXCLUDED_PATH_CHARACTERS + '*))?' +
  '(?:' + PATH_SEPARATOR + '(?:' + EXCLUDED_PATH_CHARACTERS + ')+)+)'

const WINDOWS_DRIVE_PREFIX = String.raw`(?:\\\\\?\\|file:\/\/\/)?[a-zA-Z]:`
const WINDOWS_OTHER_PATH_PREFIX = String.raw`\.\.?|\~`
const WINDOWS_PATH_SEPARATOR = String.raw`(?:\\|\/)`
const WINDOWS_EXCLUDED_PATH_CHARACTERS = String.raw`[^\0<>\?\|\/\s!${REGEX_BACKTICK}&*()'":;]`
const WINDOWS_EXCLUDED_START_PATH_CHARACTERS = String.raw`[^\0<>\?\|\/\s!${REGEX_BACKTICK}&*()\[\]'":;]`
const WINDOWS_PATH = '(?:(?:' +
  '(?:' + WINDOWS_DRIVE_PREFIX + '|' + WINDOWS_OTHER_PATH_PREFIX + ')' +
  '|(?:' + WINDOWS_EXCLUDED_START_PATH_CHARACTERS + WINDOWS_EXCLUDED_PATH_CHARACTERS + '*))?' +
  '(?:' + WINDOWS_PATH_SEPARATOR + '(?:' + WINDOWS_EXCLUDED_PATH_CHARACTERS + ')+)+)'
const DIFF_PREFIX_PATTERN = /^[abciow12]\//
const DIFF_LINE_PATTERN = /^[-+]{3} [abciow12]\//

function detectPathsWithoutSuffix(lineText: string, style: Exclude<TerminalPathStyle, 'auto'>) {
  const pattern = new RegExp(style === 'windows' ? WINDOWS_PATH : POSIX_PATH, 'g')
  const results: ParsedTerminalPathLink[] = []
  for (;;) {
    const match = pattern.exec(lineText)
    if (!match) break
    let text = match[0]
    let index = match.index
    if (!text) break
    if (
      (DIFF_LINE_PATTERN.test(lineText) && index === 4) ||
      (lineText.startsWith('diff --git') && DIFF_PREFIX_PATTERN.test(text))
    ) {
      text = text.slice(2)
      index += 2
    }
    results.push({ path: { index, text } })
  }
  return results
}

function rangesOverlap(a: ParsedTerminalPathLink, b: ParsedTerminalPathLink) {
  const aStart = a.prefix?.index ?? a.path.index
  const aEnd = (a.suffix?.range.index ?? (a.path.index + a.path.text.length - 1)) +
    (a.suffix?.range.text.length ?? 1)
  const bStart = b.prefix?.index ?? b.path.index
  const bEnd = (b.suffix?.range.index ?? (b.path.index + b.path.text.length - 1)) +
    (b.suffix?.range.text.length ?? 1)
  return aStart < bEnd && bStart < aEnd
}

export function detectTerminalPathLinks(
  lineText: string,
  style: TerminalPathStyle = 'auto',
): ParsedTerminalPathLink[] {
  const suffixLinks = detectLinksViaSuffix(lineText)
  const styles: Array<Exclude<TerminalPathStyle, 'auto'>> = style === 'auto'
    ? ['posix', 'windows']
    : [style]
  const candidates = styles.flatMap(candidateStyle => detectPathsWithoutSuffix(lineText, candidateStyle))
  const merged = [...suffixLinks]
  for (const candidate of candidates) {
    if (!merged.some(existing => rangesOverlap(existing, candidate))) merged.push(candidate)
  }
  return merged.sort((a, b) => a.path.index - b.path.index)
}
