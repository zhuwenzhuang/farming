import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function rect(locator: Locator) {
  return locator.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
}

test('scrolls Agent rows immediately and keeps long lists reachable before the file tree ends', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  testInfo.setTimeout(120_000)
  await page.setViewportSize({ width: isMobile ? 393 : 1280, height: 400 })
  const workspace = path.join(workspaceRoot, 'scrollable-sessions')
  fs.mkdirSync(workspace, { recursive: true })
  for (let index = 0; index < 100; index++) {
    fs.writeFileSync(path.join(workspace, `sample-${String(index).padStart(3, '0')}.txt`), 'Sample content\n')
  }
  for (let index = 0; index < 10; index++) {
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
    expect(response.ok()).toBeTruthy()
  }
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  const openDrawer = async () => {
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      const back = page.getByTestId('code-mobile-back')
      if (await back.isVisible()) await back.click()
      await page.getByTestId('code-mobile-menu').click()
    }
  }
  await openDrawer()
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const title = files.locator('.code-files-title')
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  await files.locator('[data-file-path="sample-000.txt"]').click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await openDrawer()
  const editorsTitle = project.locator('.code-open-editors-title')
  if (await editorsTitle.getAttribute('aria-expanded') !== 'true') await editorsTitle.click()
  const scroller = page.getByTestId('code-project-list')
  const agents = project.getByTestId('code-agent-row')
  const scrollTo = async (offset: number) => {
    await scroller.evaluate((element, value) => { element.scrollTop = value }, offset)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(offset)
  }
  const sample = () => project.evaluate(group => {
    const owner = group.closest<HTMLElement>('.code-project-list')!
    const rows = [...group.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"]')]
    const last = rows.at(-1)!.getBoundingClientRect()
    return {
      scrollTop: owner.scrollTop,
      remaining: owner.scrollHeight - owner.clientHeight - owner.scrollTop,
      firstTop: rows[0]!.getBoundingClientRect().top,
      lastTop: last.top,
      lastBottom: last.bottom,
      bottom: owner.getBoundingClientRect().bottom,
    }
  })
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await scrollTo(0)
    const before = await sample()
    const first = await agents.first().boundingBox()
    if (isMobile) {
      // WebKit's automation has no native swipe API; exercise its shared
      // scroll geometry and actual touch activation below.
      await scrollTo(24)
    } else {
      await page.mouse.move(first!.x + 80, first!.y + first!.height / 2)
      await page.mouse.wheel(0, 24)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(24)
    }
    const after = await sample()
    expect(Math.abs(after.firstTop - before.firstTop + 24)).toBeLessThanOrEqual(1)
    if (!isMobile) {
      // The pointer remains over the next Agent; reverse input must also
      // move the list without traversing Files first.
      await page.mouse.wheel(0, -24)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
      expect(Math.abs((await sample()).firstTop - before.firstTop)).toBeLessThanOrEqual(1)
    }
  }
  await scrollTo(0)
  await project.getByTestId('code-agent-show-more').click()
  await expect(agents).toHaveCount(10)
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await scrollTo(0)
    const before = await sample()
    expect(before.lastTop).toBeGreaterThan(before.bottom)
    const delta = Math.ceil(before.lastBottom - before.bottom + 40)
    const first = await agents.first().boundingBox()
    if (isMobile) await scrollTo(delta)
    else {
      await page.mouse.move(first!.x + 80, first!.y + first!.height / 2)
      await page.mouse.wheel(0, delta)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(delta)
    }
    const after = await sample()
    expect(Math.abs(after.lastTop - before.lastTop + delta)).toBeLessThanOrEqual(1)
    expect(after.lastBottom).toBeLessThan(after.bottom)
    expect(after.remaining).toBeGreaterThan(1_000)
    await scrollTo(1_200)
    const readHeaders = () => project.evaluate(group => {
      const projectRow = group.querySelector<HTMLElement>('.code-project-row')!
      const editors = group.querySelector<HTMLElement>('.code-open-editors')!
      const filesHeader = group.querySelector<HTMLElement>('.code-files-header')!
      const visibleBottom = (element: HTMLElement) => element.getBoundingClientRect().bottom
        - Number.parseFloat(getComputedStyle(element).paddingBottom || '0')
      return {
        projectBottom: visibleBottom(projectRow), editorsTop: editors.getBoundingClientRect().top,
        editorsBottom: visibleBottom(editors), filesTop: filesHeader.getBoundingClientRect().top,
        editorsMargin: Number.parseFloat(getComputedStyle(editors).marginTop)
          + Number.parseFloat(getComputedStyle(editors).marginBottom),
      }
    })
    await expect.poll(async () => {
      const headers = await readHeaders()
      return Math.max(
        Math.abs(headers.editorsTop - headers.projectBottom),
        Math.abs(headers.filesTop - headers.editorsBottom - headers.editorsMargin),
      )
    }).toBeLessThanOrEqual(1)
    await page.mouse.move(0, 0)
    const screenshotName = `${isMobile ? 'compact' : 'desktop'}-${appearance}-sessions-scrolled`
    const screenshotPath = testInfo.outputPath(`${screenshotName}.png`)
    await scroller.screenshot({ path: screenshotPath, animations: 'disabled' })
    await testInfo.attach(screenshotName, {
      path: screenshotPath, contentType: 'image/png',
    })
  }
  await scrollTo(0)
  const finalRows = await sample()
  await scrollTo(Math.ceil(finalRows.lastBottom - finalRows.bottom + 40))
  const last = await agents.last().boundingBox()
  // Coordinates keep locator auto-scrolling from concealing unreachable rows.
  if (isMobile) await page.touchscreen.tap(last!.x + 80, last!.y + last!.height / 2)
  else await page.mouse.click(last!.x + 80, last!.y + last!.height / 2)
  await openDrawer()
  await expect(agents.last()).toHaveClass(/active/)
})

