import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

async function expectBaseSurface(locator: Locator, expected: string) {
  await expect.poll(() => locator.evaluate(element => {
    // Empty states are transparent. Verify the actual backing surface, not
    // merely the absence of a background declaration on the message itself.
    for (let current: Element | null = element; current; current = current.parentElement) {
      const background = getComputedStyle(current).backgroundColor
      if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background
    }
    return 'transparent'
  })).toBe(expected)
}

test.describe('shared sidebar surfaces', () => {
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    test(`sidebar surfaces stay unified through history states in ${appearance}`, async ({ page, workspaceRoot, isMobile }) => {
      const layout = isMobile ? 'iphone' : 'desktop'
      await page.setViewportSize(isMobile ? { width: 393, height: 852 } : { width: 1440, height: 900 })
      const workspace = path.join(workspaceRoot, 'sample-project')
      const otherWorkspace = path.join(workspaceRoot, 'another-project')
      fs.mkdirSync(workspace)
      fs.mkdirSync(otherWorkspace)
      for (let index = 0; index < 40; index += 1) {
        fs.writeFileSync(path.join(workspace, `note-${String(index).padStart(2, '0')}.txt`), 'Sample content\n')
      }
      for (const [root, name] of [[otherWorkspace, 'Another Agent'], [workspace, 'First Agent'], [workspace, 'Second Agent']]) {
        const response = await page.request.post('/farming/api/control/agents', {
          data: { command: 'bash', workspace: root, name },
        })
        expect(response.ok()).toBeTruthy()
      }

      let releaseHistory!: () => void
      const historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
      let failHistory = false
      await interceptWorkspaceRequests(page, async request => {
        if (request.operation !== 'history') return
        await historyGate
        if (failHistory) return { response: { ok: false, error: { code: 'TEST_HISTORY_FAILURE', message: 'History unavailable', status: 503 } } }
      })

      try {
        await openFarming(page)
        await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
        await page.evaluate(value => {
          document.documentElement.dataset.appearance = value
          document.body.dataset.appearance = value
        }, appearance)
        const sidebar = page.getByTestId('code-sidebar')
        const openDrawer = async () => {
          if (layout === 'iphone' && await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
            const back = page.getByTestId('code-mobile-back')
            if (await back.isVisible()) await back.tap()
            await page.getByTestId('code-mobile-menu').tap()
            // Opening navigation focuses its toggle on the next animation frame.
            // Wait for that modal initialization before testing file-row focus.
            await expect(sidebar.getByTestId('code-sidebar-toggle')).toBeFocused()
          }
        }
        await openDrawer()
        const colors = await sidebar.evaluate(element => {
          const probe = document.createElement('span')
          element.append(probe)
          probe.style.background = 'var(--code-navigation-surface)'
          const base = getComputedStyle(probe).backgroundColor
          probe.style.background = 'var(--code-active-item-surface)'
          const active = getComputedStyle(probe).backgroundColor
          probe.remove()
          return { base, active }
        })
        await expect(sidebar).toHaveCSS('background-color', colors.base)
        const project = page.getByTestId('code-project-group').filter({ hasText: 'sample-project' })
        const files = project.getByTestId('code-files-section')
        const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
        if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
        const history = files.getByTestId('code-git-history-section')
        const historyTitle = history.getByRole('button', { name: 'History', exact: true })
        await historyTitle.click()
        const status = history.locator('.code-git-history-status').first()
        await expect(status).toContainText('Loading')
        await expectBaseSurface(status, colors.base)
        releaseHistory()
        await expect(status).toHaveText('This project is not a Git repository')
        await expectBaseSurface(status, colors.base)
        await expect(history).toHaveCSS('background-color', colors.base)
        await expect(history.locator('.code-git-history-header')).toHaveCSS('background-color', colors.base)
        await page.mouse.move(0, 0)
        await expect(history).toHaveScreenshot(`${layout}-${appearance}-history-non-repository.png`)

        failHistory = true
        await history.getByRole('button', { name: 'Refresh', exact: true }).click()
        await expect(history.locator('.code-git-history-status.error')).toHaveText('History unavailable')
        await expectBaseSurface(history.locator('.code-git-history-status.error'), colors.base)
        failHistory = false

        const git = (...args: string[]) => execFileSync('git', args, {
          cwd: workspace,
          encoding: 'utf8',
          env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T12:00:00Z' },
        })
        git('init', '--quiet', '--initial-branch=main')
        fs.mkdirSync(path.join(workspace, '.empty-hooks'))
        git('config', 'core.hooksPath', '.empty-hooks')
        git('config', 'user.name', 'Sample Author')
        git('config', 'user.email', 'sample@example.test')
        await history.getByRole('button', { name: 'Refresh', exact: true }).click()
        await expect(status).toHaveText('No commits yet')
        await expectBaseSurface(status, colors.base)
        git('add', 'note-00.txt')
        git('commit', '--quiet', '-m', 'Sample commit')
        await history.getByRole('button', { name: 'Refresh', exact: true }).click()
        const entry = history.getByTestId('code-git-history-entry')
        await expect(entry).toHaveCount(1)
        const commit = entry.locator('.code-git-history-commit')
        await commit.click()
        await expect(entry.getByTestId('code-git-history-details')).toBeVisible()
        await expect(entry.getByText('1 file changed', { exact: true })).toBeVisible()
        await expect(commit).toHaveCSS('background-color', colors.active)
        await expectBaseSurface(entry.getByTestId('code-git-history-details'), colors.base)
        await commit.hover()
        await expect(commit).toHaveCSS('background-color', colors.active)
        await expect(entry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await page.mouse.move(0, 0)
        await expect(history).toHaveScreenshot(`${layout}-${appearance}-history-selected.png`)

        // Sections and row types share one focus/hover fill. The selected
        // row's parent must stay on the navigation base throughout.
        for (const control of [project.getByTestId('code-agent-row').first(), filesTitle, historyTitle, commit]) {
          await control.focus()
          await expect(control).toHaveCSS('background-color', colors.active)
          await expect(history).toHaveCSS('background-color', colors.base)
        }
        await historyTitle.click()
        const file = files.locator('[data-testid="code-file-row"][data-file-path="note-00.txt"]')
        await file.click()
        await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
        await openDrawer()
        await file.focus()
        await expect(file.locator('..')).toHaveCSS('background-color', colors.active)
        const openEditorsTitle = project.locator('.code-open-editors-title')
        if (await openEditorsTitle.getAttribute('aria-expanded') !== 'true') await openEditorsTitle.click()
        const openEditor = project.locator('.code-open-editor-row').first()
        await openEditor.locator('.code-open-editor-main').focus()
        await expect(openEditor).toHaveCSS('background-color', colors.active)
        await openEditor.hover()
        await expect(openEditor).toHaveCSS('background-color', colors.active)
        await expect(openEditor.locator('.code-open-editor-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

        const list = page.getByTestId('code-project-list')
        await list.focus()
        await expect(list).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await list.evaluate(element => {
          element.setAttribute('data-test-scroll-finished', 'false')
          element.addEventListener('scrollend', () => {
            element.setAttribute('data-test-scroll-finished', 'true')
          }, { once: true })
        })
        await list.press('PageDown')
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        await expect(list).toHaveAttribute('data-test-scroll-finished', 'true')
        await list.evaluate(element => { element.scrollTop = 240 })
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(240)
        await expect(list).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(files.locator('.code-files-header')).toHaveCSS('background-color', colors.base)
        await page.mouse.move(0, 0)
        await expect(list).toHaveScreenshot(`${layout}-${appearance}-sidebar-scrolled.png`)
        await filesTitle.click()
        await expect(filesTitle).toHaveAttribute('aria-expanded', 'false')
        const bounds = await list.boundingBox()
        expect(bounds).not.toBeNull()
        await page.mouse.click(bounds!.x + 3, bounds!.y + bounds!.height - 3)
        await expect(list).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await filesTitle.click()
        await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
        await expect(list).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(history).toHaveCSS('background-color', colors.base)
      } finally {
        releaseHistory()
      }
    })
  }
})
