import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const PROGRESSIVE_SEGMENTS = Array.from(
  { length: 10 },
  (_, index) => `Visible segment ${String(index + 1).padStart(2, '0')} stays continuous and preserves the exact final transcript.`,
)
const PROGRESSIVE_INITIAL_ANSWER = PROGRESSIVE_SEGMENTS.slice(0, 2).join(' ')
const PROGRESSIVE_ANSWER = PROGRESSIVE_SEGMENTS.join(' ')

type AnswerSample = {
  elapsedMs: number
  text: string
}

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  return (await response.json() as { agentId: string }).agentId
}

async function installAnswerSampler(page: Page) {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __farmingProgressiveAnswerSamples?: AnswerSample[]
      __farmingProgressiveAnswerObserver?: MutationObserver
      __farmingProgressiveAnswerStartedAt?: number
    }
    testWindow.__farmingProgressiveAnswerObserver?.disconnect()
    testWindow.__farmingProgressiveAnswerSamples = []
    testWindow.__farmingProgressiveAnswerStartedAt = performance.now()
    const capture = () => {
      const answers = Array.from(document.querySelectorAll<HTMLElement>('.code-agent-transcript-assistant'))
      const text = answers[answers.length - 1]?.innerText.trim() || ''
      const samples = testWindow.__farmingProgressiveAnswerSamples || []
      if (!text || samples[samples.length - 1]?.text === text) return
      samples.push({
        elapsedMs: performance.now() - (testWindow.__farmingProgressiveAnswerStartedAt || 0),
        text,
      })
    }
    const observer = new MutationObserver(capture)
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
    testWindow.__farmingProgressiveAnswerObserver = observer
    capture()
  })
}

async function answerSamples(page: Page) {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __farmingProgressiveAnswerSamples?: AnswerSample[]
      __farmingProgressiveAnswerObserver?: MutationObserver
    }
    testWindow.__farmingProgressiveAnswerObserver?.disconnect()
    return testWindow.__farmingProgressiveAnswerSamples || []
  })
}

async function currentAnswerSamples(page: Page) {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __farmingProgressiveAnswerSamples?: AnswerSample[]
    }
    return testWindow.__farmingProgressiveAnswerSamples || []
  })
}

async function firstAnswerAfterAgentClick(page: Page, agentId: string) {
  return page.evaluate(id => new Promise<string>((resolve, reject) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="code-agent-row"][data-agent-id="${id}"]`)
    if (!row) {
      reject(new Error('Agent row is unavailable'))
      return
    }
    const startedAt = performance.now()
    row.click()
    const observe = () => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="code-agent-work-pane"][data-agent-id="${id}"]`)
      if (!pane) {
        if (performance.now() - startedAt > 5_000) {
          reject(new Error('Agent work pane did not become available'))
          return
        }
        window.requestAnimationFrame(observe)
        return
      }
      const answers = Array.from(pane.querySelectorAll<HTMLElement>('.code-agent-transcript-assistant'))
      const text = answers[answers.length - 1]?.innerText.trim() || ''
      if (!pane.hidden && text) {
        resolve(text)
        return
      }
      if (performance.now() - startedAt > 5_000) {
        reject(new Error('Agent answer did not become visible'))
        return
      }
      window.requestAnimationFrame(observe)
    }
    window.requestAnimationFrame(observe)
  }), agentId)
}

