#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import WebSocket from 'ws'

function parseArgs(argv) {
  const options = {
    baseUrl: '',
    tokenFile: '',
    workspace: '',
    agent: 'codex',
    timeoutMs: 60_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      return value
    }
    if (argument === '--base-url') options.baseUrl = readValue()
    else if (argument === '--token-file') options.tokenFile = readValue()
    else if (argument === '--workspace') options.workspace = readValue()
    else if (argument === '--agent') options.agent = readValue()
    else if (argument === '--timeout-ms') options.timeoutMs = Number(readValue())
    else throw new Error(`Unknown deployment smoke option: ${argument}`)
  }
  if (!options.baseUrl || !options.workspace) throw new Error('--base-url and --workspace are required')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 180_000) {
    throw new Error('--timeout-ms must be between 1000 and 180000')
  }
  return options
}

function tokenFromFile(filePath) {
  if (!filePath) return ''
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

function bearerHeader(token) {
  return token ? { Authorization: `Bearer ${Buffer.from(token, 'utf8').toString('base64url')}` } : {}
}

async function fetchJson(url, token, options = {}, timeoutMs = 60_000) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...bearerHeader(token),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} returned ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
  return body
}

async function verifyWebSocket(baseUrl, token, timeoutMs) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
  url.search = token ? `?token=${encodeURIComponent(token)}` : ''
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('Timed out waiting for the initial WebSocket state'))
    }, timeoutMs)
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data))
        if (message.type !== 'state') return
        clearTimeout(timer)
        socket.close()
        resolve()
      } catch (error) {
        clearTimeout(timer)
        socket.terminate()
        reject(error)
      }
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitForAgent(controlUrl, token, agentId, predicate, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const listed = await fetchJson(controlUrl, token, {}, timeoutMs)
    const agent = Array.isArray(listed?.agents) ? listed.agents.find(item => item.id === agentId) : null
    if (agent && predicate(agent)) return agent
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for deployment smoke Agent ${agentId}`)
}

async function deleteAgent(controlUrl, token, agentId, timeoutMs) {
  if (!agentId) return
  await fetchJson(`${controlUrl}/${encodeURIComponent(agentId)}?recordHistory=0`, token, {
    method: 'DELETE',
  }, timeoutMs)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const controlUrl = `${baseUrl}/api/control/agents`
  const token = tokenFromFile(options.tokenFile)
  const baseline = await fetchJson(controlUrl, token, {}, options.timeoutMs)
  const baselineIds = new Set((baseline?.agents || []).map(agent => agent.id))
  await verifyWebSocket(baseUrl, token, options.timeoutMs)

  fs.mkdirSync(options.workspace, { recursive: true })
  const createdIds = []
  try {
    const terminal = await fetchJson(controlUrl, token, {
      method: 'POST',
      body: JSON.stringify({
        command: 'bash',
        workspace: options.workspace,
        agentRuntimeMode: 'terminal',
        requestId: `deploy-terminal-${process.pid}-${Date.now()}`,
      }),
    }, options.timeoutMs)
    if (!terminal?.agentId) throw new Error('Terminal smoke did not return an Agent id')
    createdIds.push(terminal.agentId)
    await waitForAgent(controlUrl, token, terminal.agentId, agent => agent.status === 'running', options.timeoutMs)
    await deleteAgent(controlUrl, token, terminal.agentId, options.timeoutMs)
    createdIds.pop()

    const chat = await fetchJson(controlUrl, token, {
      method: 'POST',
      body: JSON.stringify({
        command: options.agent,
        workspace: options.workspace,
        agentRuntimeMode: 'chat',
        requestId: `deploy-chat-${process.pid}-${Date.now()}`,
      }),
    }, options.timeoutMs)
    if (!chat?.agentId) throw new Error('Chat smoke did not return an Agent id')
    createdIds.push(chat.agentId)
    await waitForAgent(
      controlUrl,
      token,
      chat.agentId,
      agent => (
        agent.status === 'running'
        && agent.runtimeBinding?.kind === 'acp'
        && agent.runtimeBinding.state === 'idle'
      ),
      options.timeoutMs,
    )
    await deleteAgent(controlUrl, token, chat.agentId, options.timeoutMs)
    createdIds.pop()
  } catch (error) {
    const current = await fetchJson(controlUrl, token, {}, options.timeoutMs).catch(() => ({ agents: [] }))
    for (const agent of current?.agents || []) {
      if (
        !baselineIds.has(agent.id)
        && agent.cwd === path.resolve(options.workspace)
        && ['bash', options.agent].includes(agent.command)
      ) createdIds.push(agent.id)
    }
    throw error
  } finally {
    for (const agentId of [...new Set(createdIds)].reverse()) {
      await deleteAgent(controlUrl, token, agentId, options.timeoutMs).catch(() => {})
    }
  }

  process.stdout.write(`${JSON.stringify({ ok: true, websocket: true, terminal: true, chat: true })}\n`)
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error))
  process.exit(1)
})
