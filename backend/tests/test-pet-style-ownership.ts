import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

import { readCodeStyleSource } from './style-source-reader'

const projectRoot = path.join(__dirname, '..', '..')
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

const petClassPrefixes = ['code-pet', 'code-product-pet-anchor', 'rest-reminder'] as const

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

function isPetSelector(selector: string) {
  return petClassPrefixes.some(prefix => (
    new RegExp(`\\.${prefix}(?:[-.:#\\s>+~\\[,]|$)`).test(selector)
  ))
}

function isPetKeyframes(name: string) {
  return /^code-pet-/.test(name)
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function orderedRuleRecords(source: string) {
  const pet: string[] = []
  const remaining: string[] = []
  const visit = (container: Container, context: string[] = []) => {
    for (const node of container.nodes || []) {
      if (node.type === 'atrule') {
        const atRule = node as AtRule
        if (/keyframes$/i.test(atRule.name) && isPetKeyframes(atRule.params.trim())) {
          pet.push(`@${atRule.name} ${atRule.params}|${normalize(atRule.toString())}`)
        } else {
          visit(atRule, [...context, `@${atRule.name} ${normalize(atRule.params)}`])
        }
      } else if (node.type === 'rule') {
        const rule = node as Rule
        const body = normalize((rule.nodes || []).map(child => child.toString()).join(';'))
        for (const selector of splitSelectors(rule.selector)) {
          const record = `${context.join('>')}|${normalize(selector)}|${body}`
          const owner = isPetSelector(selector) ? pet : remaining
          owner.push(record)
        }
      }
    }
  }
  visit(postcss.parse(source))
  return { pet, remaining }
}

function digest(records: string[]) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

// Settings owns the Pet appearance controls rendered inside its panel, so those
// selectors must stay outside the Pet ownership boundary.
for (const settingsSelector of [
  '.code-settings-pet-appearance-row',
  '.code-settings-pet-appearance-select',
  '.code-settings-pet-appearance-options',
  '.code-settings-pet-rest-custom',
  '.code-settings-pet-rest-off-marker',
]) {
  assert.equal(isPetSelector(settingsSelector), false, `Settings selector must not be Pet-owned: ${settingsSelector}`)
}
assert.equal(isPetSelector('.code-pet-bubble'), true)
assert.equal(isPetSelector('.code-product-pet-anchor'), true)

const main = orderedRuleRecords(readCodeStyleSource('src/styles/main.css'))
const pet = orderedRuleRecords(readCodeStyleSource('src/styles/pet.css'))
const dark = orderedRuleRecords(readCodeStyleSource('src/styles/code-dark.css'))
const petDark = orderedRuleRecords(readCodeStyleSource('src/styles/pet-dark.css'))

assert.equal(main.pet.length, 0, 'main.css must not retain Pet-owned selectors or keyframes')
assert.equal(dark.pet.length, 0, 'code-dark.css must not retain Pet-owned selectors')
assert.equal(pet.remaining.length, 0, 'pet.css must contain only Pet-owned rules')
assert.equal(petDark.remaining.length, 0, 'pet-dark.css must contain only Pet-owned rules')

// These ordered hashes were captured from the two monolithic source files before
// extraction. Splitting comma groups into individual selectors proves that mixed
// rules kept their selector specificity, declaration bodies, media context, and
// relative order on both sides of the ownership boundary. The combined record set
// spans both owner files because the dark Pet overrides used to live in main.css.
//
// As the newest extraction, this test is the single owner of the mutable
// main.css/code-dark.css remainder contract. Earlier owner tests lock only their
// own moved rules, so the next CSS split moves this remainder proof forward here
// instead of rewriting hashes across every historical owner test.
assert.deepEqual(
  [pet.pet.length + petDark.pet.length, digest([...pet.pet, ...petDark.pet])],
  [139, '95d0a6cead9ea38074ced1ec3fe853b546f28c5dae42160eca67590b81effcf9'],
  'the Pet owners must preserve the ordered base Pet rule set from main.css and code-dark.css',
)
assert.deepEqual(
  [pet.pet.length, digest(pet.pet)],
  [108, '95344ea4931cff696e40e5ef127114b3099a616cad146243af7c7bb2b8513e39'],
  'pet.css must preserve the ordered appearance-neutral Pet rules',
)
assert.deepEqual(
  [petDark.pet.length, digest(petDark.pet)],
  [31, '219d9a4fc1aec1a371f3ea5f4583945a1155c6e10a49ba166ba27b491efb83dd'],
  'pet-dark.css must preserve the ordered dark Pet rules',
)
assert.deepEqual(
  [main.remaining.length, digest(main.remaining)],
  [2434, '0421f5929ef4407429e50c303ad9234bd1376b1e85b2e8a1acb1cb7d54bb20b0'],
  'main.css must preserve the ordered non-Pet rule set',
)
assert.deepEqual(
  [dark.remaining.length, digest(dark.remaining)],
  [959, '99c239744f6f4cd0844c9bd635b4f69e3014cf8768d16b118777444f3acf4a14'],
  'code-dark.css must preserve the ordered non-Pet dark rule set',
)

const componentSources = [
  read('src/components/code/pet/FarmingPet.tsx'),
  read('src/components/code/pet/PetBubble.tsx'),
  read('src/components/code/pet/GlassPetRestScene.tsx'),
  read('src/components/code/pet/BlackHolePetRestScene.tsx'),
]
const petStyles = readCodeStyleSource('src/styles/pet.css')
const petDarkStyles = readCodeStyleSource('src/styles/pet-dark.css')
const mainStyles = readCodeStyleSource('src/styles/main.css')
const darkStyles = readCodeStyleSource('src/styles/code-dark.css')

const ownedClassNames = new Set<string>()
for (const source of componentSources) {
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const className of (match[1] || match[2] || '').match(/(?:code-pet[a-z0-9-]*|rest-reminder[a-z0-9-]*)/g) || []) {
      if (!className.endsWith('-')) ownedClassNames.add(className)
    }
  }
}
for (const className of ownedClassNames) {
  assert(
    petStyles.includes(`.${className}`) || petDarkStyles.includes(`.${className}`),
    `Pet style owner is missing component class: ${className}`,
  )
}

