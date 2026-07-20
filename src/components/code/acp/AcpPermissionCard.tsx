import { useState } from 'react'
import type { AcpPendingPermission } from '@/types/agent'
import type { CodeCopy } from '../copy'

interface SandboxAuthorizationDetails {
  command?: string
  network_hosts?: string[]
  network_all_hosts?: boolean
  network?: boolean
  allow_fs_write_all?: boolean
  unsandboxed?: boolean
  write_paths?: string[]
  reason?: string
}

interface SandboxFallbackDetails {
  command?: string
  reason?: string
  docs_section?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

interface AcpPermissionCardProps {
  request: AcpPendingPermission
  onRespond: (requestId: string, optionId?: string, cancelled?: boolean) => void
  copy: CodeCopy
}

export function AcpPermissionCard({ request, onRespond, copy }: AcpPermissionCardProps) {
  const title = request.toolCall?.title || copy.acpPermissionTool
  const allowOptions = request.options.filter(option => option.kind.startsWith('allow'))
  const rejectOptions = request.options.filter(option => option.kind.startsWith('reject'))
  const [allowOptionId, setAllowOptionId] = useState(
    allowOptions.find(option => option.kind === 'allow_once')?.optionId || allowOptions[0]?.optionId || '',
  )
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const meta = { ...(request._meta || {}), ...(request.toolCall?._meta || {}) }
  const sandbox = record(meta.sandbox_authorization) as SandboxAuthorizationDetails | null
  const fallback = record(meta.sandbox_fallback_authorization) as SandboxFallbackDetails | null
  const sandboxNotApplied = meta.sandbox_not_applied
  const networkHosts = Array.isArray(sandbox?.network_hosts) ? sandbox.network_hosts.map(String) : []
  const writePaths = Array.isArray(sandbox?.write_paths) ? sandbox.write_paths.map(String) : []
  const securityWarnings = request.securityWarnings || []
  const allowBlocked = securityWarnings.length > 0 && !riskAcknowledged
  const details: Array<[string, unknown]> = []
  if (request.toolCall?.rawInput !== undefined) details.push(['Input', request.toolCall.rawInput])
  if (request.toolCall?.content !== undefined) details.push(['Content', request.toolCall.content])
  if (request.toolCall?.locations !== undefined) details.push(['Locations', request.toolCall.locations])
  return (
    <section className="code-acp-request" data-testid="code-acp-permission-request">
      <header>
        <strong>{copy.acpPermissionTitle}</strong>
        <span>{request.origin === 'subagent' ? `Subagent · ${request.toolCall?.kind || 'tool'}` : request.toolCall?.kind || 'tool'}</span>
      </header>
      <p>{title}</p>
      {details.length > 0 ? (
        <details className="code-acp-permission-details">
          <summary>Details</summary>
          {details.map(([label, value]) => (
            <div key={label}>
              <strong>{label}</strong>
              <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
            </div>
          ))}
        </details>
      ) : null}
      {sandbox ? (
        <section className="code-acp-sandbox-details" data-testid="code-acp-sandbox-details">
          {sandbox.reason ? <p><strong>Reason from Agent</strong><span>{sandbox.reason}</span></p> : null}
          {sandbox.unsandboxed ? <p className="warning"><strong>Sandbox</strong><span>Runs without the OS sandbox</span></p> : null}
          {sandbox.network_all_hosts || sandbox.network ? (
            <p><strong>Network</strong><span>Any host</span></p>
          ) : networkHosts.length > 0 ? (
            <details><summary>Network · {networkHosts.length} {networkHosts.length === 1 ? 'host' : 'hosts'}</summary><ul>{networkHosts.map(host => <li key={host}><code>{host}</code></li>)}</ul></details>
          ) : null}
          {sandbox.allow_fs_write_all ? (
            <p><strong>Write access</strong><span>Unrestricted workspace writes</span></p>
          ) : writePaths.length > 0 ? (
            <details><summary>Write access · {writePaths.length} {writePaths.length === 1 ? 'path' : 'paths'}</summary><ul>{writePaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>
          ) : null}
          {sandbox.command ? <details><summary>Command</summary><pre>{sandbox.command}</pre></details> : null}
        </section>
      ) : null}
      {fallback ? (
        <section className="code-acp-sandbox-details warning" data-testid="code-acp-sandbox-fallback">
          <p><strong>Sandbox unavailable</strong><span>{fallback.reason || 'The command may run without OS sandboxing.'}</span></p>
          {fallback.command ? <pre>{fallback.command}</pre> : null}
        </section>
      ) : null}
      {sandboxNotApplied ? (
        <section className="code-acp-sandbox-details warning" data-testid="code-acp-sandbox-not-applied">
          <p><strong>Sandbox not applied</strong><span>{typeof sandboxNotApplied === 'string' ? sandboxNotApplied : JSON.stringify(sandboxNotApplied)}</span></p>
        </section>
      ) : null}
      {securityWarnings.length > 0 ? (
        <label className="code-acp-permission-risk" data-testid="code-acp-permission-risk">
          <strong>Potentially misleading Unicode</strong>
          {securityWarnings.map(warning => (
            <span className="code-acp-permission-risk-finding" key={`${warning.targetType}:${warning.value}`}>
              <code>{warning.displayValue}</code>
              {warning.characters.map(character => (
                <small key={`${character.codePoint}:${character.kind}`}>
                  {character.character ? `‘${character.character}’ ` : ''}{character.codePoint} · {character.description}
                </small>
              ))}
            </span>
          ))}
          <input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />
          <span>I reviewed these targets and wish to proceed.</span>
        </label>
      ) : null}
      <div className="code-acp-request-actions">
        {allowOptions.length > 1 ? (
          <select
            aria-label="Permission scope"
            value={allowOptionId}
            onChange={event => setAllowOptionId(event.target.value)}
          >
            {allowOptions.map(option => <option key={option.optionId} value={option.optionId}>{option.name}</option>)}
          </select>
        ) : null}
        {allowOptions.length > 0 ? (
          <button
            type="button"
            className="approve"
            disabled={allowBlocked}
            onClick={() => onRespond(request.requestId, allowOptionId || allowOptions[0]!.optionId, false)}
          >
            {allowOptions.length === 1 ? allowOptions[0]!.name : copy.acpPermissionAllow}
          </button>
        ) : null}
        {rejectOptions.map(option => (
          <button type="button" key={option.optionId} onClick={() => onRespond(request.requestId, option.optionId, false)}>
            {option.name}
          </button>
        ))}
        <button type="button" onClick={() => onRespond(request.requestId, undefined, true)}>
          {copy.cancel}
        </button>
      </div>
    </section>
  )
}
