import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

test.describe('iPhone mobile layout', () => {
  test('keeps composer, mic, and terminal surfaces usable under iPhone WebKit emulation', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')

    const projectDir = path.join(workspaceRoot, 'iphone-layout')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# iPhone layout\n')

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    })

    await openFarming(page)
    const userAgent = await page.evaluate(() => navigator.userAgent)
    expect(userAgent).toContain('iPhone')

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').click()
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
    await expect(terminalPane).toBeVisible({ timeout: 30_000 })

    const terminalBackgrounds = await terminalPane.evaluate(element => {
      const pane = element as HTMLElement
      const container = pane.querySelector('[data-testid="code-terminal-container"]') as HTMLElement | null
      const screen = pane.querySelector('.xterm-screen') as HTMLElement | null
      const viewport = pane.querySelector('.xterm-viewport') as HTMLElement | null
      return {
        pane: getComputedStyle(pane).backgroundColor,
        container: container ? getComputedStyle(container).backgroundColor : '',
        screen: screen ? getComputedStyle(screen).backgroundColor : '',
        viewport: viewport ? getComputedStyle(viewport).backgroundColor : '',
      }
    })
    expect(terminalBackgrounds).toEqual({
      pane: 'rgb(255, 255, 255)',
      container: 'rgb(255, 255, 255)',
      screen: 'rgb(255, 255, 255)',
      viewport: 'rgb(255, 255, 255)',
    })

    const composer = page.getByTestId('code-composer')
    const textarea = composer.locator('textarea')
    await expect(textarea).toBeEnabled()
    await textarea.focus()
    await expect(textarea).toBeFocused()

    const keyboardMetrics = await composer.evaluate(async element => {
      const root = document.documentElement
      document.body.classList.add('code-mode', 'code-mobile-touch', 'code-mobile-ios')
      root.style.setProperty('--app-visual-height', '430px')
      root.style.setProperty('--app-visual-offset-top', '0px')
      root.style.setProperty('--app-visual-offset-left', '0px')
      root.style.setProperty('--mobile-keyboard-offset', '520px')
      await new Promise(resolve => window.setTimeout(resolve, 220))
      const rect = (element as HTMLElement).getBoundingClientRect()
      const visualBottom = Number.parseFloat(root.style.getPropertyValue('--app-visual-height')) || 0
      return {
        composerHeight: rect.height,
        composerBottomBeyondVisualViewport: rect.bottom - visualBottom,
        layoutViewportBottomGap: window.innerHeight - rect.bottom,
      }
    })
    expect(keyboardMetrics.composerHeight).toBeLessThanOrEqual(130)
    expect(keyboardMetrics.composerBottomBeyondVisualViewport).toBeGreaterThan(200)
    expect(keyboardMetrics.composerBottomBeyondVisualViewport).toBeLessThanOrEqual(240)
    expect(keyboardMetrics.layoutViewportBottomGap).toBeGreaterThanOrEqual(0)
    expect(keyboardMetrics.layoutViewportBottomGap).toBeLessThan(32)

    await page.getByTestId('code-composer-mic').tap()
    const recording = page.getByTestId('code-composer-recording')
    await expect(recording).toBeVisible()
    await expect(recording.locator('.code-composer-recording-wave span')).toHaveCount(24)
    await page.getByTestId('code-composer-recording-stop').click()
    await expect(recording).toHaveCount(0)
  })
})