test('keeps composed sidebar density and alignment through resize, expansion, and row actions', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  testInfo.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'sidebar-spacing')
  fs.mkdirSync(path.join(workspace, 'src', 'components', 'nested'), { recursive: true })
  for (const name of ['README.md', 'src/app.ts', 'src/components/card.ts', 'src/components/nested/item.ts']) {
    fs.writeFileSync(path.join(workspace, name), 'Sample content\n')
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.name', 'Sample Author')
  git('config', 'user.email', 'sample@example.test')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Sample files')
  fs.appendFileSync(path.join(workspace, 'README.md'), 'Changed content\n')
  fs.appendFileSync(path.join(workspace, 'src/app.ts'), 'Changed content\n')
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Untracked content\n')
  for (const command of ['bash', 'codex']) {
    const response = await page.request.post('/farming/api/control/agents', { data: { command, workspace } })
    expect(response.ok()).toBeTruthy()
  }
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  const openDrawer = async () => {
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      const back = page.getByTestId('code-mobile-back')
      if (await back.isVisible()) await back.click()
      await page.getByTestId('code-mobile-menu').click()
    }
  }
  await openDrawer()
  const project = page.getByTestId('code-project-group').filter({ hasText: 'sidebar-spacing' })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const readme = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
  await readme.click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await openDrawer()
  const editorsTitle = project.locator('.code-open-editors-title')
  if (await editorsTitle.getAttribute('aria-expanded') !== 'true') await editorsTitle.click()
  const list = page.getByTestId('code-project-list')
  const setChangeGroupsExpanded = async (expanded: boolean) => {
    for (const toggle of await files.locator('.code-file-change-group-toggle').all()) {
      if ((await toggle.getAttribute('aria-expanded')) === String(expanded)) continue
      await toggle.scrollIntoViewIfNeeded()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', String(expanded))
    }
  }

  // A touch-capable wide viewport and a narrow mouse viewport both obey width,
  // not a second density policy based on the input device.
  for (const compact of [false, true, false]) {
    await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
    if (compact) {
      // Responsive ownership updates after the viewport event. Wait for the
      // real compact transition before reopening the drawer; sampling the old
      // desktop class can leave every sidebar row hidden a frame later.
      await expect(sidebar).toHaveClass(/collapsed/)
      await openDrawer()
      await expect(sidebar).not.toHaveClass(/collapsed/)
    }
    const height = compact ? 28 : 24
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      await setChangeGroupsExpanded(false)
      await list.evaluate(element => { element.scrollTop = 0 })
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
      await expect.poll(() => rect(project.locator('.code-open-editor-row'))).toMatchObject({ height })
      await expect.poll(() => rect(readme)).toMatchObject({ height })
      expect((await rect(editorsTitle)).x).toBe((await rect(filesTitle)).x)
      const refresh = await rect(files.getByTestId('code-files-refresh'))
      const close = await rect(project.locator('.code-open-editor-close'))
      expect(close.x + close.width / 2).toBe(refresh.x + refresh.width / 2)
      if (compact) {
        const titleRect = await rect(project.getByTestId('code-project-title'))
        const actionRect = await rect(project.getByTestId('code-project-new-agent'))
        expect(actionRect.y + actionRect.height / 2).toBe(titleRect.y + titleRect.height / 2)
        for (const agent of await project.getByTestId('code-agent-row').all()) {
          expect((await rect(agent)).height).toBe(44)
          const more = await rect(agent.getByTestId('code-agent-row-more'))
          expect(more.height).toBe(44)
          expect(more.x + more.width / 2).toBe(actionRect.x + actionRect.width / 2)
        }
        const fileAction = await rect(readme.locator('.code-file-row-actions'))
        expect(fileAction.x + fileAction.width / 2).toBe(refresh.x + refresh.width / 2)
        expect(fileAction.height).toBe(height)
      }
      await page.mouse.move(0, 0)
      const screenshotPath = testInfo.outputPath(`${isMobile ? 'touch' : 'mouse'}-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
      await list.screenshot({ path: screenshotPath, animations: 'disabled' })
      await testInfo.attach(`${compact ? 'compact' : 'desktop'}-${appearance}`, { path: screenshotPath, contentType: 'image/png' })
    }
    await setChangeGroupsExpanded(true)
    const changes = files.locator('.code-file-change-main')
    await expect(changes).toHaveCount(3)
    for (const change of await changes.all()) expect((await rect(change)).height).toBe(height)
    const changeLabels = await files.locator('.code-file-change-name').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().x))
    expect(new Set(changeLabels).size).toBe(1)
    const labelPositions: number[] = []
    for (const directory of ['src', 'src/components', 'src/components/nested']) {
      const row = files.locator(`[data-testid="code-file-row"][data-file-path="${directory}"]`)
      await row.scrollIntoViewIfNeeded()
      if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
      labelPositions.push((await rect(row.locator('.code-file-name'))).x)
    }
    const deepFile = files.locator('[data-testid="code-file-row"][data-file-path="src/components/nested/item.ts"]')
    await deepFile.scrollIntoViewIfNeeded()
    labelPositions.push((await rect(deepFile.locator('.code-file-name'))).x)
    expect(labelPositions.slice(1).map((x, index) => x - labelPositions[index]!)).toEqual([8, 8, 8])
    await expect.poll(() => files.getByTestId('code-file-row').evaluateAll(rows => {
      const bounds = rows.map(row => row.getBoundingClientRect())
      return bounds.slice(1).map((box, index) => box.y - bounds[index]!.y - bounds[index]!.height)
    })).toEqual(Array((await files.getByTestId('code-file-row').count()) - 1).fill(0))
    if (compact) {
      const action = deepFile.locator('.code-file-row-actions')
      if (isMobile) await action.tap()
      else await action.click()
      await expect(page.getByTestId('code-file-context-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-file-context-menu')).toHaveCount(0)
    }
  }
})


test('collapsed Git Projects share Agent row density in every appearance and viewport', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  const workspaces = ['compact-project-a', 'compact-project-b', 'expanded-project'].map(name => path.join(workspaceRoot, name))
  for (const workspace of workspaces) {
    fs.mkdirSync(workspace)
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace })
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
    expect(response.ok()).toBeTruthy()
  }
  for (let index = 0; index < 5; index += 1) {
    const extraAgent = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: workspaces[2] },
    })
    expect(extraAgent.ok()).toBeTruthy()
  }
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  const projects = workspaces.map(workspace => page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) }))
  for (const compact of [false, true, false]) {
    await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
    await expect(page.locator('body')).toHaveClass(compact ? /code-compact-layout/ : /^(?!.*code-compact-layout)/)
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      const back = page.getByTestId('code-mobile-back')
      if (await back.isVisible()) await back.click()
      await page.getByTestId(compact ? 'code-mobile-menu' : 'code-sidebar-toggle').click()
    }
    const height = compact ? 44 : 28
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      for (const project of projects.slice(0, 2)) {
        const title = project.getByTestId('code-project-title')
        if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
        await expect(project.getByTestId('code-project-worktree')).toBeVisible()
        await title.click()
        await expect(project.getByTestId('code-project-worktree')).toHaveCount(0)
        await expect(project.getByTestId('code-project-agent-visibility')).toHaveCount(0)
        await expect.poll(() => rect(project)).toMatchObject({ height })
        await expect.poll(() => rect(title)).toMatchObject({ height })
      }
      const collapsedBounds = await Promise.all(projects.slice(0, 2).map(rect))
      collapsedBounds.sort((a, b) => a.y - b.y)
      expect(collapsedBounds[1]!.y - collapsedBounds[0]!.y - height).toBe(0)
      const agents = projects[2]!.getByTestId('code-agent-row')
      await expect(agents).toHaveCount(5)
      const agentBounds = await Promise.all((await agents.all()).map(rect))
      expect(agentBounds.map(bounds => bounds.height)).toEqual(Array(5).fill(height))
      expect(agentBounds.slice(1).map((bounds, index) => bounds.y - agentBounds[index]!.y - height)).toEqual([0, 0, 0, 0])
      expect((await rect(projects[2]!.getByTestId('code-agent-show-more'))).height).toBe(height)
      await page.mouse.move(0, 0)
      const screenshotPath = testInfo.outputPath(`collapsed-${isMobile ? 'touch' : 'mouse'}-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
      await page.getByTestId('code-project-list').screenshot({ path: screenshotPath, animations: 'disabled' })
      await testInfo.attach(`collapsed-${compact ? 'compact' : 'desktop'}-${appearance}`, { path: screenshotPath, contentType: 'image/png' })
    }
  }
})
