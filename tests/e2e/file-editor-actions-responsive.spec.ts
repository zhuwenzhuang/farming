import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const appearances = ['light', 'dark', 'paper'] as const

async function setAppearance(page: Page, appearance: typeof appearances[number]) {
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate(value => {
    document.documentElement.dataset.appearance = value
    document.body.dataset.appearance = value
  }, appearance)
}

async function capture(page: Page, testInfo: TestInfo, name: string, desktop = false) {
  const screenshot = testInfo.outputPath(`${name}.png`)
  if (desktop) {
    await page.getByTestId('code-file-editor').locator('.code-file-editor-header').screenshot({
      path: screenshot,
      animations: 'disabled',
    })
  } else {
    await page.screenshot({ path: screenshot, animations: 'disabled' })
  }
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
}

async function closeSidebar(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  if (!await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
    await page.getByTestId('code-sidebar-toggle').click()
  }
  await expect(sidebar).toHaveClass(/collapsed/)
}

test('file actions use a keyboard-accessible More menu without narrow horizontal overflow', async ({ page, workspaceRoot }, testInfo) => {
  testInfo.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const workspace = path.join(workspaceRoot, 'responsive-file-actions')
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'docs', 'guide.md'), [
    '# Responsive file actions',
    '',
    'The narrow toolbar keeps primary actions visible and moves secondary actions into More.',
  ].join('\n'))
  fs.writeFileSync(path.join(workspace, 'docs', 'index.md'), '# Index\n')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace, name: 'Responsive file actions' },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const docs = files.locator('[data-testid="code-file-row"][data-file-path="docs"]')
  if (await docs.getAttribute('aria-expanded') !== 'true') await docs.click()
  const guide = files.locator('[data-testid="code-file-row"][data-file-path="docs/guide.md"]')
  await guide.click()

  const editor = page.getByTestId('code-file-editor')
  const actions = editor.locator('.code-file-editor-actions')
  const reveal = editor.getByTestId('code-file-editor-reveal')
  const more = editor.getByTestId('code-file-editor-more')
  const preview = editor.getByTestId('code-file-markdown-preview')
  const article = preview.locator('.code-markdown-preview')
  await expect(preview.getByRole('heading', { name: 'Responsive file actions' })).toBeVisible()
  await expect(reveal).toBeVisible()
  await expect(reveal).toHaveAccessibleName('Reveal docs/guide.md in Explorer')
  await expect(reveal).toHaveAttribute('title', 'Reveal docs/guide.md in Explorer')
  await expect(more).toBeHidden()

  for (const appearance of appearances) {
    await setAppearance(page, appearance)
    await capture(page, testInfo, `file-actions-desktop-${appearance}`, true)
  }

  await closeSidebar(page)
  await reveal.click()
  await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
  await expect(guide).toHaveClass(/selected/)

  await page.setViewportSize({ width: 393, height: 852 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await closeSidebar(page)
  await expect(reveal).toBeHidden()
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute('aria-haspopup', 'menu')
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  const narrowGeometry = async () => actions.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const viewport = window.visualViewport
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: rect.left,
      right: rect.right,
      viewportWidth: document.documentElement.clientWidth,
      visualViewportLeft: viewport?.offsetLeft ?? 0,
      visualViewportRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      controls: Array.from(element.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .filter(child => {
          const style = getComputedStyle(child)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map(child => {
          const bounds = child.getBoundingClientRect()
          return {
            testId: child.dataset.testid || child.className,
            left: bounds.left,
            right: bounds.right,
          }
        }),
    }
  })
  await expect.poll(narrowGeometry).toMatchObject({ overflowX: 'hidden', pageOverflow: 0 })
  let geometry = await narrowGeometry()
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  for (const control of geometry.controls) {
    expect(control.left, `${control.testId} left edge`).toBeGreaterThanOrEqual(geometry.visualViewportLeft - 1)
    expect(control.right, `${control.testId} right edge`).toBeLessThanOrEqual(geometry.visualViewportRight + 1)
  }

  await page.setViewportSize({ width: 360, height: 780 })
  await page.evaluate(() => {
    document.documentElement.style.scrollbarGutter = 'stable'
    document.documentElement.style.overflowY = 'scroll'
    window.dispatchEvent(new Event('resize'))
  })
  await expect.poll(narrowGeometry).toMatchObject({ overflowX: 'hidden', pageOverflow: 0 })
  geometry = await narrowGeometry()
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  expect(geometry.pageOverflow).toBe(0)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  for (const control of geometry.controls) {
    expect(control.left, `${control.testId} left edge at 360px`).toBeGreaterThanOrEqual(geometry.visualViewportLeft - 1)
    expect(control.right, `${control.testId} right edge at 360px`).toBeLessThanOrEqual(geometry.visualViewportRight + 1)
  }

  for (const appearance of appearances) {
    await setAppearance(page, appearance)
    await more.focus()
    await more.press('ArrowDown')
    const menu = page.getByTestId('code-file-editor-more-menu')
    await expect(menu).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    const firstItem = menu.getByTestId('code-file-editor-more-reveal')
    await expect(firstItem).toBeFocused()
    const bounds = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const viewport = window.visualViewport
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportLeft: viewport?.offsetLeft ?? 0,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
        viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
      }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.viewportLeft)
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportRight)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportBottom)
    await capture(page, testInfo, `file-actions-narrow-${appearance}`)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()
  }

  await more.press('ArrowDown')
  await page.getByTestId('code-file-editor-more-reveal').press('Enter')
  await expect(page.getByTestId('code-file-editor-more-menu')).toHaveCount(0)
  await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
  await expect(guide).toHaveClass(/selected/)

  await closeSidebar(page)
  await more.press('ArrowDown')
  const wide = page.getByTestId('code-file-editor-more-markdown-wide')
  await wide.focus()
  await expect(wide).toBeFocused()
  await wide.press('Enter')
  await expect(article).toHaveAttribute('data-layout', 'wide')
  await expect(page.getByTestId('code-file-editor-more-menu')).toHaveCount(0)

  await more.click()
  await expect(page.getByTestId('code-file-editor-more-menu')).toBeVisible()
  await page.mouse.click(4, 840)
  await expect(page.getByTestId('code-file-editor-more-menu')).toHaveCount(0)

})
