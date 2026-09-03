import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import { CODE_STYLE_SOURCES } from '../../src/styles/code-style-sources'

const projectRoot = path.join(__dirname, '../..')
const familyOwner = 'src/styles/ui-design.css'
const sources = [
  ...CODE_STYLE_SOURCES,
  'src/styles/review.css',
  'src/components/CodeSelect.css',
  'extensions/browser/frontend/browser.css',
  'extensions/computer/frontend/computer.css',
]
const menuSurfaces = [
  'code-context-menu', 'code-editor-context-menu', 'code-project-context-menu',
  'code-project-launch-menu', 'code-file-context-menu', 'code-select-menu',
  'review-source-menu', 'code-composer-menu', 'code-plus-menu', 'code-slash-menu',
  'code-approval-menu', 'code-model-picker-menu', 'code-model-submenu', 'code-speed-submenu',
  'farming-browser-more-menu', 'farming-computer-more-menu',
]
const surfaceMetric = /^(?:border(?:-radius|-color)?|background(?:-color)?|box-shadow|font(?:-family|-size|-weight)?|padding)$/
const sharedMetric = /^--code-(?:ui-|menu-|field-|dialog-action-|touch-target|file-entry-(?:font|line)|sidebar-file-row-height)/

for (const source of sources) {
  const root = postcss.parse(fs.readFileSync(path.join(projectRoot, source), 'utf8'))
  root.walkDecls(declaration => {
    if (sharedMetric.test(declaration.prop)) {
      assert.equal(source, familyOwner, `${source} must not fork shared geometry or typography`)
    }
  })
  if (source === familyOwner) continue
  root.walkRules(rule => {
    for (const selector of rule.selectors) {
      assert(!/\.code-menu-(surface|list|item)(?=[\s.:[]|$)/.test(selector), `${source} must not override the shared menu recipe`)
      // Product owners may size/anchor a surface, but its chrome stays shared.
      if (!menuSurfaces.some(name => selector.endsWith(`.${name}`) || selector.endsWith(`.${name}.has-matrix`))) continue
      rule.walkDecls(declaration => {
        assert(!surfaceMetric.test(declaration.prop), `${source}: ${selector} forks menu ${declaration.prop}`)
      })
    }
  })
}

const familyCss = fs.readFileSync(path.join(projectRoot, familyOwner), 'utf8')
assert.match(
  familyCss,
  /\.code-menu-surface \.code-menu-item\.code-menu-item-rich\s*\{[^}]*min-height:\s*52px/s,
  'the shared mobile menu recipe must preserve touch-sized rich choice rows',
)
for (const component of [
  'src/components/code/CodeComposer.tsx',
  'src/components/code/acp/AcpSessionControls.tsx',
]) {
  const source = fs.readFileSync(path.join(projectRoot, component), 'utf8')
  assert.match(
    source,
    /code-menu-item code-menu-item-rich code-approval-option/,
    `${component} must opt multi-line approval choices into the shared rich-row recipe`,
  )
}
console.log('test-ui-design-ownership passed')
