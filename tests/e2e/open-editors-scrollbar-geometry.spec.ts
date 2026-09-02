import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('Open Editors keeps label and action geometry stable when the eighth row starts scrolling', async ({ page, workspaceRoot }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const workspace = path.join(workspaceRoot, 'open-editors-scrollbar-geometry')
  fs.mkdirSync(workspace, { recursive: true })
  for (let index = 1; index <= 8; index += 1) {
    fs.writeFileSync(
      path.join(workspace, `document-${index}.txt`),
      `Open editor geometry fixture ${index}\n`,
    )
  }

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace, name: 'Open Editors geometry' },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const openEditors = project.getByTestId('code-open-editors')
  const openEditorsTitle = openEditors.locator('.code-open-editors-title')
  for (let index = 1; index <= 7; index += 1) {
    await files.locator(`[data-testid="code-file-row"][data-file-path="document-${index}.txt"]`).dblclick()
    if (index === 1 && await openEditorsTitle.getAttribute('aria-expanded') !== 'true') {
      await openEditorsTitle.click()
    }
    await expect(openEditors.getByTestId('code-open-editor-row')).toHaveCount(index)
  }

  if (await openEditorsTitle.getAttribute('aria-expanded') !== 'true') await openEditorsTitle.click()
  await expect(openEditors.getByTestId('code-open-editor-row')).toHaveCount(7)

  const readGeometry = () => openEditors.evaluate(section => {
    const list = section.querySelector<HTMLElement>('.code-open-editors-list')
    const row = section.querySelector<HTMLElement>('[data-file-path="document-1.txt"]')
    const label = row?.querySelector<HTMLElement>('.code-open-editor-name')
    const action = row?.querySelector<HTMLElement>('.code-open-editor-actions')
    const filesActions = section.closest('.code-project-group')?.querySelector<HTMLElement>('.code-files-header-actions')
    if (!list || !row || !label || !action || !filesActions) return null
    const labelBox = label.getBoundingClientRect()
    const actionBox = action.getBoundingClientRect()
    const filesActionsBox = filesActions.getBoundingClientRect()
    const reservedScrollbarWidth = Number.parseFloat(
      getComputedStyle(list).getPropertyValue('--code-open-editors-scrollbar-width'),
    )
    return {
      actionRight: actionBox.right,
      actionWidth: actionBox.width,
      fileActionsRight: filesActionsBox.right,
      labelLeft: labelBox.left,
      labelWidth: labelBox.width,
      listClientWidth: list.clientWidth,
      listOffsetWidth: list.offsetWidth,
      rowWidth: row.getBoundingClientRect().width,
      actualScrollbarWidth: list.offsetWidth - list.clientWidth,
      scrollbarWidth: reservedScrollbarWidth,
      scrollable: list.scrollHeight > list.clientHeight,
    }
  })

  await expect.poll(async () => {
    const geometry = await readGeometry()
    if (!geometry) return Number.POSITIVE_INFINITY
    return Math.abs(geometry.scrollbarWidth - geometry.actualScrollbarWidth)
  }).toBeLessThanOrEqual(0.01)
  const sevenRows = await readGeometry()
  expect(sevenRows).not.toBeNull()
  expect(
    sevenRows!.scrollbarWidth,
    'seven-row computed scrollbar width must equal offsetWidth - clientWidth',
  ).toBe(sevenRows!.actualScrollbarWidth)
  expect(sevenRows!.scrollable).toBe(false)

  await files.locator('[data-testid="code-file-row"][data-file-path="document-8.txt"]').dblclick()
  await expect(openEditors.getByTestId('code-open-editor-row')).toHaveCount(8)
  await expect.poll(() => readGeometry()).toMatchObject({ scrollable: true })
  const eightRows = await readGeometry()
  expect(eightRows).not.toBeNull()

  for (const property of ['actionRight', 'actionWidth', 'labelLeft', 'labelWidth', 'listClientWidth', 'rowWidth'] as const) {
    expect(Math.abs(eightRows![property] - sevenRows![property]), property).toBeLessThanOrEqual(0.5)
  }
  expect(Math.abs(sevenRows!.actionRight - sevenRows!.fileActionsRight)).toBeLessThanOrEqual(5)
  expect(Math.abs(eightRows!.actionRight - eightRows!.fileActionsRight)).toBeLessThanOrEqual(5)
  expect(
    eightRows!.scrollbarWidth,
    'eight-row computed scrollbar width must equal offsetWidth - clientWidth',
  ).toBe(eightRows!.actualScrollbarWidth)
  expect(eightRows!.scrollbarWidth).toBe(sevenRows!.scrollbarWidth)
})
