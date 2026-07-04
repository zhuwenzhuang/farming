import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  getFirstAgentId,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function expectNoPageOverflow(page: import('@playwright/test').Page) {
  await expect.poll(async () => page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ innerWidth: 390, scrollWidth: 390 })
}

async function revealMobileSidebar(page: import('@playwright/test').Page) {
  const workspace = page.getByTestId('code-workspace')
  if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) {
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
}

test.describe('mobile Farming Code user story', () => {
  test('uses mobile options for language preferences', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Farming Code')
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Local server')
    await expectNoPageOverflow(page)

    await page.getByTestId('code-mobile-more').click()
    await expect(page.getByTestId('code-options-menu')).toBeVisible()
    await expect(page.getByTestId('code-options-menu')).not.toContainText('Appearance:')
    await expect(page.getByTestId('code-options-menu')).toContainText('Dark')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('New Agent')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('Agent actions')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('Search')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('History')
    await expect.poll(() => page.locator('body').getAttribute('data-appearance')).toBe('light')

    await page.getByRole('menuitemradio', { name: /Language: Chinese/ }).click()
    await expect(page.getByTestId('code-mobile-more')).toHaveAttribute('aria-label', '打开选项')
    await expect(page.getByTestId('code-empty-workspace')).toContainText('启动或选择一个 Agent')
    await expect(page.getByTestId('code-composer').locator('textarea')).toHaveAttribute('placeholder', '先打开一个 Agent 终端')

    await page.getByTestId('code-empty-workspace').getByRole('button', { name: '新建 Agent' }).click()
    await expect(page.getByTestId('input-dialog')).toContainText('启动新 Agent')
    await expect(page.getByTestId('input-dialog-close')).toHaveAttribute('aria-label', '关闭')
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.input-dialog .group-label').first()).toContainText(/代码 Agent|其他/)
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()

    await page.getByTestId('code-mobile-more').click()
    await expect(page.getByRole('menuitemradio', { name: /语言：中文/ })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('code-options-menu')).toContainText('中文')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('✓ 语言：中文')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('外观：')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('新建 Agent')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('Agent 操作')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('搜索')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('历史')
    await page.keyboard.press('Escape')

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('code-sidebar-options')).toBeVisible()
    await page.getByTestId('code-sidebar-options').click()
    await expect(page.getByTestId('code-options-menu')).not.toContainText('外观：')
    await expect(page.getByTestId('code-options-menu')).toContainText('深色')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('新建 Agent')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('Agent 操作')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('搜索')
    await expect(page.getByTestId('code-options-menu')).not.toContainText('历史')
    await expect.poll(() => page.locator('body').getAttribute('data-appearance')).toBe('light')

    const settingsResponse = await page.request.get('/farming/api/settings')
    const settingsData = await settingsResponse.json()
    expect(settingsData.settings?.appearance).toBe('light')
    expect(settingsData.settings?.language).toBe('zh')
  })

  test('returns to a remote shell, opens files, and uses touch-accessible blame', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'mobile-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), [
      '# Mobile project',
      'mobile-target-line',
      'blame-target-line',
      '',
    ].join('\n'))
    git(projectDir, ['init'])
    git(projectDir, ['config', 'user.email', 'mobile-story@example.com'])
    git(projectDir, ['config', 'user.name', 'Mobile Story'])
    git(projectDir, ['add', 'README.md'])
    git(projectDir, ['commit', '-m', 'Seed mobile README'])

    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expectNoPageOverflow(page)

    await revealMobileSidebar(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', projectDir)

    const agentId = await getFirstAgentId(page)
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('bash')
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    await expectNoPageOverflow(page)

    await expect(page.getByTestId('code-composer-mic')).toHaveCount(0)
    await expect(page.getByTestId('code-composer-send')).toBeVisible()
    await page.getByTestId('code-composer').locator('textarea').focus()
    await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()

    const marker = `mobile-story-${Date.now()}`
    await page.getByTestId('code-composer').locator('textarea').fill(`echo ${marker}`)
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(marker)

    await revealMobileSidebar(page)
    const filesSection = page.getByTestId('code-files-section').first()
    const filesToggle = filesSection.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') {
      await filesToggle.click()
    }
    const fileSearch = filesSection.getByPlaceholder('Search or path:line')
    await fileSearch.fill('README.md:2')
    await fileSearch.press('Enter')

    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('README.md')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 1')
    await expectNoPageOverflow(page)

    const gutterLine = page.locator('.monaco-editor .margin-view-overlays .line-numbers').first()
    await expect(gutterLine).toBeVisible()
    await gutterLine.click({ button: 'right', force: true })
    await page.getByRole('menuitem', { name: 'Annotate with Blame' }).click()
    const inlineBlame = page.locator('.code-file-inline-blame')
    await expect(inlineBlame).toHaveCount(3)
    await expect.poll(async () => inlineBlame.first().evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(110)
    await inlineBlame.first().click()
    await expect(page.getByTestId('code-file-blame-detail')).toContainText('Seed mobile README')
    await expectNoPageOverflow(page)

    await revealMobileSidebar(page)
    await page.getByTestId('code-nav-search').click()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Search')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expectNoPageOverflow(page)

    await revealMobileSidebar(page)
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('History')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expectNoPageOverflow(page)
  })
})
