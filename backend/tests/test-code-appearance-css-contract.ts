import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

import { CODE_STYLE_SOURCES } from '../../src/styles/code-style-sources'

const projectRoot = path.join(__dirname, '..', '..')
const stylesRoot = path.join(projectRoot, 'src', 'styles')
const tokenSource = fs.readFileSync(path.join(stylesRoot, 'tokens.css'), 'utf8')

for (const appearance of ['dark', 'paper']) {
  assert(
    tokenSource.includes(`body.code-mode[data-appearance='${appearance}']`),
    `tokens.css must own the ${appearance} palette`,
  )
}
for (const token of [
  '--code-bg-canvas',
  '--code-bg-surface',
  '--code-text',
  '--code-border',
  '--code-accent',
  '--code-terminal-bg',
  '--code-editor-bg',
]) {
  assert(tokenSource.includes(token), `Missing functional appearance token: ${token}`)
}

assert(!tokenSource.includes('--code-dark-'), 'appearance-specific compatibility aliases must not return')
assert(!tokenSource.includes('--code-paper-contract-'), 'component tokens must remain appearance-neutral')
assert(!CODE_STYLE_SOURCES.some(source => source.endsWith('-dark.css')), 'dark component styles must not return')
assert(!CODE_STYLE_SOURCES.includes('src/styles/code-paper.css' as never), 'Paper must not use a component override sheet')

for (const sourcePath of CODE_STYLE_SOURCES) {
  const source = fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8')
  const root = postcss.parse(source, { from: sourcePath })
  if (sourcePath === 'src/styles/tokens.css') continue
  assert(!source.includes('data-appearance'), `${sourcePath} must stay appearance-neutral`)

  if (sourcePath === 'src/styles/main.css') {
    root.walkRules(rule => {
      if (!rule.selector.includes('body.code-mode')) return
      rule.walkDecls(declaration => {
        assert(
          !/(?:#[\da-f]{3,8}\b|rgba?\()/i.test(declaration.value),
          `${sourcePath}:${declaration.source?.start?.line ?? '?'} must use a semantic token for ${declaration.prop}`,
        )
      })
    })
  }
}

console.log('test-code-appearance-css-contract passed')
