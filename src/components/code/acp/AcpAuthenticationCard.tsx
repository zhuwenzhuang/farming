import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { appPath } from '@/lib/base-path'
import type { AcpAuthMethod, AcpAuthTerminal } from './types'

function terminalKeyInput(event: KeyboardEvent<HTMLInputElement>) {
  if (event.ctrlKey && event.key.toLowerCase() === 'c') return '\u0003'
  if (event.key === 'Tab') return '\t'
  if (event.key === 'Escape') return '\u001b'
  if (event.key === 'ArrowUp') return '\u001b[A'
  if (event.key === 'ArrowDown') return '\u001b[B'
  return ''
}

function AcpAuthenticationTerminal({ agentId, authTerminal }: { agentId: string; authTerminal: AcpAuthTerminal }) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const outputRef = useRef<HTMLPreElement | null>(null)
  const terminal = authTerminal.terminal
  const running = authTerminal.state === 'running' && !terminal?.exitStatus
  const interactive = running && terminal?.interactive === true

  useEffect(() => {
    const output = outputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [terminal?.output])

  const send = async (value: string) => {
    if (!interactive || !value || sending) return
    setSending(true)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-terminals/${encodeURIComponent(authTerminal.terminalId)}/input`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: value }),
      })
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(body?.error || `Failed to send terminal input (${response.status})`)
      setError('')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to send terminal input')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="code-acp-auth-terminal" data-testid="code-acp-auth-terminal">
      <div className="code-acp-auth-terminal-heading">
        <strong>{authTerminal.name || 'Sign in'}</strong>
        <span>{authTerminal.state === 'running' ? 'Waiting for sign-in' : authTerminal.state}</span>
      </div>
      <pre ref={outputRef} data-testid="code-acp-auth-terminal-output">{terminal?.output || 'Starting sign-in…'}</pre>
      {interactive ? (
        <form
          onSubmit={event => {
            event.preventDefault()
            const value = input
            if (!value) return
            setInput('')
            void send(`${value}\r`)
          }}
        >
          <input
            aria-label="Terminal sign-in input"
            autoComplete="off"
            data-testid="code-acp-auth-terminal-input"
            disabled={sending}
            value={input}
            onChange={event => setInput(event.currentTarget.value)}
            onKeyDown={event => {
              const value = terminalKeyInput(event)
              if (!value) return
              event.preventDefault()
              void send(value)
            }}
          />
          <button type="submit" disabled={sending || !input}>Send</button>
        </form>
      ) : null}
      {authTerminal.error || error ? <small className="code-acp-auth-terminal-error">{authTerminal.error || error}</small> : null}
    </div>
  )
}

export function AcpAuthenticationCard({
  agentId,
  methods,
  authTerminal,
  agentName,
  authenticatingId,
  onAuthenticate,
}: {
  agentId: string
  methods: AcpAuthMethod[]
  authTerminal: AcpAuthTerminal | null
  agentName: string
  authenticatingId: string
  onAuthenticate: (methodId: string) => void
}) {
  if (methods.length === 0 && !authTerminal) return null
  const supportedMethods = methods.filter(method => !method.type || method.type === 'agent' || method.type === 'terminal')
  const clientManagedMethods = methods.filter(method => method.type === 'env_var')
  return (
    <section className="code-acp-request code-acp-authentication" data-testid="code-acp-authentication" role="alert">
      <header><strong>Sign in to {agentName || 'Agent'}</strong><span>Authentication required</span></header>
      <div className="code-acp-authentication-methods">
        {authTerminal ? <AcpAuthenticationTerminal agentId={agentId} authTerminal={authTerminal} /> : null}
        {supportedMethods.map(method => (
          <div className="code-acp-authentication-method" key={method.id}>
            <div>
              <strong>{method.name || method.id}</strong>
              {method.description ? <small>{method.description}</small> : null}
              {method.link ? <a href={method.link} target="_blank" rel="noreferrer">Get credentials</a> : null}
            </div>
            <button
              type="button"
              disabled={Boolean(authenticatingId)}
              onClick={() => onAuthenticate(method.id)}
            >
              {authenticatingId === method.id || (authTerminal?.methodId === method.id && authTerminal.state === 'running') ? 'Signing in…' : 'Authenticate'}
            </button>
          </div>
        ))}
        {clientManagedMethods.map(method => (
          <div className="code-acp-authentication-method unsupported" key={method.id}>
            <div>
              <strong>{method.name || method.id}</strong>
              {method.description ? <small>{method.description}</small> : null}
              {method.type === 'env_var' ? (
                <small>
                  Set {method.vars?.map(variable => variable.label || variable.name).join(', ') || 'the requested environment variables'} and restart the Agent.
                </small>
              ) : null}
              {method.link ? <a href={method.link} target="_blank" rel="noreferrer">Get credentials</a> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
