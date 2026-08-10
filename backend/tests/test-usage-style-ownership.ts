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

function isUsageSelector(selector: string) {
  return /\.code-usage(?:[-.:#\s>+~[,]|$)/.test(selector)
}

function isUsageKeyframes(name: string) {
  return /^code-usage-/.test(name)
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function orderedRuleRecords(source: string) {
  const usage: string[] = []
  const remaining: string[] = []
  const visit = (container: Container, context: string[] = []) => {
    for (const node of container.nodes || []) {
      if (node.type === 'atrule') {
        const atRule = node as AtRule
        if (/keyframes$/i.test(atRule.name) && isUsageKeyframes(atRule.params.trim())) {
          usage.push(`@${atRule.name} ${atRule.params}|${normalize(atRule.toString())}`)
        } else {
          visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
        }
      } else if (node.type === 'rule') {
        const rule = node as Rule
        const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
        for (const selector of splitSelectors(rule.selector)) {
          const record = `${context.join('>')}|${normalize(selector)}|${body}`
          const owner = isUsageSelector(selector) ? usage : remaining
          owner.push(record)
        }
      }
    }
  }
  visit(postcss.parse(source))
  return { usage, remaining }
}

function digest(records: string[]) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

assert.equal(isUsageSelector('.code-usage-panel'), true)
assert.equal(isUsageSelector('.code-usage-row strong'), true)
// The main-Agent restart menu shares a declaration body with Usage buttons but
// is not Usage-owned; only its Usage-prefixed group members move.
assert.equal(isUsageSelector('.code-main-agent-restart-menu button'), false)

const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
const usage = orderedRuleRecords(readCodeStyleSource('src/styles/usage.css'))
const dark = orderedRuleRecords(readCodeStyleSource('src/styles/code-dark.css'))
const usageDark = orderedRuleRecords(readCodeStyleSource('src/styles/usage-dark.css'))

assert.equal(main.usage.length, 0, 'main.css must not retain Usage-owned selectors or keyframes')
assert.equal(dark.usage.length, 0, 'code-dark.css must not retain Usage-owned selectors')
assert.equal(usage.remaining.length, 0, 'usage.css must contain only Usage-owned rules')
assert.equal(usageDark.remaining.length, 0, 'usage-dark.css must contain only Usage-owned rules')

// These ordered hashes were captured from the two monolithic source files
// before extraction. Splitting comma groups into individual selectors proves
// that mixed rules kept their selector specificity, declaration bodies, media
// context, and relative order on both sides of the Usage ownership boundary.
assert.deepEqual(
  [usage.usage.length + usageDark.usage.length, digest([...usage.usage, ...usageDark.usage])],
  [208, 'f31b4875cec97da3427c79f43227630269b6b2b2d1485143bf8a35788824bfc7'],
  'the Usage owners must preserve the ordered Usage rule set from main.css and code-dark.css',
)
assert.deepEqual(
  [usage.usage.length, digest(usage.usage)],
  [153, 'e307933ed18d1e83952930530546bf803489fd6c19ed8557b86050fda6cbc858'],
  'usage.css must preserve the ordered appearance-neutral Usage rules',
)
assert.deepEqual(
  [usageDark.usage.length, digest(usageDark.usage)],
  [55, 'c03dd8fe15d5b6fc754f742e4a13638842d94fe66a2e9574b62026baffa96c21'],
  'usage-dark.css must preserve the ordered dark Usage rules',
)

const componentSource = read('src/components/code/UsagePanel.tsx')
const usageStyles = readCodeStyleSource('src/styles/usage.css')
const usageDarkStyles = readCodeStyleSource('src/styles/usage-dark.css')

const ownedClassNames = new Set<string>()
for (const match of componentSource.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
  for (const className of (match[1] || match[2] || '').match(/code-usage[a-z0-9-]*/g) || []) {
    if (!className.endsWith('-')) ownedClassNames.add(className)
  }
}
assert(ownedClassNames.size > 0, 'UsagePanel must reference Usage-owned class names')
for (const className of ownedClassNames) {
  assert(
    usageStyles.includes(`.${className}`) || usageDarkStyles.includes(`.${className}`),
    `Usage style owner is missing component class: ${className}`,
  )
}

for (const selector of [
  '.code-usage-panel',
  '.code-usage-header',
  '.code-usage-row',
  '.code-usage-daily-heatmap-cell',
  '.code-usage-day-breakdown',
  '.code-usage-main-agent-restart',
]) {
  assert(usageStyles.includes(selector), `Missing Usage base rule: ${selector}`)
}
for (const selector of [
  '.code-usage-panel',
  '.code-usage-header',
  '.code-usage-provider',
]) {
  assert(usageDarkStyles.includes(selector), `Missing dark Usage rule: ${selector}`)
}

console.log('test-usage-style-ownership passed')
