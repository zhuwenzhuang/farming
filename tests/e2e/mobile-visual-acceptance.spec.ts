import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const VIEWPORTS = [
  { name: '320x844', width: 320, height: 844 },
  { name: '390x844', width: 390, height: 844 },
  { name: '720x900', width: 720, height: 900 },
] as const
const APPEARANCES = ['light', 'dark', 'paper'] as const

async function createAgent(
  page: Page,
  command: string,
  workspace: string,
  title: string,
  agentRuntimeMode: 'terminal' | 'chat' = 'terminal',
) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  if (!body.agentId) throw new Error('Control Agent creation returned no Agent ID')
  const renameResponse = await page.request.patch(`/farming/api/agents/${body.agentId}`, {
    data: { customTitle: title },
  })
  expect(renameResponse.ok(), await renameResponse.text()).toBeTruthy()
  return body.agentId
}

async function openSidebar(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  if ((await sidebar.getAttribute('class'))?.includes('collapsed')) {
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(sidebar).toBeVisible()
  await expect(sidebar).not.toHaveClass(/collapsed/)
}

async function openAgent(page: Page, agentId: string) {
  await openSidebar(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
}

async function menuGapAndViewport(
  page: Page,
  trigger: Locator,
  menu: Locator,
) {
  await expect(menu).toBeVisible()
  return menu.evaluate((element, triggerElement) => {
    const rect = element.getBoundingClientRect()
    const triggerRect = (triggerElement as HTMLElement).getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth)
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      triggerLeft: triggerRect.left,
      triggerRight: triggerRect.right,
      triggerTop: triggerRect.top,
      viewportRight,
      gap: triggerRect.top - rect.bottom,
      fits: rect.left >= viewportLeft - 1
        && rect.right <= viewportRight + 1
        && rect.top >= viewportTop - 1
        && rect.bottom <= viewportBottom + 1,
    }
  }, await trigger.elementHandle())
}

