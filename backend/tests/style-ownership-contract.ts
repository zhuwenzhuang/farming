import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

import { readCodeStyleSource, type CodeStyleSourcePath } from './style-source-reader'

const projectRoot = path.join(__dirname, '..', '..')

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

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

export interface DomainStyleOwnershipContract {
  /** Product-domain name; structural rules are owned by src/styles/<domain>.css. */
  domain: string
  /** Class-name prefixes owned by the domain, without the leading dot. */
  prefixes: string[]
  /** Prefixes that would match an owned prefix pattern but belong to another owner. */
  excludePrefixes?: string[]
  /** Component sources whose owned class names must resolve to an owner rule. */
  componentSources: string[]
  /** Owned class names that are semantic/test hooks with intentionally no rule. */
  unstyledClassNames?: string[]
  /** Representative selectors that must stay in the base owner. */
  mustHaveBase: string[]
}

export function assertDomainStyleOwnership(contract: DomainStyleOwnershipContract) {
  const prefixPattern = (prefix: string) => new RegExp(`\\.${prefix}(?:[-.:#\\s>+~[,)]|$)`)
  const keyframesPattern = (prefix: string) => new RegExp(`^${prefix}-`)
  const excluded = contract.excludePrefixes ?? []
  const isOwnedSelector = (selector: string) => (
    contract.prefixes.some(prefix => prefixPattern(prefix).test(selector))
    && !excluded.some(prefix => prefixPattern(prefix).test(selector))
  )
  const isOwnedKeyframes = (name: string) => (
    contract.prefixes.some(prefix => keyframesPattern(prefix).test(name))
    && !excluded.some(prefix => keyframesPattern(prefix).test(name))
  )

  const orderedRuleRecords = (source: string) => {
    const owned: string[] = []
    const remaining: string[] = []
    const visit = (container: Container, context: string[] = []) => {
      for (const node of container.nodes || []) {
        if (node.type === 'atrule') {
          const atRule = node as AtRule
          if (/keyframes$/i.test(atRule.name) && isOwnedKeyframes(atRule.params.trim())) {
            owned.push(`@${atRule.name} ${atRule.params}|${normalize(atRule.toString())}`)
          } else {
            visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
          }
        } else if (node.type === 'rule') {
          const rule = node as Rule
          const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
          for (const selector of splitSelectors(rule.selector)) {
            const record = `${context.join('>')}|${normalize(selector)}|${body}`
            const target = isOwnedSelector(selector) ? owned : remaining
            target.push(record)
          }
        }
      }
    }
    visit(postcss.parse(source))
    return { owned, remaining }
  }

  const baseFile = `src/styles/${contract.domain}.css` as CodeStyleSourcePath
  const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
  const ownerBase = orderedRuleRecords(readCodeStyleSource(baseFile))
  const ownerStyles = readCodeStyleSource(baseFile)

  assert.equal(main.owned.length, 0, `main.css must not retain ${contract.domain}-owned selectors or keyframes`)
  assert.equal(ownerBase.remaining.length, 0, `${baseFile} must contain only ${contract.domain}-owned rules`)
  assert(ownerBase.owned.length > 0, `${baseFile} must retain its domain rules`)
  assert(!/data-appearance/.test(readCodeStyleSource(baseFile)), `${baseFile} must stay appearance-neutral`)
  assert(
    ownerStyles.includes('var(--code-'),
    `${baseFile} must consume the shared semantic color palette`,
  )
  assert(
    !/(?:#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(ownerStyles),
    `${baseFile} must not hard-code color values outside the shared semantic palette`,
  )

  const classNameNeedle = new RegExp(`(?:${contract.prefixes.join('|')})[a-z0-9-]*`, 'g')
  const ownedClassNames = new Set<string>()
  for (const relativePath of contract.componentSources) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      for (const className of (match[1] || match[2] || '').match(classNameNeedle) || []) {
        if (className.endsWith('-')) continue
        if (excluded.some(prefix => keyframesPattern(prefix).test(className) || className === prefix)) continue
        ownedClassNames.add(className)
      }
    }
  }
  assert(ownedClassNames.size > 0, `${contract.domain} consumers must reference owned class names`)
  const unstyled = new Set(contract.unstyledClassNames ?? [])
  for (const className of unstyled) {
    assert(
      !ownerStyles.includes(`.${className}`),
      `${contract.domain} unstyled hook class actually has rules; remove it from unstyledClassNames: ${className}`,
    )
  }
  for (const className of ownedClassNames) {
    if (unstyled.has(className)) continue
    assert(
      ownerStyles.includes(`.${className}`),
      `${contract.domain} style owner is missing component class: ${className}`,
    )
  }

  for (const selector of contract.mustHaveBase) {
    assert(readCodeStyleSource(baseFile).includes(selector), `Missing ${contract.domain} base rule: ${selector}`)
  }
}
