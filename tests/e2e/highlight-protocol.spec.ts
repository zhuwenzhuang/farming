import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CODE_STYLE_SOURCES } from '../../src/styles/code-style-sources'

// Deterministic composed-state fixture: production styles in production order.
// Product navigation is exercised separately in navigation-highlight.spec.ts.
const css = CODE_STYLE_SOURCES.map(source => fs.readFileSync(path.resolve(source), 'utf8')).join('\n')
const fixture = `<meta name="viewport" content="width=device-width, initial-scale=1">
<main class="code-workspace" style="display:block">
<aside class="code-sidebar" style="position:relative;width:350px;height:auto;overflow:visible">
  <div class="code-project-row">
    <div class="code-project-heading code-project-title-content">
      <button id="project" class="code-project-title" aria-expanded="true">Sample project</button>
      <span class="code-project-title-actions"><button id="launch" class="code-project-title-action" aria-haspopup="menu" aria-expanded="false">+</button></span>
    </div>
    <button id="branch" class="code-project-worktree">main</button>
  </div>
  <div class="code-agent-list code-pinned-list">
    <div id="selected" class="code-agent-row active" tabindex="0" aria-current="page"><span>Current Agent</span></div>
    <div id="other" class="code-agent-row" tabindex="0"><span>Other Agent</span>
      <span class="code-agent-row-actions"><button id="action" class="code-agent-row-action">…</button></span>
    </div>
  </div>
  <button id="sidebar-toggle" class="code-sidebar-toggle">Toggle</button>
  <button id="files" class="code-files-title" aria-expanded="true">Files</button>
  <div id="change" class="code-file-change-row active"><button id="change-main" class="code-file-change-main">Changed file</button></div>
  <div id="editor" class="code-open-editor-row active"><button id="editor-main" class="code-open-editor-main">Open file</button><span class="code-open-editor-actions"><button id="close" class="code-open-editor-close"></button></span></div>
  <button id="compact" class="code-project-agent-compact active">1</button>
  <div id="resource" class="code-sidebar-resource-row" tabindex="0"><span>◉</span><span>Browser</span><span class="code-sidebar-resource-actions"><button id="stop" disabled>×</button></span></div>
  <div class="code-file-tree-viewport"><div id="tree" role="tree" tabindex="0"><div id="file-frame" class="code-file-tree-row-frame"><div id="file" class="code-file-row focused selected" tabindex="0">README.md</div></div></div></div>
</aside>
<div style="position:absolute;left:370px;top:20px">
  <button id="outside">Outside</button>
  <div class="code-menu-surface code-menu-list code-project-context-menu"><button id="menu-a" aria-selected="true">Selected</button><button id="menu-b">Candidate</button><button id="menu-disabled" disabled>Disabled</button><button id="menu-selected-disabled" aria-selected="true" disabled>Selected disabled</button></div>
  <div id="symbol-root" class="code-language-server-node root"><button class="code-language-server-location">Root symbol</button></div>
  <div id="symbol" class="code-language-server-node" aria-selected="true"><button id="symbol-main" class="code-language-server-location">Child symbol</button></div>
  <div class="code-settings-segmented"><button id="setting" class="active">Selected setting</button><button id="setting-other">Other setting</button><button id="setting-disabled" disabled>Disabled</button><button id="setting-selected-disabled" class="active" disabled>Selected disabled</button></div>
<button id="process-copy" class="code-agent-transcript-copy">Copy</button></div>
</main>`

