import type { AcpPendingPermission } from '@/types/agent'
import type { CodeCopy } from '../copy'

interface AcpPermissionCardProps {
  request: AcpPendingPermission
  onRespond: (requestId: string, optionId?: string, cancelled?: boolean) => void
  copy: CodeCopy
}

export function AcpPermissionCard({ request, onRespond, copy }: AcpPermissionCardProps) {
  const title = request.toolCall?.title || copy.acpPermissionTool
  const details: Array<[string, unknown]> = []
  if (request.toolCall?.rawInput !== undefined) details.push(['Input', request.toolCall.rawInput])
  if (request.toolCall?.content !== undefined) details.push(['Content', request.toolCall.content])
  if (request.toolCall?.locations !== undefined) details.push(['Locations', request.toolCall.locations])
  return (
    <section className="code-app-server-request" data-testid="code-acp-permission-request">
      <header>
        <strong>{copy.acpPermissionTitle}</strong>
        <span>{request.toolCall?.kind || 'tool'}</span>
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
      <div className="code-app-server-request-actions">
        {request.options.map(option => (
          <button
            type="button"
            key={option.optionId}
            className={option.kind.startsWith('allow') ? 'approve' : undefined}
            onClick={() => onRespond(request.requestId, option.optionId, false)}
          >
            {option.name}
          </button>
        ))}
        <button type="button" onClick={() => onRespond(request.requestId, undefined, true)}>
          {copy.appServerRequestDecline}
        </button>
      </div>
    </section>
  )
}
