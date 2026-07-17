import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function resizeSidebar(page: Page, width: number) {
  const sidebar = page.getByTestId('code-sidebar')
  const sidebarBox = await sidebar.boundingBox()
  const resizerBox = await page.getByTestId('code-sidebar-resizer').boundingBox()
  if (!sidebarBox || !resizerBox) throw new Error('Sidebar resize handles are unavailable')

  const pointerY = resizerBox.y + Math.min(120, resizerBox.height / 2)
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, pointerY)
  await page.mouse.down()
  await page.mouse.move(sidebarBox.x + width, pointerY)
  await page.mouse.up()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(width)
}

async function rowProjection(row: ReturnType<Page['locator']>) {
  return row.evaluate(element => {
    const title = element.querySelector<HTMLElement>('.code-agent-name')
    const provider = element.querySelector<HTMLElement>('.code-agent-row-provider-icon')
    const age = element.querySelector<HTMLElement>('.code-agent-relative-age')
    const detail = element.querySelector<HTMLElement>('.code-agent-meta')
    if (!title || !provider || !age || !detail) throw new Error('Responsive Agent row fields are missing')
    return {
      rowHeight: Math.round((element as HTMLElement).getBoundingClientRect().height),
      title: title.textContent,
      titleClientWidth: Math.round(title.getBoundingClientRect().width),
      titleScrollWidth: title.scrollWidth,
      providerDisplay: getComputedStyle(provider).display,
      ageDisplay: getComputedStyle(age).display,
      detailDisplay: getComputedStyle(detail).display,
      detail: detail.textContent,
    }
  })
}

test('reveals more Agent row information as the sidebar widens', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'responsive-agent-row')
  fs.mkdirSync(projectDir, { recursive: true })
  const longTitle = 'public static void main(String[] args) — verify adaptive Agent row information'

  await openFarming(page)
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: projectDir },
  })
  expect(createResponse.ok()).toBeTruthy()
  const { agentId } = await createResponse.json() as { agentId: string }
  expect(agentId).toBeTruthy()

  const renameResponse = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { customTitle: longTitle },
  })
  expect(renameResponse.ok()).toBeTruthy()

  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row.locator('.code-agent-name')).toHaveText(longTitle)
  await expect(row.getByTestId('code-agent-row-age')).toHaveCount(1)

  const compact = await rowProjection(row)
  expect(compact.titleScrollWidth).toBeGreaterThan(compact.titleClientWidth)
  expect(compact.providerDisplay).toBe('none')
  expect(compact.ageDisplay).toBe('none')
  expect(compact.detailDisplay).toBe('none')

  await resizeSidebar(page, 480)
  const roomy = await rowProjection(row)
  expect(roomy.title).toBe(longTitle)
  expect(roomy.rowHeight).toBe(compact.rowHeight)
  expect(roomy.titleClientWidth).toBeGreaterThan(compact.titleClientWidth + 100)
  expect(roomy.providerDisplay).not.toBe('none')
  expect(roomy.ageDisplay).not.toBe('none')
  expect(roomy.detailDisplay).toBe('none')

  await resizeSidebar(page, 700)
  const wide = await rowProjection(row)
  expect(wide.rowHeight).toBe(compact.rowHeight)
  expect(wide.providerDisplay).not.toBe('none')
  expect(wide.ageDisplay).not.toBe('none')
  expect(wide.detailDisplay).toBe('block')
  expect(wide.detail).toBe('bash')
})