async function color(page: Page, variable: string) {
  return page.evaluate(variable => {
    const probe = document.createElement('span')
    probe.style.color = `var(${variable})`
    document.body.append(probe)
    const result = getComputedStyle(probe).color
    probe.remove()
    return result
  }, variable)
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const input of ['mouse', 'narrow-mouse', 'touch', 'wide-touch'] as const) {
    test(`${appearance} ${input}: one composed highlight surface`, async ({ browser }, testInfo) => {
      const compact = input === 'narrow-mouse' || input === 'touch'
      const touch = input.endsWith('touch')
      const context = await browser.newContext({
        viewport: { width: compact ? 767 : 1100, height: 900 },
        hasTouch: touch,
        isMobile: touch,
        reducedMotion: 'reduce',
      })
      try {
        const page = await context.newPage()
        page.setDefaultTimeout(5_000)
        await page.setContent(fixture)
        await page.addStyleTag({ content: css })
        await page.evaluate(({ appearance, compact }) => {
          document.body.className = `code-mode ${compact ? 'code-compact-layout' : ''}`
          document.body.dataset.appearance = appearance
        }, { appearance, compact })
        const active = await color(page, '--code-active-item-surface')
        const base = await page.locator('.code-workspace').evaluate(el => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--code-navigation-surface)'
          el.append(probe)
          const result = getComputedStyle(probe).color
          probe.remove()
          return result
        })
        const click = async (id: string) => {
          if (touch) await page.locator(id).tap()
          else await page.locator(id).click()
        }
        await click('#outside')
        if (touch) {
          await expect(page.locator('.code-project-title-actions')).toHaveCSS('opacity', '1')
          await expect(page.locator('#process-copy')).toHaveCSS('opacity', '1')
        }
        await expect(page.locator('#selected')).toHaveCSS('background-color', active)
        await expect(page.locator('#compact')).toHaveCSS('background-color', active)
        await expect(page.locator('#setting')).toHaveCSS('background-color', active)
        await expect(page.locator('#setting-selected-disabled')).toHaveCSS('background-color', active)
        await expect(page.locator('#menu-selected-disabled')).toHaveCSS('background-color', active)
        for (const id of ['#project', '#files', '#other', '#resource']) {
          await click(id)
          if (!touch) await page.mouse.move(740, 800)
          const surface = id === '#project' ? '.code-project-heading' : id
          await expect(page.locator(surface)).toHaveCSS('background-color', base)
        }
        for (const [id, surface] of [['#change-main', '#change'], ['#editor-main', '#editor']]) {
          await click(id)
          if (!touch) await page.mouse.move(740, 800)
          await expect(page.locator(surface)).toHaveCSS('background-color', active)
          await expect(page.locator(id)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        }
        if (!touch) {
          await page.locator('#sidebar-toggle').hover()
          await expect(page.locator('#sidebar-toggle')).toHaveCSS('background-color', active)
          await page.locator('#other').hover({ position: { x: 25, y: 12 } })
          await expect(page.locator('#other')).toHaveCSS('background-color', active)
          if (!compact) {
            await page.locator('#action').hover()
            await expect(page.locator('#other')).toHaveCSS('background-color', base)
          }
          await page.locator('#project').hover()
          await page.locator('#launch').hover()
          await expect(page.locator('.code-project-heading')).toHaveCSS('background-color', base)
          const disabledColor = await page.locator('#stop').evaluate(el => getComputedStyle(el).color)
          await page.locator('#resource').hover()
          await page.locator('#stop').hover()
          await expect(page.locator('#stop')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await expect(page.locator('#stop')).toHaveCSS('color', disabledColor)
          await page.locator('#file').hover()
          await expect(page.locator('#file-frame')).toHaveCSS('background-color', active)
          await page.locator('#symbol-main').hover()
          await expect(page.locator('#symbol')).toHaveCSS('background-color', active)
          await expect(page.locator('#symbol-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await page.locator('#setting-other').hover()
          await expect(page.locator('#setting-other')).toHaveCSS('background-color', active)
          await page.locator('#setting-disabled').hover()
          await expect(page.locator('#setting-disabled')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await page.locator('#menu-disabled').hover()
          await expect(page.locator('#menu-disabled')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await page.locator('#menu-b').hover()
          await expect(page.locator('#menu-b')).toHaveCSS('background-color', active)
          await page.mouse.move(740, 800)
        }
        await expect(page.locator('#symbol-root')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(page.locator('#menu-disabled')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        // Tab, not programmatic pointer focus, admits keyboard feedback.
        await page.locator('#outside').focus()
        await page.keyboard.press('Tab')
        await expect(page.locator('#menu-a')).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(page.locator('#menu-b')).toHaveCSS('background-color', active)
        await page.locator('#tree').focus()
        await expect(page.locator('#file-frame')).toHaveCSS('background-color', active)
        await page.locator('#symbol-root button').focus()
        await expect(page.locator('#file-frame')).toHaveCSS('background-color', base)
        await expect(page.locator('#symbol-root')).toHaveCSS('background-color', active)
        await page.locator('#project').focus()
        await expect(page.locator('.code-project-heading')).toHaveCSS('background-color', active)
        await expect(page.locator('#project')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await page.locator('#outside').click()
        await page.locator('#launch').evaluate(el => el.setAttribute('aria-expanded', 'true'))
        await expect(page.locator('#launch')).toHaveCSS('background-color', active)
        await expect(page.locator('.code-project-heading')).toHaveCSS('background-color', base)
        await expect(page.locator('#branch')).toHaveCSS('background-color', base)
        await page.locator('#launch').evaluate(el => el.setAttribute('aria-expanded', 'false'))
        await expect(page.locator('#launch')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await page.screenshot({ path: testInfo.outputPath(`${appearance}-${input}.png`), animations: 'disabled' })
      } finally {
        await context.close()
      }
    })
  }
}