test('audits compact Composer and sidebar geometry across mobile widths and appearances', async ({ page, workspaceRoot }) => {
  test.setTimeout(240_000)
  const workspace = path.join(workspaceRoot, 'mobile-visual-acceptance')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Mobile visual acceptance\n')

  const pinnedId = await createAgent(
    page,
    'codex --farming-fixture-idle-profile',
    workspace,
    'Pinned mobile Codex',
  )
  const ordinaryId = await createAgent(
    page,
    'codex --farming-fixture-idle-profile',
    workspace,
    'Ordinary mobile Codex',
  )
  const chatId = await createAgent(page, 'opencode', workspace, 'Mobile ACP Chat', 'chat')
  const pinResponse = await page.request.patch(`/farming/api/agents/${pinnedId}`, {
    data: { pinned: true },
  })
  expect(pinResponse.ok(), await pinResponse.text()).toBeTruthy()

  await page.route(/\/api\/usage(?:\?|$)/, async route => {
    const sampledAt = Date.now()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          sampledAt,
          windowMs: 5 * 60 * 1000,
          providers: [{
            provider: 'codex',
            providerName: 'Codex',
            auth: { available: true, status: 'Logged in using ChatGPT', source: 'playwright' },
            quota: {
              available: true,
              source: 'playwright quota-only fixture',
              primary: { usedPercent: 35, windowMinutes: 5 * 60, resetsAt: sampledAt + 60 * 60_000 },
              secondary: { usedPercent: 72, windowMinutes: 7 * 24 * 60, resetsAt: sampledAt + 3 * 24 * 60 * 60_000 },
            },
            tokenUsage: {
              available: false,
              totalTokens: 0,
              tokensPerMinute: 0,
              windowMs: 5 * 60 * 1000,
              eventCount: 0,
              sampledAt,
              source: 'no local token history',
            },
          }],
          agentUsage: null,
          systemStats: null,
        },
      }),
    })
  })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
  })
  await openFarming(page)
  const violations: string[] = []

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    for (const appearance of APPEARANCES) {
      await page.locator('body').evaluate((body, nextAppearance) => {
        body.dataset.appearance = nextAppearance
      }, appearance)
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await expect(page.locator('body')).toHaveClass(/code-compact-layout/)

      await openSidebar(page)
      const pinnedRow = page.getByTestId('code-pinned-section')
        .locator(`[data-testid="code-agent-row"][data-agent-id="${pinnedId}"]`)
      const ordinaryRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${ordinaryId}"]`)
      await expect(pinnedRow).toBeVisible()
      await expect(ordinaryRow).toBeVisible()
      const alignment = await page.evaluate(([pinnedSelector, ordinarySelector]) => {
        const metrics = (selector: string) => {
          const row = document.querySelector<HTMLElement>(selector)
          const icon = row?.querySelector<HTMLElement>('.code-agent-row-provider-icon')
          const name = row?.querySelector<HTMLElement>('.code-agent-name')
          if (!row || !icon || !name) throw new Error(`Missing Agent row geometry for ${selector}`)
          return {
            iconLeft: icon.getBoundingClientRect().left,
            nameLeft: name.getBoundingClientRect().left,
          }
        }
        return { pinned: metrics(pinnedSelector), ordinary: metrics(ordinarySelector) }
      }, [
        `[data-testid="code-pinned-section"] [data-testid="code-agent-row"][data-agent-id="${pinnedId}"]`,
        `[data-testid="code-agent-row"][data-agent-id="${ordinaryId}"]`,
      ])
      const pinnedIconDelta = Math.abs(alignment.pinned.iconLeft - alignment.ordinary.iconLeft)
      const pinnedNameDelta = Math.abs(alignment.pinned.nameLeft - alignment.ordinary.nameLeft)
      if (pinnedIconDelta > 1) {
        violations.push(`${viewport.name}/${appearance}: pinned provider icon delta ${pinnedIconDelta}px`)
      }
      if (pinnedNameDelta > 1) {
        violations.push(`${viewport.name}/${appearance}: pinned Agent name delta ${pinnedNameDelta}px`)
      }

      const machineHeight = await page.getByTestId('code-instance-name-edit').evaluate(element => (
        element.getBoundingClientRect().height
      ))
      expect(machineHeight).toBeLessThanOrEqual(28)

      const usageOpen = page.getByTestId('code-mobile-usage-open')
      await expect(usageOpen).toContainText('Weekly · 5h')
      await usageOpen.click()
      const quota = page.getByTestId('code-usage-mobile-quota')
      await expect(quota).toContainText('5h')
      await expect(quota).toContainText('Weekly')
      await page.getByRole('button', { name: 'Close usage activity' }).click()
      await expect(page.getByTestId('code-usage-detail-dialog')).toHaveCount(0)
      await openSidebar(page)

      const files = page.getByTestId('code-files-section').filter({ has: page.getByRole('button', { name: /^Files$/ }) })
      const filesToggle = files.getByRole('button', { name: /^Files$/ })
      if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.click()
      const project = files.locator('xpath=ancestor::section[contains(@class, "code-project-group")]')
      await expect(project.getByTestId('code-project-agent-compact')).toHaveCount(0)
      await expect(project.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(2)

      await openAgent(page, ordinaryId)
      const input = page.getByTestId('code-composer-input')
      await input.fill(`mobile ${viewport.name} ${appearance}`)
      await input.press('Enter')
      await expect(input).toHaveValue(`mobile ${viewport.name} ${appearance}\n`)
      await page.getByTestId('code-composer-send').click()
      await expect(input).toHaveValue('')

      const plusTrigger = page.getByTestId('code-composer-add')
      await plusTrigger.click()
      const plus = await menuGapAndViewport(page, plusTrigger, page.getByTestId('code-composer-plus-menu'))
      if (!plus.fits || plus.gap < 6 || plus.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: plus menu ${JSON.stringify(plus)}`)
      }
      await page.keyboard.press('Escape')

      const approvalTrigger = page.getByTestId('code-composer-approval')
      await approvalTrigger.click()
      const approvalMenu = page.getByTestId('code-approval-menu')
      const approvalBounds = await menuGapAndViewport(page, approvalTrigger, approvalMenu)
      if (!approvalBounds.fits || approvalBounds.gap < 6 || approvalBounds.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: approval menu ${JSON.stringify(approvalBounds)}`)
      }
      const approval = await approvalMenu.evaluate(element => {
        const styleNumber = (selector: string, property: 'fontSize' | 'width' | 'height') => {
          const target = element.querySelector<HTMLElement>(selector)
          if (!target) throw new Error(`Missing approval element ${selector}`)
          return Number.parseFloat(getComputedStyle(target)[property])
        }
        const row = element.querySelector<HTMLElement>('.code-approval-option')
        if (!row) throw new Error('Missing approval row')
        return {
          headerFont: styleNumber('.code-approval-menu-header', 'fontSize'),
          titleFont: styleNumber('.code-approval-option-copy span', 'fontSize'),
          descriptionFont: styleNumber('.code-approval-option-copy small', 'fontSize'),
          iconSize: styleNumber('.code-approval-option-icon', 'width'),
          rowMinHeight: Number.parseFloat(getComputedStyle(row).minHeight),
          rowHeight: row.getBoundingClientRect().height,
        }
      })
      if (
        approval.headerFont !== 13
        || approval.titleFont !== 13
        || approval.descriptionFont !== 11
        || approval.iconSize !== 22
        || approval.rowMinHeight !== 52
        || approval.rowHeight < 52
      ) {
        violations.push(`${viewport.name}/${appearance}: approval metrics ${JSON.stringify(approval)}`)
      }
      await page.keyboard.press('Escape')

      const modelTrigger = page.getByTestId('code-composer-model-picker')
      await modelTrigger.click()
      const model = await menuGapAndViewport(page, modelTrigger, page.getByTestId('code-model-menu'))
      const modelPeers = await page.evaluate(() => {
        const rect = (testId: string) => {
          const value = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.getBoundingClientRect()
          if (!value) throw new Error(`Missing ${testId} geometry`)
          return { left: value.left, right: value.right }
        }
        return {
          send: rect('code-composer-send'),
          composer: rect('code-composer'),
          visualViewportRight: (window.visualViewport?.offsetLeft ?? 0)
            + (window.visualViewport?.width ?? window.innerWidth),
        }
      })
      if (!model.fits || model.gap < 6 || model.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: model menu ${JSON.stringify({ ...model, ...modelPeers })}`)
      }
      const modelOcclusion = await page.getByTestId('code-model-menu').evaluate(element => {
        const rect = element.getBoundingClientRect()
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
        return {
          containsTopmost: topmost instanceof Node && element.contains(topmost),
          menuZIndex: getComputedStyle(element).zIndex,
          topmostClass: topmost instanceof Element ? topmost.getAttribute('class') : null,
          topmostTestId: topmost instanceof Element ? topmost.getAttribute('data-testid') : null,
          topmostTag: topmost instanceof Element ? topmost.tagName : null,
          topmostZIndex: topmost instanceof Element ? getComputedStyle(topmost).zIndex : null,
        }
      })
      if (!modelOcclusion.containsTopmost) {
        violations.push(`${viewport.name}/${appearance}: model menu occluded ${JSON.stringify(modelOcclusion)}`)
      }
      await page.keyboard.press('Escape')

      await openAgent(page, chatId)
      const acpAdd = page.getByTestId('code-acp-composer-add')
      await expect(acpAdd).toBeVisible({ timeout: 30_000 })
      await acpAdd.click()
      const acpMenu = page.getByTestId('code-acp-plus-menu')
      await expect(acpMenu).toBeVisible()
      await expect(acpMenu).not.toContainText(/logout/i)
      await expect(page.getByTestId('code-acp-logout')).toHaveCount(0)
      await page.keyboard.press('Escape')

    }
  }

  expect(violations).toEqual([])
})
