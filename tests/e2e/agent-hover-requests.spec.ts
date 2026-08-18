import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

function git(workspace: string, ...args: string[]) {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
}

test('pinned Agent hover reuses Git state without preparing Chat or requesting a branch', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'agent-hover-requests')
  fs.mkdirSync(workspace, { recursive: true })
  git(workspace, 'init')
  git(workspace, 'config', 'user.email', 'farming@example.test')
  git(workspace, 'config', 'user.name', 'Farming Test')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Agent hover requests\n')
  git(workspace, 'add', 'README.md')
  git(workspace, 'commit', '-m', 'initial fixture')
  git(workspace, 'branch', '-M', 'hover-source')

  let branchRequests = 0
  let transcriptPrepareRequests = 0
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type?: string
          request?: { operation?: string }
        }
        if (message.type === 'workspace-request' && message.request?.operation === 'branch') {
          branchRequests += 1
        }
      } catch {
        // Non-JSON frames belong to another protocol.
      }
    })
  })
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/acp-transcript/prepare')) {
      transcriptPrepareRequests += 1
    }
  })

  await openFarming(page)
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'opencode', workspace, agentRuntimeMode: 'chat' },
  })
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy()
  const { agentId } = await createResponse.json() as { agentId: string }

  const pinResponse = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { pinned: true },
  })
  expect(pinResponse.ok()).toBeTruthy()

  const pinnedRow = page.getByTestId('code-pinned-section')
    .locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(pinnedRow).toBeVisible()
  await pinnedRow.hover()

  const preview = page.getByTestId('code-agent-hover-preview')
  await expect(preview).toBeVisible()
  await expect(preview.getByTestId('code-agent-hover-preview-branch')).toHaveText('hover-source')
  expect(branchRequests).toBe(0)
  expect(transcriptPrepareRequests).toBe(0)

  await pinnedRow.click()
  await expect.poll(() => transcriptPrepareRequests).toBe(1)
  expect(branchRequests).toBe(0)
})
