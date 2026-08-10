import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

import { readCodeStyleSource } from './style-source-reader'

const projectRoot = path.join(__dirname, '..', '..')
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

function splitSelectors(selectorList: string) {
  const selectors: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const character of selectorList) {
    if (quote) {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
    } else if (character === '(' || character === '[') {
      depth += 1
      current += character
    } else if (character === ')' || character === ']') {
      depth -= 1
      current += character
    } else if (character === ',' && depth === 0) {
      selectors.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim()) selectors.push(current.trim())
  return selectors
}

function isMarkdownSelector(selector: string) {
  return /\.code-markdown(?:[-.:#\s>+~[,]|$)/.test(selector)
}

function isMarkdownKeyframes(name: string) {
  return /^code-markdown-/.test(name)
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function orderedRuleRecords(source: string) {
  const markdown: string[] = []
  const remaining: string[] = []
  const visit = (container: Container, context: string[] = []) => {
    for (const node of container.nodes || []) {
      if (node.type === 'atrule') {
        const atRule = node as AtRule
        if (/keyframes$/i.test(atRule.name) && isMarkdownKeyframes(atRule.params.trim())) {
          markdown.push(`@${atRule.name} ${atRule.params}|${normalize(atRule.toString())}`)
        } else {
          visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
        }
      } else if (node.type === 'rule') {
        const rule = node as Rule
        const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
        for (const selector of splitSelectors(rule.selector)) {
          const record = `${context.join('>')}|${normalize(selector)}|${body}`
          const owner = isMarkdownSelector(selector) ? markdown : remaining
          owner.push(record)
        }
      }
    }
  }
  visit(postcss.parse(source))
  return { markdown, remaining }
}

function digest(records: string[]) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

assert.equal(isMarkdownSelector('.code-markdown-preview'), true)
// Markdown rules are consumed inside transcript and File Editor surfaces, so
// compound selectors that only mention those hosts stay with their own owners.
assert.equal(isMarkdownSelector('.code-agent-transcript .code-file-preview'), false)
assert.equal(isMarkdownSelector('.code-acp-progress-update.code-markdown-preview'), true)

const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
const markdown = orderedRuleRecords(readCodeStyleSource('src/styles/markdown.css'))
const dark = orderedRuleRecords(readCodeStyleSource('src/styles/code-dark.css'))
const markdownDark = orderedRuleRecords(readCodeStyleSource('src/styles/markdown-dark.css'))

assert.equal(main.markdown.length, 0, 'main.css must not retain Markdown-owned selectors or keyframes')
assert.equal(dark.markdown.length, 0, 'code-dark.css must not retain Markdown-owned selectors')
assert.equal(markdown.remaining.length, 0, 'markdown.css must contain only Markdown-owned rules')
assert.equal(markdownDark.remaining.length, 0, 'markdown-dark.css must contain only Markdown-owned rules')

// These ordered hashes were captured from the two monolithic source files
// before extraction. Splitting comma groups into individual selectors proves
// that mixed rules kept their selector specificity, declaration bodies, media
// context, and relative order on both sides of the Markdown ownership boundary.
assert.deepEqual(
  [markdown.markdown.length + markdownDark.markdown.length, digest([...markdown.markdown, ...markdownDark.markdown])],
  [222, 'd297c337664ee2dd0145d53b7579401b28f03339884da0f51cbf8018aaeb7b71'],
  'the Markdown owners must preserve the ordered Markdown rule set from main.css and code-dark.css',
)
assert.deepEqual(
  [markdown.markdown.length, digest(markdown.markdown)],
  [153, 'c3a1163823258b35af917f0b580023afb92694a64839455ecb525ad0992001f0'],
  'markdown.css must preserve the ordered appearance-neutral Markdown rules',
)
assert.deepEqual(
  [markdownDark.markdown.length, digest(markdownDark.markdown)],
  [69, '1696142527cd56ecaa22beb23a40070244308cfdf5127745acf26d789b2c045a'],
  'markdown-dark.css must preserve the ordered dark Markdown rules',
)

const componentSources = [
  read('src/components/code/AgentTranscriptPane.tsx'),
  read('src/components/files/FileEditorMarkdownPreview.tsx'),
]
const markdownStyles = readCodeStyleSource('src/styles/markdown.css')
const markdownDarkStyles = readCodeStyleSource('src/styles/markdown-dark.css')

const ownedClassNames = new Set<string>()
for (const source of componentSources) {
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const className of (match[1] || match[2] || '').match(/code-markdown[a-z0-9-]*/g) || []) {
      if (!className.endsWith('-')) ownedClassNames.add(className)
    }
  }
}
assert(ownedClassNames.size > 0, 'Markdown consumers must reference Markdown-owned class names')
for (const className of ownedClassNames) {
  assert(
    markdownStyles.includes(`.${className}`) || markdownDarkStyles.includes(`.${className}`),
    `Markdown style owner is missing component class: ${className}`,
  )
}

for (const selector of [
  '.code-markdown-preview',
  '.code-markdown-preview pre',
  '.code-markdown-preview table',
  '.code-markdown-preview blockquote',
]) {
  assert(markdownStyles.includes(selector), `Missing Markdown base rule: ${selector}`)
}
for (const selector of [
  '.code-markdown-preview',
  '.code-markdown-preview code',
]) {
  assert(markdownDarkStyles.includes(selector), `Missing dark Markdown rule: ${selector}`)
}

console.log('test-markdown-style-ownership passed')