test('shows authoritative live ACP snapshots without delaying send confirmation or replaying settled text', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-progressive-answer')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const otherAgentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const otherAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${otherAgentId}"]`)
  await agentRow.click()
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
  await installAnswerSampler(page)

  const prompt = 'progressive answer stream'
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill(prompt)
  const submittedAt = Date.now()
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('', { timeout: 15_000 })
  const inputClearMs = Date.now() - submittedAt
  const userMessage = page.locator('.code-agent-transcript-user').filter({ hasText: prompt })
  await expect(userMessage).toBeVisible({ timeout: 15_000 })
  const transcriptConfirmationMs = Date.now() - submittedAt
  test.info().annotations.push({
    type: 'performance-budget',
    description: `composer cleared in ${inputClearMs}ms; transcript confirmed in ${transcriptConfirmationMs}ms`,
  })
  expect(inputClearMs).toBeLessThan(15_000)

  const answer = page.locator('.code-agent-transcript-assistant').last()
  await expect.poll(async () => (await currentAnswerSamples(page))[0]?.text).toBe(PROGRESSIVE_INITIAL_ANSWER)
  await expect(answer).toHaveText(PROGRESSIVE_ANSWER, { timeout: 20_000 })
  const samples = await answerSamples(page)
  expect(samples.length).toBeGreaterThan(2)
  expect(samples.length).toBeLessThanOrEqual(PROGRESSIVE_SEGMENTS.length)
  expect(samples[0]?.text).toBe(PROGRESSIVE_INITIAL_ANSWER)
  expect(samples[samples.length - 1]?.text).toBe(PROGRESSIVE_ANSWER)
  expect((samples[1]?.elapsedMs || 0) - (samples[0]?.elapsedMs || 0)).toBeLessThan(3_000)
  expect(samples.slice(1).every((sample, index) => (
    sample.text.startsWith(samples[index]?.text || '')
  ))).toBe(true)

  await otherAgentRow.click()
  const firstSwitchText = await firstAnswerAfterAgentClick(page, agentId)
  expect(firstSwitchText).toBe(PROGRESSIVE_ANSWER)

  await otherAgentRow.click()
  await page.reload()
  await expect(otherAgentRow).toBeVisible()
  const firstRestoredText = await firstAnswerAfterAgentClick(page, agentId)
  expect(firstRestoredText).toBe(PROGRESSIVE_ANSWER)
})

test('does not replay an in-progress ACP answer after switching agents', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-progressive-answer-switch')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const otherAgentId = await createAcpAgent(page, workspace)
  await openFarming(page)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const otherAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${otherAgentId}"]`)
  await agentRow.click()
  await installAnswerSampler(page)

  await page.getByTestId('code-acp-composer-input').fill('progressive answer stream')
  await page.getByTestId('code-acp-composer-send').click()
  await expect.poll(async () => (await currentAnswerSamples(page))[0]?.text).toBe(PROGRESSIVE_INITIAL_ANSWER)

  await otherAgentRow.click()
  // This is the sampled mid-stream interval under test: the Agent must keep
  // progressing while its pane is inactive, before the final answer settles.
  await page.waitForTimeout(1_500)
  const firstInProgressSwitchText = await firstAnswerAfterAgentClick(page, agentId)
  expect(firstInProgressSwitchText.startsWith(PROGRESSIVE_INITIAL_ANSWER)).toBe(true)
  expect(firstInProgressSwitchText.length).toBeGreaterThan(PROGRESSIVE_INITIAL_ANSWER.length)

  await expect(page.locator('.code-agent-transcript-assistant').last()).toHaveText(PROGRESSIVE_ANSWER, { timeout: 20_000 })
  await otherAgentRow.click()
  expect(await firstAnswerAfterAgentClick(page, agentId)).toBe(PROGRESSIVE_ANSWER)
})

test('shows a one-shot live ACP answer snapshot in full without replaying it', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-answer-snapshot')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await installAnswerSampler(page)

  await page.getByTestId('code-acp-composer-input').fill('answer snapshot only')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.locator('.code-agent-transcript-assistant').last()).toHaveText(PROGRESSIVE_ANSWER)
  const samples = await answerSamples(page)
  expect(samples).toHaveLength(1)
  expect(samples[0]?.text).toBe(PROGRESSIVE_ANSWER)
})

test('shows the authoritative ACP answer immediately when reduced motion is requested', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-progressive-answer-reduced-motion')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await installAnswerSampler(page)

  await page.getByTestId('code-acp-composer-input').fill('progressive answer stream reduced motion')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.locator('.code-agent-transcript-assistant').last()).toHaveText(PROGRESSIVE_ANSWER)
  const samples = await answerSamples(page)
  expect(samples[0]?.text).toBe(PROGRESSIVE_INITIAL_ANSWER)
  expect(samples[samples.length - 1]?.text).toBe(PROGRESSIVE_ANSWER)
  expect(samples.length).toBeLessThanOrEqual(PROGRESSIVE_SEGMENTS.length - 1)
})
