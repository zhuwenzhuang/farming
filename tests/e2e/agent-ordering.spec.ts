import fs from 'node:fs'
import path from 'node:path'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function projectAgentIds(project: import('@playwright/test').Locator) {
  return project.getByTestId('code-agent-row').evaluateAll(rows => rows
    .map(row => row.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id)))
}

test('keeps persistent project and pinned Agent order', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-ordering')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  const firstAgentId = await createControlAgent(page, projectDir)
  const secondAgentId = await createControlAgent(page, projectDir)
  const thirdAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })

  await expect(project).toBeVisible()
  await expect.poll(() => projectAgentIds(project)).toEqual([
    thirdAgentId,
    secondAgentId,
    firstAgentId,
  ])

  const sourceRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
  const targetRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${thirdAgentId}"]`)
  await targetRow.click()
  await expect(targetRow).toHaveClass(/active/)
  await sourceRow.dragTo(targetRow, { targetPosition: { x: 80, y: 2 } })
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])
  await expect(targetRow).toHaveClass(/active/)
  await expect(sourceRow).not.toHaveClass(/active/)

  await sourceRow.click()
  await expect(sourceRow).toHaveClass(/active/)

  await page.reload({ waitUntil: 'networkidle' })
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])

  for (const agentId of [secondAgentId, firstAgentId]) {
    const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
      data: { pinned: true },
    })
    expect(response.ok()).toBeTruthy()
  }
  const pinned = page.getByTestId('code-pinned-section')
  await expect.poll(() => projectAgentIds(pinned)).toEqual([secondAgentId, firstAgentId])
  await expect(pinned.locator('[draggable="true"]')).toHaveCount(2)
  await pinned
    .locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    .dragTo(
      pinned.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`),
      { targetPosition: { x: 80, y: 2 } },
    )
  await expect.poll(() => projectAgentIds(pinned)).toEqual([firstAgentId, secondAgentId])
  await page.reload({ waitUntil: 'networkidle' })
  await expect.poll(() => projectAgentIds(pinned)).toEqual([firstAgentId, secondAgentId])

  for (const agentId of [firstAgentId, secondAgentId]) {
    const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
      data: { pinned: false },
    })
    expect(response.ok()).toBeTruthy()
  }
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])

  await createControlAgent(page, projectDir)
  await createControlAgent(page, projectDir)
  const newestAgentId = await createControlAgent(page, projectDir)
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  const density = await project.evaluate(element => {
    const list = element.querySelector<HTMLElement>('.code-agents-section > .code-agent-list')
    const files = element.querySelector<HTMLElement>('[data-testid="code-files-section"]')
    const rows = list
      ? Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-testid="code-agent-row"]'))
      : []
    const showMore = list?.querySelector<HTMLElement>(':scope > .code-agent-list-controls [data-testid="code-agent-show-more"]')
    if (!list || !files || rows.length < 2 || !showMore) throw new Error('Project density fixtures are incomplete')
    const rowRects = rows.map(row => row.getBoundingClientRect())
    const showMoreRect = showMore.getBoundingClientRect()
    return {
      rowHeights: rowRects.map(rect => rect.height),
      rowSteps: rowRects.slice(1).map((rect, index) => rect.top - rowRects[index].top),
      agentToControlGap: showMoreRect.top - rowRects.at(-1)!.bottom,
      controlToFilesGap: files.getBoundingClientRect().top - showMoreRect.bottom,
      showMoreHeight: showMoreRect.height,
    }
  })
  expect(density.rowHeights).toEqual([28, 28, 28, 28, 28])
  expect(density.rowSteps).toEqual([28, 28, 28, 28])
  expect(density.showMoreHeight).toBe(28)
  expect(density.agentToControlGap).toBe(0)
  expect(density.controlToFilesGap).toBeLessThanOrEqual(2)
  await sourceRow.dragTo(
    project.locator(`[data-testid="code-agent-row"][data-agent-id="${newestAgentId}"]`),
    { targetPosition: { x: 80, y: 2 } },
  )
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  await expect(project.getByTestId('code-agent-show-less')).toHaveCount(0)

  const newestRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${newestAgentId}"]`)
  await newestRow.click()
  await sourceRow.dragTo(project.getByTestId('code-agent-show-more'))
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  await expect(sourceRow).toHaveCount(0)
  await project.getByTestId('code-agent-show-more').click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(6)
  const expandedIds = await projectAgentIds(project)
  expect(expandedIds[expandedIds.length - 1]).toBe(firstAgentId)
})

test('keeps Project Files on workspace identity while its source Agent changes', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'stable-project-files')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(projectDir, 'two.txt'), 'two\n')
  const filesRequestRootIds: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/farming/api/files/')) return
    const rootId = url.searchParams.get('rootId')
    if (rootId) filesRequestRootIds.push(rootId)
  })
  const expectedFilesId = projectFilesWorkspaceId(projectDir)

  await openFarming(page)
  const firstAgentId = await createControlAgent(page, projectDir)
  const secondAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({
    has: page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`),
  })
  await expect(project).toBeVisible()
  await expect.poll(() => projectAgentIds(project)).toEqual([secondAgentId, firstAgentId])

  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
    await filesTitle.click()
  }
  const oneRow = page.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
  const twoRow = page.locator('[data-testid="code-file-row"][data-file-path="two.txt"]')
  await expect(oneRow).toBeVisible()
  await expect.poll(() => filesRequestRootIds.includes(expectedFilesId)).toBe(true)
  expect(filesRequestRootIds).not.toContain(firstAgentId)
  expect(filesRequestRootIds).not.toContain(secondAgentId)

  let oneRowBox: Awaited<ReturnType<typeof oneRow.boundingBox>> = null
  await expect.poll(async () => {
    oneRowBox = await oneRow.boundingBox()
    return Boolean(oneRowBox)
  }).toBe(true)
  await page.mouse.move(oneRowBox!.x + oneRowBox!.width / 2, oneRowBox!.y + oneRowBox!.height / 2)
  await page.mouse.down()

  const reorderResponse = await page.request.post(`/farming/api/agents/${firstAgentId}/reorder`, {
    data: { beforeAgentId: '', afterAgentId: secondAgentId },
  })
  expect(reorderResponse.ok()).toBeTruthy()
  await expect.poll(() => projectAgentIds(project)).toEqual([firstAgentId, secondAgentId])
  await page.mouse.up()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('one.txt')

  const deleteResponse = await page.request.delete(`/farming/api/control/agents/${secondAgentId}`)
  expect(deleteResponse.ok()).toBeTruthy()
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)).toHaveCount(0)
  await expect(twoRow).toBeVisible()
  await twoRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('two.txt')
  await expect.poll(() => filesRequestRootIds.includes(expectedFilesId)).toBe(true)
  expect(filesRequestRootIds).not.toContain(firstAgentId)
  expect(filesRequestRootIds).not.toContain(secondAgentId)
  await page.getByTestId('code-file-editor-back').click()
  await expect(project.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)).toHaveClass(/active/)
})