for (const selector of [
  '.code-product-pet-anchor',
  '.code-pet-bubble',
  '.code-pet-actions',
  '.code-pet-close',
  '.code-pet-glass-rest-overlay',
  '.code-pet-black-hole-rest',
  '.code-pet-black-hole-status',
  '.code-pet-seven-segment-digit',
  '.code-pet-appearance-select',
  '.code-pet-appearance-preview',
]) {
  assert(petStyles.includes(selector), `Missing Pet base rule: ${selector}`)
}
for (const selector of [
  '.code-pet-bubble',
  '.code-pet-actions button',
  '.code-pet-close',
  '.code-pet-error',
  '.code-pet-glass-rest-overlay',
  '.code-pet-black-hole-status',
  '.code-pet-seven-segment-time',
  '.code-pet-appearance-select',
]) {
  assert(petDarkStyles.includes(selector), `Missing Pet dark rule: ${selector}`)
}

assert(petStyles.includes('@keyframes code-pet-glass-rest-appear'), 'Pet owner must retain its rest-scene animation')
assert(petStyles.includes('@media (prefers-reduced-motion: reduce)'), 'Pet owner must retain its reduced-motion rules')
assert(!mainStyles.includes('.code-product-pet-anchor'), 'main.css must not retain the Pet anchor rule')
assert(!/rest-reminder/.test(mainStyles) && !/rest-reminder/.test(darkStyles), 'rest reminder rules belong to the Pet owner')

// Dark Pet rules stay in the dark owner, and base Pet rules stay appearance-neutral or light.
assert(!petStyles.includes("data-appearance='dark'"), 'pet.css must not carry dark-appearance overrides')
assert(petDarkStyles.includes("body.code-mode[data-appearance='dark']"), 'pet-dark.css must scope rules to the dark appearance')

console.log('test-pet-style-ownership passed')
