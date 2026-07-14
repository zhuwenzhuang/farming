import { useMemo, useState, type FormEvent } from 'react'
import type { AcpElicitationProperty, AcpPendingElicitation } from '@/types/agent'

type ElicitationValue = string | number | boolean | string[]

interface AcpElicitationCardProps {
  request: AcpPendingElicitation
  onRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, ElicitationValue>,
  ) => void
}

function choices(property: AcpElicitationProperty) {
  if (Array.isArray(property.oneOf)) return property.oneOf.map(item => ({ value: item.const, label: item.title }))
  if (Array.isArray(property.enum)) return property.enum.map(value => ({ value, label: value }))
  if (Array.isArray(property.items?.anyOf)) return property.items.anyOf.map(item => ({ value: item.const, label: item.title }))
  if (Array.isArray(property.items?.enum)) return property.items.enum.map(value => ({ value, label: value }))
  return []
}

function initialValue(property: AcpElicitationProperty): ElicitationValue {
  if (property.type === 'boolean') return property.default === true
  if (property.type === 'array') return Array.isArray(property.default) ? property.default : []
  if (property.type === 'number' || property.type === 'integer') {
    return typeof property.default === 'number' ? property.default : ''
  }
  if (typeof property.default === 'string') return property.default
  return choices(property)[0]?.value || ''
}

export function AcpElicitationCard({ request, onRespond }: AcpElicitationCardProps) {
  const properties = request.requestedSchema?.properties || {}
  const required = new Set(request.requestedSchema?.required || [])
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() => Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [name, initialValue(property)]),
  ))
  const [validationError, setValidationError] = useState('')
  const title = request.requestedSchema?.title || 'Input requested'
  const acceptedUrl = request.mode === 'url' && request.status === 'accepted'
  const safeUrl = useMemo(() => {
    if (request.mode !== 'url' || !request.url) return ''
    try {
      const url = new URL(request.url)
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
    } catch {
      return ''
    }
  }, [request.mode, request.url])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    for (const [name, property] of Object.entries(properties)) {
      const value = values[name]
      if (property.type !== 'array') continue
      const selected = Array.isArray(value) ? value : []
      const minimum = Math.max(required.has(name) ? 1 : 0, Number(property.minItems || 0))
      if (selected.length < minimum) {
        setValidationError(`${property.title || name} needs at least ${minimum} selection${minimum === 1 ? '' : 's'}.`)
        return
      }
      if (Number.isFinite(property.maxItems) && selected.length > Number(property.maxItems)) {
        setValidationError(`${property.title || name} allows at most ${property.maxItems} selections.`)
        return
      }
    }
    setValidationError('')
    const content = Object.fromEntries(Object.entries(values).filter(([name, value]) => (
      required.has(name)
      || (Array.isArray(value) ? value.length > 0 : value !== '')
    )))
    onRespond(request.requestId, 'accept', content)
  }

  return (
    <form className="code-app-server-request code-acp-elicitation" data-testid="code-acp-elicitation" data-status={request.status || 'pending'} onSubmit={submit}>
      <header><strong>{title}</strong><span>{request.origin === 'subagent' ? `Subagent · ${request.mode}` : request.mode}</span></header>
      <p>{request.message}</p>
      {request.requestedSchema?.description ? <small>{request.requestedSchema.description}</small> : null}
      {validationError ? <small className="code-acp-elicitation-error" role="alert">{validationError}</small> : null}
      {request.mode === 'url' ? (
        safeUrl ? (
          <a className="code-acp-elicitation-link" href={safeUrl} target="_blank" rel="noreferrer">Open secure link</a>
        ) : <small role="alert">The Agent provided an unsupported link.</small>
      ) : (
        <div className="code-app-server-request-questions">
          {Object.entries(properties).map(([name, property]) => {
            const options = choices(property)
            const label = property.title || name
            if (property.type === 'boolean') {
              return (
                <label className="code-acp-elicitation-checkbox" key={name}>
                  <input type="checkbox" checked={values[name] === true} onChange={event => setValues(current => ({ ...current, [name]: event.target.checked }))} />
                  <span>{label}</span>
                  {property.description ? <small>{property.description}</small> : null}
                </label>
              )
            }
            if (property.type === 'array') {
              return (
                <fieldset key={name}>
                  <legend>{label}</legend>
                  {options.map(option => {
                    const selected = Array.isArray(values[name]) ? values[name] as string[] : []
                    return (
                      <label className="code-acp-elicitation-checkbox" key={option.value}>
                        <input
                          type="checkbox"
                          checked={selected.includes(option.value)}
                          onChange={event => setValues(current => ({
                            ...current,
                            [name]: event.target.checked
                              ? [...selected, option.value]
                              : selected.filter(value => value !== option.value),
                          }))}
                        />
                        <span>{option.label}</span>
                      </label>
                    )
                  })}
                </fieldset>
              )
            }
            return (
              <label key={name}>
                <span>{label}</span>
                {options.length > 0 ? (
                  <select value={String(values[name] ?? '')} required={required.has(name)} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))}>
                    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={property.type === 'number' || property.type === 'integer'
                      ? 'number'
                      : property.format === 'email'
                        ? 'email'
                        : property.format === 'date'
                          ? 'date'
                          : property.format === 'date-time'
                            ? 'datetime-local'
                            : property.format === 'uri'
                              ? 'url'
                              : 'text'}
                    value={String(values[name] ?? '')}
                    required={required.has(name)}
                    min={property.minimum ?? undefined}
                    max={property.maximum ?? undefined}
                    minLength={property.minLength ?? undefined}
                    maxLength={property.maxLength ?? undefined}
                    pattern={property.pattern ?? undefined}
                    step={property.type === 'integer' ? 1 : property.type === 'number' ? 'any' : undefined}
                    onChange={event => setValues(current => ({
                      ...current,
                      [name]: property.type === 'number' || property.type === 'integer'
                        ? event.target.value === '' ? '' : event.target.valueAsNumber
                        : event.target.value,
                    }))}
                  />
                )}
                {property.description ? <small>{property.description}</small> : null}
              </label>
            )
          })}
        </div>
      )}
      {acceptedUrl ? <small className="code-acp-elicitation-waiting">Waiting for the Agent to confirm completion…</small> : (
        <div className="code-app-server-request-actions">
          <button type="submit" className="approve" disabled={request.mode === 'url' && !safeUrl}>
            {request.mode === 'url' ? 'Continue' : 'Submit'}
          </button>
          <button type="button" onClick={() => onRespond(request.requestId, 'decline')}>Decline</button>
          <button type="button" onClick={() => onRespond(request.requestId, 'cancel')}>Cancel</button>
        </div>
      )}
    </form>
  )
}
