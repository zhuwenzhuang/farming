import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const appearances = {
  light: {
    default: 'rgba(95, 103, 94, 0.28)',
    hover: 'rgba(95, 103, 94, 0.4)',
    active: 'rgba(95, 103, 94, 0.52)',
    monacoDefault: 'rgba(95, 103, 94, 0.28)',
    monacoHover: 'rgba(95, 103, 94, 0.4)',
    monacoActive: 'rgba(95, 103, 94, 0.52)',
  },
  dark: {
    default: 'rgba(139, 148, 158, 0.32)',
    hover: 'rgba(139, 148, 158, 0.44)',
    active: 'rgba(139, 148, 158, 0.56)',
    monacoDefault: 'rgba(139, 148, 158, 0.32)',
    monacoHover: 'rgba(139, 148, 158, 0.44)',
    monacoActive: 'rgba(139, 148, 158, 0.56)',
  },
  paper: {
    default: 'rgba(98, 99, 91, 0.22)',
    hover: 'rgba(98, 99, 91, 0.32)',
    active: 'rgba(98, 99, 91, 0.42)',
    monacoDefault: 'rgba(98, 99, 91, 0.22)',
    monacoHover: 'rgba(98, 99, 91, 0.32)',
    monacoActive: 'rgba(98, 99, 91, 0.42)',
  },
} as const

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function setAppearance(page: Page, appearance: keyof typeof appearances) {
  await page.locator('body').evaluate((body, value) => {
    document.documentElement.dataset.appearance = value
    body.dataset.appearance = value
  }, appearance)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
}

async function nativeScrollbarStyle(locator: Locator) {
  return locator.evaluate(element => {
    const scrollbar = getComputedStyle(element, '::-webkit-scrollbar')
    const track = getComputedStyle(element, '::-webkit-scrollbar-track')
    const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
    return {
      width: scrollbar.width,
      height: scrollbar.height,
      track: track.backgroundColor,
      thumb: thumb.backgroundColor,
      thumbBorder: thumb.borderTopWidth,
      thumbRadius: thumb.borderTopLeftRadius,
      thumbClip: thumb.backgroundClip,
    }
  })
}

async function expectNativeScrollbar(locator: Locator, color: string) {
  await expect.poll(() => nativeScrollbarStyle(locator)).toEqual({
    width: '8px',
    height: '8px',
    track: 'rgba(0, 0, 0, 0)',
    thumb: color,
    thumbBorder: '2px',
    thumbRadius: '999px',
    thumbClip: 'content-box',
  })
}

test('unifies native, Xterm, and Monaco scrollbars across every Code appearance', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'scrollbar-theme')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'long-file.ts'),
    Array.from({ length: 400 }, (_, index) => `export const line${index} = ${index}\n`).join(''),
  )

  await openFarming(page)
  const agentId = await createControlAgent(page, projectDir)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agentRow.click()
  const terminalViewport = page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .xterm-viewport`,
  )
  await expect(terminalViewport).toBeVisible()

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const fileRow = files.locator('[data-testid="code-file-row"][data-file-path="long-file.ts"]')
  await expect(fileRow).toBeVisible()

  await page.locator('body').evaluate(body => {
    const probe = document.createElement('div')
    probe.dataset.testid = 'code-scrollbar-probe'
    Object.assign(probe.style, {
      position: 'fixed',
      top: '80px',
      right: '24px',
      zIndex: '20000',
      width: '120px',
      height: '120px',
      overflowX: 'hidden',
      overflowY: 'scroll',
      background: 'var(--code-bg-raised)',
    })
    const content = document.createElement('div')
    content.style.height = '1200px'
    probe.append(content)
    body.append(probe)
  })

  const probe = page.getByTestId('code-scrollbar-probe')
  const projectList = page.getByTestId('code-project-list')

  for (const [appearance, colors] of Object.entries(appearances) as Array<[
    keyof typeof appearances,
    typeof appearances[keyof typeof appearances],
  ]>) {
    await setAppearance(page, appearance)
    await page.mouse.move(0, 0)
    await expectNativeScrollbar(probe, colors.default)
    await expectNativeScrollbar(projectList, colors.default)
    await expectNativeScrollbar(terminalViewport, colors.default)

    await fileRow.click()
    const editor = page.getByTestId('code-file-editor')
    await expect(editor).toBeVisible()
    const monacoScrollbar = editor.locator('.monaco-scrollable-element > .scrollbar.vertical').first()
    const monacoThumb = monacoScrollbar.locator(':scope > .slider')
    await expect(monacoScrollbar).toBeVisible()
    await expect.poll(async () => (await monacoScrollbar.boundingBox())?.width ?? 0).toBe(8)
    await expect.poll(() => monacoThumb.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        clip: style.backgroundClip,
      }
    })).toEqual({
      background: colors.monacoDefault,
      border: '2px',
      radius: '999px',
      clip: 'content-box',
    })
    await monacoThumb.hover()
    await expect.poll(() => monacoThumb.evaluate(element => getComputedStyle(element).backgroundColor))
      .toBe(colors.monacoHover)
    await page.mouse.down()
    await expect.poll(() => monacoThumb.evaluate(element => getComputedStyle(element).backgroundColor))
      .toBe(colors.monacoActive)
    await page.mouse.up()

    await agentRow.click()
    await expect(terminalViewport).toBeVisible()
  }

  await page.getByTestId('code-sidebar-options').click()
  const settingsScroller = page.locator('.code-settings-panel-body')
  await expect(settingsScroller).toBeVisible()
  await expectNativeScrollbar(settingsScroller, appearances.paper.default)
})
