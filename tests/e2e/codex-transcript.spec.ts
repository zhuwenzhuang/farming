import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, openFarming, test } from './fixtures'

const globalTestRoots = new Set<string>()

function createGlobalTestRoot() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.farming-e2e-global-files-'))
  globalTestRoots.add(root)
  return root
}

test.afterEach(() => {
  for (const root of globalTestRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  globalTestRoots.clear()
})

async function createCodexHistoryAgent(page: import('@playwright/test').Page, workspace: string, sessionId: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: {
      command: `codex resume ${sessionId}`,
      workspace,
    },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

// @deprecated CLI JSONL transcript is no longer a product runtime path.
// App Server Chat coverage lives with the managed App Server tests instead.
test.describe.skip('Legacy Codex JSONL transcript view', () => {
  test('renders Codex-app style turns with collapsible process details and raw terminal fallback', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-transcript-fixture')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'app.ts'), 'export const value = 1\n')
    fs.mkdirSync(path.join(projectDir, 'backend'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'src/components/code'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'warehouse-sql/compiler/src/test/java/com/example/warehouse'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'backend/codex-transcript.js'), 'module.exports = { oldValue: 1 }\n')
    fs.writeFileSync(path.join(projectDir, 'src/components/code/CodexTranscriptPane.tsx'), 'export function Pane() { return null }\n')
    fs.writeFileSync(path.join(projectDir, 'warehouse-sql/compiler/src/test/java/com/example/warehouse/CreateTableClusteredByTest.java'), 'class CreateTableClusteredByTest {}\n')
    fs.writeFileSync(
      path.join(projectDir, 'warehouse-sql/compiler/src/test/java/com/example/warehouse/TypeChecker.java'),
      Array.from({ length: 180 }, (_, index) => `// TypeChecker fixture line ${index + 1}`).join('\n'),
    )
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: projectDir })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: projectDir })
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed codex transcript fixture'], { cwd: projectDir, stdio: 'ignore' })
    fs.writeFileSync(path.join(projectDir, 'backend/codex-transcript.js'), 'module.exports = { oldValue: 1, newValue: 2 }\n')
    fs.writeFileSync(path.join(projectDir, 'src/components/code/CodexTranscriptPane.tsx'), 'export function Pane() { return <div>changed</div> }\n')
    const sessionId = '019ftranscript-fixture'

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            updatedAt: new Date('2026-07-09T00:00:00.000Z').toISOString(),
            source: 'codex-rollout-jsonl',
            turns: [
              {
                id: 'turn-final-only',
                userMessage: '你现在在干啥？',
                userImages: [
                  {
                    id: 'image-1',
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
                    alt: 'sample.png',
                  },
                ],
                userFiles: [
                  {
                    id: 'file-1',
                    name: 'notes.txt',
                    content: 'first attached line\nsecond attached line',
                  },
                ],
                finalMessage: [
                  '我在整理 Codex Chat 的展示路径，保留 `Terminal` 作为兜底。',
                  '<oai-mem-citation>',
                  '<citation_entries>',
                  'MEMORY.md:47-84|note=[routing context]',
                  '</citation_entries>',
                  '<rollout_ids>',
                  '019f26d3-7485-76d0-8a64-f5cf5d690129',
                  '</rollout_ids>',
                  '</oai-mem-citation>',
                ].join('\n'),
                startedAt: 1,
                completedAt: 31_000,
                durationMs: 30_000,
                status: 'completed',
                processItems: [],
              },
              {
                id: 'turn-rich-process',
                userMessage: '实现并验证 Codex 桌面端风格的过程折叠。',
                finalMessage: [
                  '已完成：',
                  '',
                  '- 默认只展示目标和最终结果。',
                  '- 中间过程折叠在 `Worked` 行里。',
                  '- 需要时可以展开查看命令、diff、工具输出和 warning。',
                  '- [x] 支持 GFM task list。',
                  '- ~~不要展示原始 citation 标签。~~',
                  '- 可直接打开 `backend/codex-transcript.js:1` 和 [Pane](src/components/code/CodexTranscriptPane.tsx)。',
                  '',
                  '> 这个视图应该优先服务快速扫读，而不是复刻 terminal 的每一行。',
                  '',
                  '---',
                  '',
                  '```ts',
                  'const mode = "chat"',
                  'const fallback = "terminal"',
                  `const longUnbrokenValue = '${'x'.repeat(640)}'`,
                  '```',
                  '',
                  '```js',
                  'const highlighted = true',
                  '```',
                  '',
                  '公式：$E=mc^2$。',
                  '',
	                  '这个是 `INSERT OVERWRITE` 成功那条：',
	                  '',
	                  'Instance ID: `20260708071013753g4o8vpic5c71`',
	                  '',
	                  'case id 不应该可点：`create.append2.table.with.cluster.sorted.unsupported`。',
	                  '裸配置文件名不应该变成搜索入口：`auth.json`。',
	                  'workspace 外部文档找不到时也不应该打开搜索：[codex-ecs-cpa-account-onboarding.md](codex-ecs-cpa-account-onboarding.md)。',
	                  '',
	                  'basename 文件链接应该打开唯一文件：[CreateTableClusteredByTest.java](CreateTableClusteredByTest.java)。',
	                  '带行号的 Java 文件也应该保留行号：[TypeChecker.java](TypeChecker.java:149)。',
	                  '裸域名链接不应该退化成 about:blank：[Review 28350655](review.example.test/projects/demo/reviews/28350655)。',
	                  '',
	                  '```mermaid',
                  'graph TD',
                  '  A[User goal] --> B[Codex process]',
                  '  B --> C[Final answer]',
                  '```',
                  '',
                  '| 状态 | 展示 |',
                  '| --- | --- |',
                  '| running | 折叠过程 |',
                  '| completed | 展示结果 |',
                  '',
                  '![tiny preview](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)',
                ].join('\n'),
                startedAt: 40_000,
                completedAt: 219_000,
                durationMs: 179_000,
                status: 'completed',
                processItems: [
                  { id: 'plan', type: 'plan', title: 'Updated plan', detail: '[x] inspect\n[>] implement\n[ ] verify', status: 'completed' },
                  { id: 'reason', type: 'reasoning', title: 'Reasoned', detail: 'Use structured history instead of parsing terminal separator lines.', status: 'completed' },
                  { id: 'assistant-progress', type: 'message', title: 'I will inspect the protocol first.', detail: 'I will inspect the protocol first.\nThen I will patch the UI.', status: 'completed' },
                  { id: 'user-steer', type: 'user-steer', title: '中途补充：重点看 web 端更新。', detail: '中途补充：重点看 web 端更新。', status: 'completed' },
                  { id: 'agent-message', type: 'agent-message', title: 'main -> worker', detail: 'Please verify the transcript fixture.', status: 'completed' },
                  { id: 'memory-citation', type: 'citation', title: 'Memory citations', detail: 'MEMORY.md:885-886 | Codex reference scope', status: 'completed' },
                  { id: 'hook', type: 'hook', title: 'Hook prompt', detail: 'pre-submit hook requested a short continuation.', status: 'completed' },
                  { id: 'cmd-ok', type: 'command', title: 'Ran rg transcript src backend', detail: 'cwd: /repo\nsrc/components/code/CodexTranscriptPane.tsx', status: 'completed' },
                  { id: 'cmd-fail', type: 'command', title: 'Ran npm run missing-script', detail: 'exit: 1\nmissing script: missing-script', status: 'failed' },
                  { id: 'patch', type: 'patch', title: 'Edited 5 files', detail: 'update backend/codex-transcript.js +6 -2\nupdate src/components/code/CodexTranscriptPane.tsx +24 -4\nupdate src/lib/xterm.ts +1 -1\nupdate tests/e2e/terminal-regression-matrix.spec.ts +6 -2\nupdate backend/tests/test-session-input-helpers.js +2 -2\nSuccess. Updated the following files:\nM backend/codex-transcript.js\nExit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM backend/codex-transcript.js', status: 'completed' },
                  { id: 'patch-absolute', type: 'patch', title: 'Edited 1 file', detail: `update ${projectDir}/backend/codex-transcript.js +1 -1`, status: 'completed' },
                  { id: 'mcp', type: 'mcp', title: 'Used docs/lookup', detail: '{\"q\":\"codex protocol\"}\nok', status: 'completed' },
                  { id: 'tool', type: 'tool', title: 'Used imagegen', detail: '{\"prompt\":\"interface mock\"}', status: 'running' },
                  { id: 'tool-search', type: 'tool', title: 'Searched tools', detail: '{\"query\":\"browser\"}\nbrowser.open', status: 'completed' },
                  {
                    id: 'tool-output',
                    type: 'tool-output',
                    title: 'Tool output',
                    detail: 'structured output line',
                    status: 'completed',
                    images: [
                      {
                        id: 'tool-output-image-1',
                        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
                        alt: 'Tool output image',
                      },
                    ],
                  },
                  { id: 'agent-tool', type: 'agent-tool', title: 'Agent spawnAgent', detail: 'receivers: worker-thread', status: 'completed' },
                  { id: 'sub-agent', type: 'sub-agent', title: 'interacted worker', detail: '', status: 'completed' },
                  { id: 'subagent-notification', type: 'subagent', title: 'Subagent completed', detail: 'Completed a focused implementation check.', status: 'completed' },
                  { id: 'web', type: 'web-search', title: 'Searched codex protocol', detail: '{\"query\":\"codex protocol\"}', status: 'completed' },
                  { id: 'image-view', type: 'image', title: 'Viewed /tmp/screenshot.png', detail: '', status: 'completed' },
                  {
                    id: 'image',
                    type: 'image-generation',
                    title: 'Generated image',
                    detail: 'mock-image.png',
                    status: 'completed',
                    images: [
                      {
                        id: 'generated-image-1',
                        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
                        alt: 'Generated image',
                      },
                    ],
                  },
                  { id: 'sleep', type: 'sleep', title: 'Slept for 2s', detail: '', status: 'completed' },
                  { id: 'review-in', type: 'review', title: 'Entered review mode', detail: 'review started', status: 'completed' },
                  { id: 'review-out', type: 'review', title: 'Exited review mode', detail: 'review finished', status: 'completed' },
                  { id: 'warn', type: 'warning', title: 'Warning', detail: 'Desktop comparison unavailable in Computer Use.', status: 'warning' },
                  { id: 'model-reroute', type: 'event', title: 'Rerouted gpt-5-high to gpt-5', detail: 'rateLimited', status: 'completed' },
                  { id: 'model-verify', type: 'event', title: 'Verified model', detail: '[{\"model\":\"gpt-5\",\"status\":\"ok\"}]', status: 'completed' },
                  { id: 'safety-buffering', type: 'warning', title: 'Safety buffering', detail: 'model: gpt-5\nuse cases: coding', status: 'warning' },
                  { id: 'server-request', type: 'event', title: 'Resolved server request', detail: 'request-1', status: 'completed' },
                  { id: 'compact', type: 'compaction', title: 'Compacted context', detail: '', status: 'completed' },
                  { id: 'other-event', type: 'event', title: 'Other', detail: '{\"type\":\"other\"}', status: 'completed' },
                  { id: 'error', type: 'error', title: 'Error', detail: 'non-fatal stream error', status: 'failed' },
                  { id: 'rollback', type: 'rollback', title: 'Rolled back thread', detail: 'rollback-to-item', status: 'completed' },
                ],
              },
              {
                id: 'turn-stale-running-with-answer',
                userMessage: '动态写入完成后不要残留等待提示。',
                finalMessage: '动态回复已经落盘。',
                startedAt: 220_000,
                completedAt: null,
                durationMs: null,
                status: 'inProgress',
                processItems: [],
              },
              {
                id: 'turn-running',
                userMessage: '继续观察运行中的 agent。',
                finalMessage: '',
                startedAt: 230_000,
                completedAt: null,
                durationMs: null,
                status: 'inProgress',
                processItems: [
                  { id: 'running-cmd', type: 'command', title: 'Ran npm test', detail: 'still running', status: 'running' },
                ],
              },
            ],
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const modeToggle = pane.getByTestId('code-terminal-mode-toggle')
    await expect(modeToggle).toBeVisible()
    await expect(modeToggle.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    const modeToggleRestingMetrics = await modeToggle.evaluate(element => {
      const style = getComputedStyle(element)
      const activeButton = element.querySelector('button.active')
      const activeStyle = activeButton ? getComputedStyle(activeButton) : null
      return {
        opacity: Number(style.opacity),
        activeBackground: activeStyle?.backgroundColor || '',
      }
    })
    expect(modeToggleRestingMetrics.opacity).toBeLessThanOrEqual(0.6)
    expect(modeToggleRestingMetrics.activeBackground).toBe('rgba(31, 35, 40, 0.055)')
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
    await page.evaluate(async ({ id, text }) => {
      await window.__farmingTerminalTest?.writeRaw(id, text)
    }, { id: agentId, text: 'CHAT_TO_TERMINAL_SENTINEL\r\n' })
    await expect(pane.getByText('你现在在干啥？')).toBeVisible()
    await expect(pane.getByTestId('code-codex-transcript-user-images').getByRole('img', { name: 'sample.png' })).toBeVisible()
    await expect(pane.getByTestId('code-codex-transcript-user-files').getByText('notes.txt')).toBeVisible()
    await expect(pane.getByText('2 lines · 40 chars')).toBeVisible()
    await pane.getByText('notes.txt').click()
    await expect(pane.getByText('first attached line')).toBeVisible()
    const userBubbleMetrics = await pane.locator('.code-codex-transcript-user').first().evaluate(element => {
      const style = getComputedStyle(element)
      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      }
    })
    expect(userBubbleMetrics.fontSize).toBe('14px')
    expect(userBubbleMetrics.lineHeight).toBe('20px')
    await expect(pane.getByText('我在整理 Codex Chat 的展示路径')).toBeVisible()
    await expect(pane.getByText('oai-mem-citation')).toHaveCount(0)
    await expect(pane.getByText('实现并验证 Codex 桌面端风格的过程折叠。')).toBeVisible()
    await expect(pane.getByText('已完成：')).toBeVisible()
    await expect(pane.locator('.code-codex-transcript-assistant input[type="checkbox"]')).toBeChecked()
    await expect(pane.locator('.code-codex-transcript-assistant del')).toContainText('不要展示原始 citation 标签。')
    await expect(pane.locator('.code-codex-transcript-assistant blockquote')).toContainText('快速扫读')
    await expect(pane.locator('.code-codex-transcript-assistant pre').filter({ hasText: 'const mode = "chat"' })).toBeVisible()
    await expect(pane.locator('.code-codex-transcript-assistant pre[data-language]')).toHaveCount(0)
    await expect(pane.locator('.code-codex-transcript-assistant table')).toContainText('completed')
    await expect(pane.locator('.code-codex-transcript-assistant code').filter({ hasText: 'INSERT OVERWRITE' })).toBeVisible()
	    await expect(pane.locator('.code-codex-transcript-assistant code').filter({ hasText: '20260708071013753g4o8vpic5c71' })).toBeVisible()
	    await expect(pane.locator('.code-codex-transcript-file-link').filter({ hasText: 'INSERT OVERWRITE' })).toHaveCount(0)
	    await expect(pane.locator('.code-codex-transcript-file-link').filter({ hasText: '20260708071013753g4o8vpic5c71' })).toHaveCount(0)
	    await expect(pane.locator('.code-codex-transcript-file-link').filter({ hasText: 'create.append2.table.with.cluster.sorted.unsupported' })).toHaveCount(0)
	    await expect(pane.locator('.code-codex-transcript-file-link').filter({ hasText: 'auth.json' })).toHaveCount(0)
    await expect(pane.getByText('动态写入完成后不要残留等待提示。')).toBeVisible()
    await expect(pane.getByText('动态回复已经落盘。')).toBeVisible()
    await expect(pane.getByText('Codex is still working...')).toHaveCount(1)
    const richMarkdownMetrics = await pane.locator('.code-codex-transcript-answer').nth(1).evaluate(element => {
	      const blockquote = element.querySelector('blockquote')
	      const code = element.querySelector('code')
	      const strong = element.querySelector('strong')
	      const pre = element.querySelector('pre')
      const table = element.querySelector('table')
      const tableCell = table?.querySelector('td')
      const tableHeader = table?.querySelector('th')
      const taskList = element.querySelector('ul.contains-task-list')
      const taskItem = element.querySelector('li.task-list-item')
      const hr = element.querySelector('hr')
      const image = element.querySelector('img[alt="tiny preview"]')
      const katex = element.querySelector('.katex')
      const highlighted = element.querySelector('.hljs-keyword')
      const mermaid = element.querySelector('.code-markdown-mermaid')
	      const blockquoteStyle = blockquote ? getComputedStyle(blockquote) : null
	      const codeStyle = code ? getComputedStyle(code) : null
	      const strongStyle = strong ? getComputedStyle(strong) : null
      const preStyle = pre ? getComputedStyle(pre) : null
      const transcriptScroll = element.closest('[data-testid="code-codex-transcript-scroll"]') as HTMLElement | null
      const tableStyle = table ? getComputedStyle(table) : null
      const cellStyle = tableCell ? getComputedStyle(tableCell) : null
      const headerStyle = tableHeader ? getComputedStyle(tableHeader) : null
      const taskListStyle = taskList ? getComputedStyle(taskList) : null
      const taskItemStyle = taskItem ? getComputedStyle(taskItem) : null
      const hrStyle = hr ? getComputedStyle(hr) : null
      const imageStyle = image ? getComputedStyle(image) : null
      return {
        hasTable: Boolean(table),
        hasImage: Boolean(image),
        hasTaskList: Boolean(taskList),
        hasHr: Boolean(hr),
        hasKatex: Boolean(katex),
        hasHighlightedCode: Boolean(highlighted),
        hasMermaid: Boolean(mermaid),
        blockquoteLineHeight: blockquoteStyle?.lineHeight || '',
        blockquotePaddingLeft: blockquoteStyle?.paddingLeft || '',
        blockquoteMarginBottom: blockquoteStyle?.marginBottom || '',
        codePaddingLeft: codeStyle?.paddingLeft || '',
	        codeBorderRadius: codeStyle?.borderRadius || '',
	        codeOverflowWrap: codeStyle?.overflowWrap || '',
	        codeWordBreak: codeStyle?.wordBreak || '',
	        strongFontWeight: strongStyle?.fontWeight || '',
	        preFontSize: preStyle?.fontSize || '',
        preLineHeight: preStyle?.lineHeight || '',
        preBorderTopWidth: preStyle?.borderTopWidth || '',
        preBorderRadius: preStyle?.borderRadius || '',
        preOverflowX: preStyle?.overflowX || '',
        preWhiteSpace: preStyle?.whiteSpace || '',
        preScrollsHorizontally: pre ? pre.scrollWidth > pre.clientWidth + 1 : false,
        transcriptScrollsHorizontally: transcriptScroll ? transcriptScroll.scrollWidth > transcriptScroll.clientWidth + 1 : false,
        tableWidth: tableStyle?.width || '',
        tableBorderCollapse: tableStyle?.borderCollapse || '',
        cellBorderTop: cellStyle?.borderTopWidth || '',
        cellBorderLeft: cellStyle?.borderLeftWidth || '',
        cellBorderBottom: cellStyle?.borderBottomWidth || '',
        cellPaddingRight: cellStyle?.paddingRight || '',
        headerBackground: headerStyle?.backgroundColor || '',
        headerFontWeight: headerStyle?.fontWeight || '',
        taskListPaddingLeft: taskListStyle?.paddingLeft || '',
        taskListListStyle: taskListStyle?.listStyleType || '',
        taskItemDisplay: taskItemStyle?.display || '',
        taskItemGridTemplateColumns: taskItemStyle?.gridTemplateColumns || '',
        hrMarginTop: hrStyle?.marginTop || '',
        hrBorderTopWidth: hrStyle?.borderTopWidth || '',
        imageDisplay: imageStyle?.display || '',
        imageBorderRadius: imageStyle?.borderRadius || '',
        imageLoaded: image instanceof HTMLImageElement ? image.complete && image.naturalWidth > 0 : false,
      }
    })
    expect(richMarkdownMetrics.hasTable).toBeTruthy()
    expect(richMarkdownMetrics.hasImage).toBeTruthy()
    expect(richMarkdownMetrics.hasTaskList).toBeTruthy()
    expect(richMarkdownMetrics.hasHr).toBeTruthy()
    expect(richMarkdownMetrics.hasKatex).toBeTruthy()
    expect(richMarkdownMetrics.hasHighlightedCode).toBeTruthy()
    expect(richMarkdownMetrics.hasMermaid).toBeTruthy()
    expect(richMarkdownMetrics.imageLoaded).toBeTruthy()
    expect(richMarkdownMetrics.blockquoteLineHeight).toBe('21px')
    expect(richMarkdownMetrics.blockquotePaddingLeft).toBe('22px')
    expect(richMarkdownMetrics.blockquoteMarginBottom).toBe('8px')
	    expect(richMarkdownMetrics.codePaddingLeft).toBe('6px')
	    expect(richMarkdownMetrics.codeBorderRadius).toBe('6px')
	    expect(richMarkdownMetrics.codeOverflowWrap).toBe('anywhere')
	    expect(richMarkdownMetrics.codeWordBreak).toBe('break-word')
	    expect(Number(richMarkdownMetrics.strongFontWeight)).toBeLessThanOrEqual(520)
	    expect(richMarkdownMetrics.preFontSize).toBe('12px')
    expect(richMarkdownMetrics.preLineHeight).toBe('20px')
    expect(richMarkdownMetrics.preBorderTopWidth).toBe('1px')
    expect(richMarkdownMetrics.preBorderRadius).toBe('8px')
    expect(richMarkdownMetrics.preOverflowX).toBe('hidden')
    expect(richMarkdownMetrics.preWhiteSpace).toBe('pre-wrap')
    expect(richMarkdownMetrics.preScrollsHorizontally).toBe(false)
    expect(richMarkdownMetrics.transcriptScrollsHorizontally).toBe(false)
    expect(richMarkdownMetrics.tableBorderCollapse).toBe('separate')
    expect(richMarkdownMetrics.cellBorderTop).toBe('0px')
    expect(richMarkdownMetrics.cellBorderLeft).toBe('0px')
    expect(richMarkdownMetrics.cellBorderBottom).toBe('1px')
    expect(richMarkdownMetrics.cellPaddingRight).toBe('22px')
    expect(richMarkdownMetrics.headerBackground).toBe('rgba(0, 0, 0, 0)')
    expect(Number(richMarkdownMetrics.headerFontWeight)).toBeLessThanOrEqual(520)
    expect(richMarkdownMetrics.taskListPaddingLeft).toBe('0px')
    expect(richMarkdownMetrics.taskListListStyle).toBe('none')
    expect(richMarkdownMetrics.taskItemDisplay).toBe('grid')
    expect(richMarkdownMetrics.taskItemGridTemplateColumns).toMatch(/^\d+px\s/)
    expect(richMarkdownMetrics.hrMarginTop).toBe('22px')
    expect(richMarkdownMetrics.hrBorderTopWidth).toBe('1px')
    expect(richMarkdownMetrics.imageDisplay).toBe('block')
    expect(richMarkdownMetrics.imageBorderRadius).toBe('8px')
    const richAnswer = pane.locator('.code-codex-transcript-answer').nth(1)
    const mermaidDiagram = richAnswer.locator('.code-markdown-mermaid')
    const mermaidToolbar = richAnswer.locator('.code-markdown-mermaid-toolbar')
    const mermaidCanvas = richAnswer.locator('.code-markdown-mermaid-canvas')
    await expect(mermaidToolbar).toBeVisible()
    await expect(mermaidToolbar).toHaveCSS('opacity', '1')
    await expect(mermaidCanvas).toBeVisible()
    const zoomIn = mermaidToolbar.getByRole('button', { name: 'Zoom in' })
    const panMode = mermaidToolbar.getByRole('button', { name: 'Toggle pan mode' })
    await expect(zoomIn).toHaveCount(1)
    await expect(panMode).toHaveCount(1)
    await zoomIn.click()
    await expect(mermaidCanvas).toHaveAttribute('style', /scale\(1\.2\)/)
    await panMode.click()
    await expect(panMode).toHaveAttribute('aria-pressed', 'true')
    const fullscreen = mermaidToolbar.getByRole('button', { name: 'Open fullscreen diagram' })
    await expect(fullscreen).toHaveCount(1)
    await fullscreen.click()
    await expect(mermaidDiagram).toHaveClass(/fullscreen/)
    await expect(mermaidDiagram).toHaveAttribute('role', 'dialog')
    await expect(mermaidCanvas).toHaveAttribute('style', /scale\(1\)/)
    await expect(mermaidCanvas).toHaveAttribute('style', /width: \d+px/)
    const fullscreenDiagramMetrics = await mermaidDiagram.evaluate(element => {
      const viewport = element.querySelector<HTMLElement>('.code-markdown-mermaid-viewport')
      const canvas = element.querySelector<HTMLElement>('.code-markdown-mermaid-canvas')
      if (!viewport || !canvas) return null
      const viewportRect = viewport.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()
      return {
        canvasCenterX: canvasRect.left + canvasRect.width / 2,
        canvasCenterY: canvasRect.top + canvasRect.height / 2,
        viewportCenterX: viewportRect.left + viewportRect.width / 2,
        viewportCenterY: viewportRect.top + viewportRect.height / 2,
        canvasWidth: canvasRect.width,
        viewportWidth: viewportRect.width,
      }
    })
    expect(fullscreenDiagramMetrics).not.toBeNull()
    expect(Math.abs(fullscreenDiagramMetrics!.canvasCenterX - fullscreenDiagramMetrics!.viewportCenterX)).toBeLessThanOrEqual(2)
    expect(Math.abs(fullscreenDiagramMetrics!.canvasCenterY - fullscreenDiagramMetrics!.viewportCenterY)).toBeLessThanOrEqual(2)
    expect(fullscreenDiagramMetrics!.canvasWidth).toBeGreaterThan(0)
    expect(fullscreenDiagramMetrics!.canvasWidth).toBeLessThanOrEqual(fullscreenDiagramMetrics!.viewportWidth)
    const exitFullscreen = mermaidToolbar.getByRole('button', { name: 'Close fullscreen diagram' })
    await expect(exitFullscreen).toHaveCount(1)
    await exitFullscreen.evaluate((button: HTMLButtonElement) => button.click())
    await expect(mermaidDiagram).not.toHaveClass(/fullscreen/)
    const richScreenshotPath = process.env.FARMING_CODEX_TRANSCRIPT_RICH_SCREENSHOT
    if (richScreenshotPath) {
      const richAnswer = pane.locator('.code-codex-transcript-answer').nth(1)
      await richAnswer.scrollIntoViewIfNeeded()
      await page.screenshot({ path: richScreenshotPath, fullPage: false })
    }
    const richAnswerScreenshotPath = process.env.FARMING_CODEX_TRANSCRIPT_RICH_ANSWER_SCREENSHOT
    if (richAnswerScreenshotPath) {
      const richAnswer = pane.locator('.code-codex-transcript-answer').nth(1)
      const viewportSize = page.viewportSize()
      if (viewportSize && viewportSize.height < 1300) {
        await page.setViewportSize({ width: viewportSize.width, height: 1300 })
      }
      await richAnswer.scrollIntoViewIfNeeded()
      await richAnswer.screenshot({ path: richAnswerScreenshotPath })
      if (viewportSize && viewportSize.height < 1300) {
        await page.setViewportSize(viewportSize)
      }
    }
    await expect(pane.getByText('继续观察运行中的 agent。')).toBeVisible()
    await expect(pane.getByText('Codex is still working...')).toBeVisible()
    await expect(pane.getByTestId('code-codex-transcript-copy-answer')).toHaveCount(3)
    await expect(pane.getByTestId('code-codex-transcript-copy-answer').first()).toBeVisible()
    const firstAnswer = pane.locator('.code-codex-transcript-answer').first()
    await firstAnswer.hover()
    const firstAnswerGeometry = await firstAnswer.evaluate(element => {
      const container = element.getBoundingClientRect()
      const assistant = element.querySelector('.code-codex-transcript-assistant')
      const paragraph = assistant?.querySelector('p')?.getBoundingClientRect()
      const action = element.querySelector('.code-codex-transcript-answer-action')?.getBoundingClientRect()
      const style = assistant ? getComputedStyle(assistant) : null
      return paragraph && action && style
        ? {
            answerHeight: container.height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            verticalGap: action.top - paragraph.bottom,
            leftGap: Math.abs(action.left - paragraph.left),
          }
        : null
    })
    expect(firstAnswerGeometry).not.toBeNull()
    expect(firstAnswerGeometry?.fontSize).toBe('14px')
    expect(firstAnswerGeometry?.lineHeight).toBe('20px')
    expect(firstAnswerGeometry?.leftGap).toBeLessThanOrEqual(4)
    expect(firstAnswerGeometry?.verticalGap ?? -1).toBeGreaterThanOrEqual(0)
    const transcriptSelectionMetrics = await pane.getByTestId('code-codex-transcript').evaluate(element => {
      const assistant = element.querySelector('.code-codex-transcript-assistant')
      const user = element.querySelector('.code-codex-transcript-user')
      return {
        transcriptUserSelect: getComputedStyle(element).userSelect,
        assistantUserSelect: assistant ? getComputedStyle(assistant).userSelect : '',
        userUserSelect: user ? getComputedStyle(user).userSelect : '',
      }
    })
    expect(transcriptSelectionMetrics.transcriptUserSelect).toBe('text')
    expect(transcriptSelectionMetrics.assistantUserSelect).toBe('text')
    expect(transcriptSelectionMetrics.userUserSelect).toBe('text')
    const inlineFileLink = pane.getByRole('link', { name: 'codex-transcript.js' })
    await expect(inlineFileLink.locator('.code-codex-transcript-file-icon')).toBeVisible()
    await expect(inlineFileLink).toHaveClass('code-codex-transcript-markdown-file-link')
    const inlineFileLinkStyle = await inlineFileLink.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        display: style.display,
        backgroundColor: style.backgroundColor,
      }
    })
    expect(inlineFileLinkStyle.display).toBe('inline')
    expect(inlineFileLinkStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    await expect(pane.getByRole('link', { name: 'Pane' }).locator('.code-codex-transcript-file-icon')).toBeVisible()
    await expect(pane.getByRole('link', { name: 'CreateTableClusteredByTest.java' }).locator('.code-codex-transcript-file-icon')).toBeVisible()
    const javaLineLink = pane.getByRole('link', { name: 'TypeChecker.java:149' })
    await expect(javaLineLink.locator('.code-codex-transcript-file-icon')).toBeVisible()
    const bareDomainLink = pane.getByRole('link', { name: 'Review 28350655' })
    await expect(bareDomainLink).toHaveAttribute('href', 'https://review.example.test/projects/demo/reviews/28350655')
    await expect(bareDomainLink).toHaveAttribute('target', '_blank')
    const javaIconMetrics = await javaLineLink.locator('.code-codex-transcript-file-icon').evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        width: style.width,
        height: style.height,
      }
    })
    expect(javaIconMetrics.backgroundColor).toBe('rgb(9, 105, 218)')
    expect(javaIconMetrics.width).not.toBe('0px')
    expect(javaIconMetrics.height).not.toBe('0px')

    await pane.getByRole('link', { name: 'codex-ecs-cpa-account-onboarding.md' }).click()
    await expect(page.getByTestId('code-search-box')).toHaveCount(0)
    await expect(page.getByTestId('code-codex-transcript')).toBeVisible()

    const inlinePathRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('path') === 'backend/codex-transcript.js'
    })
    await inlineFileLink.click()
    expect((await inlinePathRequest).url()).toContain('agentId=')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-editor-tab.active')).toContainText('codex-transcript.js')
    await page.getByTestId('code-file-editor-back').click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()

    const markdownLinkRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('path') === 'src/components/code/CodexTranscriptPane.tsx'
    })
    await pane.getByRole('link', { name: 'Pane' }).click()
    expect((await markdownLinkRequest).url()).toContain('agentId=')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-editor-tab.active')).toContainText('CodexTranscriptPane.tsx')
    await page.getByTestId('code-file-editor-back').click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()

    const basenameLinkRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('path') === 'warehouse-sql/compiler/src/test/java/com/example/warehouse/CreateTableClusteredByTest.java'
    })
    await pane.getByRole('link', { name: 'CreateTableClusteredByTest.java' }).click()
    expect((await basenameLinkRequest).url()).toContain('agentId=')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-editor-tab.active')).toContainText('CreateTableClusteredByTest.java')
    await page.getByTestId('code-file-editor-back').click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()

    const javaLineRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('path') === 'warehouse-sql/compiler/src/test/java/com/example/warehouse/TypeChecker.java'
    })
    await javaLineLink.click()
    expect((await javaLineRequest).url()).toContain('agentId=')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-editor-tab.active')).toContainText('TypeChecker.java')
    await expect(page.locator('.code-file-editor-cursor-position')).toContainText('149')
    await page.getByTestId('code-file-editor-back').click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()

    const processSummaries = pane.getByTestId('code-codex-transcript-process-summary')
    await expect(processSummaries).toHaveCount(2)
    await expect(processSummaries.first()).toHaveText('Worked for 2m 59s')
    await expect(processSummaries.first()).toHaveAttribute('title', '33 events')
    await expect(processSummaries.nth(1)).toHaveText('Working')
    await expect(processSummaries.nth(1)).toHaveAttribute('title', '1 event')
    const initialProcessItems = pane.getByTestId('code-codex-transcript-process-item')
    await expect(initialProcessItems).toHaveCount(1)
    await expect(initialProcessItems).toContainText('Ran npm test')
    await expect(initialProcessItems).not.toContainText('still running')
    await initialProcessItems.getByTestId('code-codex-transcript-process-item-toggle').click()
    await expect(initialProcessItems).toContainText('still running')
    const patchResultCard = pane.getByTestId('code-codex-transcript-result-card')
    const patchResultSummary = patchResultCard.getByTestId('code-codex-transcript-result-summary')
    await expect(patchResultCard).toHaveCount(1)
    await expect(patchResultSummary).toHaveText('5 files changed+39-11')
    await expect(patchResultSummary).toBeVisible()
    await expect(patchResultCard).not.toContainText('backend/codex-transcript.js')
    await expect(patchResultCard).not.toContainText(projectDir)
    await expect(patchResultCard).not.toContainText('Exit code')
    const resultCardMetrics = await pane.getByTestId('code-codex-transcript-result-card').evaluate(element => {
      const summary = element.querySelector('.code-codex-transcript-result-summary')
      return {
        summaryWeight: summary ? getComputedStyle(summary).fontWeight : '',
        summaryHeight: summary ? getComputedStyle(summary).minHeight : '',
      }
    })
    expect(Number(resultCardMetrics.summaryWeight)).toBeLessThanOrEqual(500)
    expect(Number.parseFloat(resultCardMetrics.summaryHeight)).toBeGreaterThanOrEqual(52)

    await page.evaluate(() => {
      document.body.dataset.appearance = 'dark'
    })
    const darkTranscriptMetrics = await pane.getByTestId('code-codex-transcript').evaluate(element => {
      const userBubble = element.querySelector('.code-codex-transcript-user')
      const inlineCode = element.querySelector('.code-codex-transcript-assistant code')
      const blockquote = element.querySelector('.code-codex-transcript-assistant blockquote')
      const resultSummary = element.querySelector('.code-codex-transcript-result-summary')
      return {
        userBubbleBackground: userBubble ? getComputedStyle(userBubble).backgroundColor : '',
        userBubbleBorder: userBubble ? getComputedStyle(userBubble).borderTopColor : '',
        inlineCodeBackground: inlineCode ? getComputedStyle(inlineCode).backgroundColor : '',
        inlineCodeColor: inlineCode ? getComputedStyle(inlineCode).color : '',
        blockquoteColor: blockquote ? getComputedStyle(blockquote).color : '',
        resultSummaryBackground: resultSummary ? getComputedStyle(resultSummary).backgroundColor : '',
      }
    })
    expect(darkTranscriptMetrics.userBubbleBackground).not.toBe('rgba(31, 35, 40, 0.06)')
    expect(darkTranscriptMetrics.userBubbleBorder).not.toBe('rgba(0, 0, 0, 0)')
    expect(darkTranscriptMetrics.inlineCodeBackground).not.toBe('rgba(175, 184, 193, 0.2)')
    expect(darkTranscriptMetrics.inlineCodeColor).not.toBe('rgb(31, 35, 40)')
    expect(darkTranscriptMetrics.blockquoteColor).not.toBe('rgb(36, 41, 47)')
    expect(darkTranscriptMetrics.resultSummaryBackground).not.toBe('rgba(255, 255, 255, 0.82)')
    await page.evaluate(() => {
      document.body.dataset.appearance = 'light'
    })

    await processSummaries.first().scrollIntoViewIfNeeded()
    const firstProcessSummaryTop = await processSummaries.first().evaluate(element => element.getBoundingClientRect().top)
    await processSummaries.first().click()
    await expect(processSummaries.first()).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => {
      const top = await processSummaries.first().evaluate(element => element.getBoundingClientRect().top)
      return Math.abs(top - firstProcessSummaryTop)
    }).toBeLessThanOrEqual(1)
    await expect(pane.getByTestId('code-codex-transcript-steer')).toContainText('中途补充：重点看 web 端更新。')
    const steerMetrics = await pane.getByTestId('code-codex-transcript-steer').evaluate(element => {
      const steer = element.getBoundingClientRect()
      const pane = element.closest('[data-testid="code-codex-transcript"]')?.getBoundingClientRect()
      const bubble = element.querySelector('.code-codex-transcript-user')
      return {
        alignedRight: Boolean(pane && steer.right > pane.left + pane.width * 0.58),
        background: bubble ? getComputedStyle(bubble).backgroundColor : '',
      }
    })
    expect(steerMetrics.alignedRight).toBeTruthy()
    expect(steerMetrics.background).toBe('rgba(31, 35, 40, 0.06)')
    const processGroups = pane.getByTestId('code-codex-transcript-process-group')
    await expect(processGroups).toHaveCount(7)
    await expect(processGroups.filter({ hasText: 'Ran 10 actions' })).toHaveCount(1)
    const processGroupCount = await processGroups.count()
    for (let index = 0; index < processGroupCount; index += 1) {
      await processGroups.nth(index).getByTestId('code-codex-transcript-process-group-toggle').click()
    }
    const processItems = pane.getByTestId('code-codex-transcript-process-item')
    await expect(processItems).toHaveCount(33)
    await expect(processItems.filter({ hasText: 'Ran rg transcript src backend' })).toBeVisible()
    const summaryBox = await processSummaries.first().boundingBox()
    expect(summaryBox).not.toBeNull()
    if (summaryBox) {
      await page.mouse.move(summaryBox.x + summaryBox.width / 2, summaryBox.y + summaryBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(summaryBox.x + summaryBox.width / 2, summaryBox.y + summaryBox.height / 2 + 42)
      await page.mouse.up()
      await expect(processSummaries.first()).toHaveAttribute('aria-expanded', 'true')
    }
    const transcriptScroll = pane.getByTestId('code-codex-transcript-scroll')
    await transcriptScroll.hover()
    await page.mouse.wheel(0, 620)
    await page.waitForTimeout(3500)
    await expect(processSummaries.first()).toHaveAttribute('aria-expanded', 'true')
    await expect(processItems).toHaveCount(33)
    await expect(processItems.filter({ hasText: 'Ran npm run missing-script' })).toHaveAttribute('data-status', 'failed')
	    await expect(processItems.filter({ hasText: 'Warning' }).first()).toHaveAttribute('data-status', 'warning')
    await expect(processItems.filter({ hasText: 'Used imagegen' })).toHaveAttribute('data-status', 'running')
    await expect(processItems.filter({ hasText: 'Searched tools' })).toHaveAttribute('data-type', 'tool')
    await expect(processItems.filter({ hasText: 'Other' })).toHaveAttribute('data-type', 'event')
    await expect(processItems.filter({ hasText: 'Compacted context' })).toHaveAttribute('data-type', 'compaction')
    await expect(processItems.filter({ hasText: 'Hook prompt' })).toHaveAttribute('data-type', 'hook')
    await expect(processItems.filter({ hasText: 'I will inspect the protocol first.' })).toHaveAttribute('data-type', 'message')
    await expect(processItems.filter({ hasText: 'main -> worker' })).toHaveAttribute('data-type', 'agent-message')
    await expect(processItems.filter({ hasText: 'Memory citations' })).toHaveAttribute('data-type', 'citation')
    await expect(processItems.filter({ hasText: 'Rerouted gpt-5-high to gpt-5' })).toHaveAttribute('data-type', 'event')
	    await expect(processItems.filter({ hasText: 'Verified model' })).toHaveAttribute('data-type', 'event')
	    await expect(processItems.filter({ hasText: 'Safety buffering' })).toHaveAttribute('data-status', 'warning')
	    await expect(processItems.filter({ hasText: 'Resolved server request' })).toHaveAttribute('data-type', 'event')
	    await expect(processItems.filter({ hasText: 'Updated plan' }).locator('.code-codex-transcript-plan-list')).toHaveCount(0)
	    await processItems.filter({ hasText: 'Updated plan' }).getByTestId('code-codex-transcript-process-item-toggle').click()
	    await expect(processItems.filter({ hasText: 'Updated plan' }).locator('.code-codex-transcript-plan-list')).toBeVisible()
	    await expect(processItems.filter({ hasText: 'Updated plan' }).locator('.code-codex-transcript-plan-list li.running')).toContainText('implement')
	    await expect(processItems.filter({ hasText: 'Agent spawnAgent' })).toHaveAttribute('data-type', 'agent-tool')
	    await expect(processItems.filter({ hasText: 'interacted worker' })).toHaveAttribute('data-type', 'sub-agent')
	    await expect(processItems.filter({ hasText: 'Subagent completed' })).toHaveAttribute('data-type', 'subagent')
	    await processItems.filter({ hasText: 'Subagent completed' }).getByTestId('code-codex-transcript-process-item-toggle').click()
	    await expect(processItems.filter({ hasText: 'Subagent completed' })).toContainText('Completed a focused implementation check.')
	    await expect(processItems.filter({ hasText: 'Viewed /tmp/screenshot.png' })).toHaveAttribute('data-type', 'image')
	    const generatedProcessImage = processItems.filter({ hasText: 'Generated image' }).locator('img[alt="Generated image"]')
	    await expect(generatedProcessImage).toHaveCount(0)
	    await processItems.filter({ hasText: 'Generated image' }).getByTestId('code-codex-transcript-process-item-toggle').click()
	    await expect(generatedProcessImage).toBeVisible()
    const generatedProcessImageMetrics = await generatedProcessImage.evaluate(image => ({
      loaded: image instanceof HTMLImageElement ? image.complete && image.naturalWidth > 0 : false,
      display: getComputedStyle(image).display,
      borderRadius: getComputedStyle(image).borderRadius,
    }))
    expect(generatedProcessImageMetrics.loaded).toBeTruthy()
    expect(generatedProcessImageMetrics.display).toBe('block')
    expect(generatedProcessImageMetrics.borderRadius).toBe('8px')
    await expect(processItems.filter({ hasText: 'Slept for 2s' })).toHaveAttribute('data-type', 'sleep')
	    await expect(processItems.filter({ hasText: 'Entered review mode' })).toHaveAttribute('data-type', 'review')
	    await expect(processItems.filter({ hasText: 'Error' })).toHaveAttribute('data-status', 'failed')
	    await expect(processItems.filter({ hasText: 'Tool output' }).locator('text=structured output line')).toHaveCount(0)
	    await processItems.filter({ hasText: 'Tool output' }).getByTestId('code-codex-transcript-process-item-toggle').click()
	    await expect(processItems.filter({ hasText: 'structured output line' })).toBeVisible()
    const toolOutputProcessImage = processItems.filter({ hasText: 'Tool output' }).locator('img[alt="Tool output image"]')
    await expect(toolOutputProcessImage).toBeVisible()
    await expect(toolOutputProcessImage).toHaveJSProperty('complete', true)
    const processCopyGeometry = await processItems.filter({ hasText: 'Ran rg transcript src backend' }).evaluate(element => {
      const title = element.querySelector('.code-codex-transcript-process-title-text')?.getBoundingClientRect()
      const copy = element.querySelector('.code-codex-transcript-copy')?.getBoundingClientRect()
      return title && copy
        ? {
            horizontalGap: copy.left - title.right,
            verticalCenterGap: Math.abs((copy.top + copy.height / 2) - (title.top + title.height / 2)),
          }
        : null
    })
	    expect(processCopyGeometry).not.toBeNull()
	    expect(processCopyGeometry?.horizontalGap).toBeGreaterThanOrEqual(6)
	    expect(processCopyGeometry?.horizontalGap).toBeLessThanOrEqual(30)
	    expect(processCopyGeometry?.verticalCenterGap).toBeLessThanOrEqual(2)

    const expandedScreenshotPath = process.env.FARMING_CODEX_TRANSCRIPT_EXPANDED_SCREENSHOT
    if (expandedScreenshotPath) {
      await page.screenshot({ path: expandedScreenshotPath, fullPage: true })
    }

    await pane.getByTestId('code-codex-transcript-scroll').evaluate(element => {
      element.scrollTop = element.scrollHeight
    })
    await expect(pane.getByText('Codex is still working...')).toBeInViewport()

    const screenshotPath = process.env.FARMING_CODEX_TRANSCRIPT_SCREENSHOT
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true })
    }

    await modeToggle.getByRole('button', { name: 'Terminal' }).click()
    await expect(modeToggle.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    await expect(pane.getByTestId('code-codex-transcript')).toHaveCount(0)
    await expect(pane.getByTestId('code-terminal-container')).toBeVisible()
    await expect.poll(async () => {
      const rows = await page.evaluate(id => window.__farmingTerminalTest?.getRows(id, 20) ?? [], agentId)
      return rows.join('\n')
    }, { timeout: 10_000 }).toContain('CHAT_TO_TERMINAL_SENTINEL')
    await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getCanvasInkPixelCount(id) ?? 0, agentId), { timeout: 10_000 }).toBeGreaterThan(0)
    const terminalBox = await pane.getByTestId('code-terminal-container').boundingBox()
    expect(terminalBox?.width ?? 0).toBeGreaterThan(300)
    expect(terminalBox?.height ?? 0).toBeGreaterThan(200)

    await modeToggle.getByRole('button', { name: 'Chat' }).click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()
    await expect.poll(async () => pane.getByTestId('code-codex-transcript-scroll').evaluate(element => element.scrollTop), { timeout: 5_000 }).toBeGreaterThan(100)
    const reviewCard = pane.getByTestId('code-codex-transcript-result-card')
    await reviewCard.scrollIntoViewIfNeeded()
    const reviewPagePromise = page.waitForEvent('popup')
    await reviewCard.getByTestId('code-codex-transcript-result-summary').click()
    const reviewPage = await reviewPagePromise
    await expect.poll(() => new URL(reviewPage.url()).pathname).toBe('/farming/review')
    expect(new URL(reviewPage.url()).searchParams.get('root')).toBe(projectDir)
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await reviewPage.close()
  })

  test('keeps unavailable Codex chat history quiet and preserves raw terminal access', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-unavailable')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = '019fchat-unavailable'

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: false,
            reason: 'history-not-found',
            sessionId,
            turns: [],
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const modeToggle = pane.getByTestId('code-terminal-mode-toggle')
    await expect(modeToggle.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()
    await expect(pane.locator('.code-codex-transcript-blank')).toBeVisible()
    await expect(pane.getByText('Codex transcript is not available yet.')).toHaveCount(0)
    await expect(pane.getByText('Codex 对话历史暂时不可用。')).toHaveCount(0)

    await modeToggle.getByRole('button', { name: 'Terminal' }).click()
    await expect(modeToggle.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    await expect(pane.getByTestId('code-terminal-container')).toBeVisible()
  })

  test('opens transcript absolute paths outside the project through global files', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-project-root')
    fs.mkdirSync(projectDir, { recursive: true })
    const externalRoot = createGlobalTestRoot()
    const externalFilePath = path.join(externalRoot, 'global-note.md')
    const externalOnboardingPath = path.join(externalRoot, 'Documents', 'Codex', '2026-07-08', 'codex-ecs-cpa-account-onboarding.md')
    fs.mkdirSync(path.dirname(externalOnboardingPath), { recursive: true })
    fs.writeFileSync(externalFilePath, ['# Global note', 'line two outside project', 'line three'].join('\n'))
    fs.writeFileSync(externalOnboardingPath, ['# CPA onboarding', 'outside workspace document'].join('\n'))
    const sessionId = '019fchat-global-files'

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            turns: [
              {
                id: 'turn-global-file',
                userMessage: '打开项目外文件',
                finalMessage: [
                  `项目外文件也应该能打开：[global-note.md](${externalFilePath}:2)。`,
                  `文件还是这个：[codex-ecs-cpa-account-onboarding.md](${externalOnboardingPath})。`,
                ].join('\n\n'),
                startedAt: 1,
                completedAt: 2,
                durationMs: 1000,
                status: 'completed',
                processItems: [],
              },
            ],
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    await expect(pane.getByText('项目外文件也应该能打开')).toBeVisible()

    const rootRelativeOnboardingPath = externalOnboardingPath.replace(/^\/+/, '')
    const externalOnboardingRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('agentId') === '__farming_global_files__' &&
        url.searchParams.get('path') === rootRelativeOnboardingPath
    })
    await pane.getByRole('link', { name: 'codex-ecs-cpa-account-onboarding.md' }).click()
    await externalOnboardingRequest

    await expect(page.locator('.code-file-editor-tab').filter({ hasText: 'codex-ecs-cpa-account-onboarding.md' })).toBeVisible()
    await expect(page.getByTestId('code-root-files-group')).toBeVisible()
    await expect(page.getByTestId('code-root-files-title')).toHaveText('/')
    await expect(page.locator('[data-testid="code-files-section"][data-project-id="__farming_global_files_project__"]')).toBeVisible()
    await page.getByTestId('code-root-files-title').click()
    await expect(page.locator('[data-testid="code-files-section"][data-project-id="__farming_global_files_project__"]')).toHaveCount(0)
    await page.getByTestId('code-root-files-title').click()
    await expect(page.locator('[data-testid="code-files-section"][data-project-id="__farming_global_files_project__"]')).toBeVisible()
    await expect(page.getByText('outside workspace document')).toBeVisible()
    await page.getByTestId('code-file-editor-back').click()
    await expect(pane.getByTestId('code-codex-transcript')).toBeVisible()

    const rootRelativeExternalPath = externalFilePath.replace(/^\/+/, '')
    const externalFileRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/api/files/file') &&
        url.searchParams.get('agentId') === '__farming_global_files__' &&
        url.searchParams.get('path') === rootRelativeExternalPath
    })
    await pane.getByRole('link', { name: 'global-note.md' }).click()
    await externalFileRequest

    await expect(page.locator('.code-file-editor-tab').filter({ hasText: 'global-note.md' })).toBeVisible()
    await expect(page.locator('[data-testid="code-files-section"][data-project-id="__farming_global_files_project__"]')).toBeVisible()
  })

  test('opens transcript review patches outside the project through global files', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-review-project-root')
    fs.mkdirSync(projectDir, { recursive: true })
    const externalRoot = createGlobalTestRoot()
    const externalFilePath = path.join(externalRoot, 'global-review-note.md')
    fs.writeFileSync(externalFilePath, ['before review', 'after review'].join('\n'))
    const sessionId = '019fchat-global-review-files'

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            turns: [
              {
                id: 'turn-global-review-file',
                userMessage: 'Review 项目外文件',
                finalMessage: '已经修改了项目外的一个文件。',
                startedAt: 1,
                completedAt: 2,
                durationMs: 1000,
                status: 'completed',
                processItems: [
                  {
                    id: 'patch-global-review',
                    type: 'patch',
                    title: 'Edited 1 file',
                    detail: `update ${externalFilePath} +1 -1`,
                    status: 'completed',
                  },
                ],
              },
            ],
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    await expect(pane.getByTestId('code-codex-transcript-result-summary')).toHaveText('1 file changed+1-1')

    const reviewPagePromise = page.waitForEvent('popup')
    await pane.getByTestId('code-codex-transcript-result-summary').click()
    const reviewPage = await reviewPagePromise
    await expect.poll(() => new URL(reviewPage.url()).pathname).toBe('/farming/review')
    expect(new URL(reviewPage.url()).searchParams.get('root')).toBe(projectDir)
    await expect(page.locator('.code-file-editor-tab').filter({ hasText: 'global-review-note.md' })).toHaveCount(0)
    await reviewPage.close()
  })

  test('lazy loads older Codex chat turns when scrolling to the top', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-lazy-history')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = '019fchat-lazy-history'
    const allTurns = Array.from({ length: 120 }, (_, index) => ({
      id: `turn-lazy-${index}`,
      userMessage: `历史问题 ${index}`,
      finalMessage: `历史回答 ${index}`,
      startedAt: index,
      completedAt: index + 1,
      durationMs: 1000,
      status: 'completed',
      processItems: [],
    }))
    const requestedLimits: number[] = []

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      const url = new URL(route.request().url())
      const maxTurns = Number.parseInt(url.searchParams.get('maxTurns') || '80', 10)
      requestedLimits.push(maxTurns)
      const turns = allTurns.slice(-maxTurns)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            hasMoreBefore: turns.length < allTurns.length,
            turnLimit: maxTurns,
            turns,
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const transcriptScroll = pane.getByTestId('code-codex-transcript-scroll')
    await expect(transcriptScroll).toContainText('历史问题 40')
    await expect(transcriptScroll).not.toContainText('历史问题 0')
    await expect(pane.locator('.code-codex-transcript-turn')).toHaveCount(80)
    await transcriptScroll.evaluate(element => {
      element.scrollTop = element.scrollHeight
    })
    await transcriptScroll.evaluate(element => {
      element.scrollTop = Math.max(0, element.scrollTop - 260)
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect(pane.getByTestId('code-codex-transcript-jump-bottom')).toBeVisible()
    await pane.getByTestId('code-codex-transcript-jump-bottom').click()
    await expect.poll(async () => transcriptScroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop), { timeout: 5_000 })
      .toBeLessThanOrEqual(120)
    await expect(pane.getByTestId('code-codex-transcript-jump-bottom')).toHaveCount(0)

    await transcriptScroll.evaluate(element => {
      element.scrollTop = 0
    })
    await transcriptScroll.hover()
    await page.mouse.wheel(0, -700)

    await expect.poll(() => requestedLimits.some(limit => limit >= 160), { timeout: 5_000 }).toBeTruthy()
    await expect(transcriptScroll).toContainText('历史问题 0')
    await expect(pane.locator('.code-codex-transcript-turn')).toHaveCount(120)
    await expect.poll(async () => transcriptScroll.evaluate(element => element.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(0)
  })

  test('falls back to terminal when Codex chat is empty but terminal already has conversation output', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-terminal-source')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = '019fchat-terminal-source'

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            turns: [],
          },
        }),
      })
    })
    await page.route(/\/farming\/api\/agents\/[^/]+\/session-text$/, async route => {
      await route.fulfill({
        contentType: 'text/plain',
        body: [
          'OpenAI Codex (v0.142.5)',
          '',
          '› 请只回复一行: FARMING_RESTORE_TEST_OK',
          '',
          '• FARMING_RESTORE_TEST_OK',
        ].join('\n'),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const modeToggle = pane.getByTestId('code-terminal-mode-toggle')
    await expect(modeToggle.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    await expect(pane.getByTestId('code-codex-transcript')).toHaveCount(0)
    await expect(pane.getByTestId('code-terminal-container')).toBeVisible()
  })

  test('refreshes dynamic Codex chat without stale waiting text after final content appears', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'codex-chat-dynamic')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = '019fchat-dynamic'
    let requestCount = 0

    await page.route(/\/farming\/api\/agents\/[^/]+\/codex-transcript(?:\?.*)?$/, async route => {
      requestCount += 1
      const hasFinalMessage = requestCount >= 2
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            turns: [
              {
                id: 'turn-dynamic',
                userMessage: '动态写入测试',
                finalMessage: hasFinalMessage ? '动态最终回复已经出现。' : '',
                startedAt: 1,
                completedAt: null,
                durationMs: null,
                status: 'inProgress',
                processItems: [],
              },
            ],
          },
        }),
      })
    })

    const agentId = await createCodexHistoryAgent(page, projectDir, sessionId)
    await openFarming(page)

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    await expect(pane.getByText('动态写入测试')).toBeVisible()
    await expect(pane.getByText('动态最终回复已经出现。')).toBeVisible({ timeout: 6_000 })
    await expect(pane.getByText('Codex is still working...')).toHaveCount(0)
  })
})
