import { useMemo, useState, type FormEvent } from 'react'
import { PencilGlyph, QuestionGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../copy'
import type { ElicitationDraft, ElicitationValues } from './acp-elicitation-presentation'
import { CodeSelect } from '@/components/CodeSelect'
import type { AcpElicitationProperty, AcpPendingElicitation } from '@/types/agent'

type ElicitationValue = string | number | boolean | string[]

interface AcpElicitationCardProps {
  request: AcpPendingElicitation
  copy: CodeCopy
  draft?: ElicitationDraft
  onValuesChange?: (values: ElicitationValues) => void
  onLater?: () => void
  onDetailsChange?: (expanded: boolean) => void
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
  return ''
}

export function AcpElicitationCard({ request, onRespond, copy, draft, onValuesChange, onLater, onDetailsChange }: AcpElicitationCardProps) {
  const properties = request.requestedSchema?.properties || {}
  const required = new Set(request.requestedSchema?.required || [])
  const defaults = Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, initialValue(property)]))
  const values = draft?.values || defaults
  const setValues = (update: (current: ElicitationValues) => ElicitationValues) => onValuesChange?.(update(values))
  const disabled = Boolean(draft?.status)
  const [validationError, setValidationError] = useState('')
  const entries = Object.entries(properties)
  const optionalText = entries.filter(([name, property]) => !required.has(name) && property.type === 'string' && choices(property).length === 0)
  const deferred = optionalText.length < entries.length ? optionalText : []
  const deferredNames = new Set(deferred.map(([name]) => name))
  const primary = entries.filter(([name]) => !deferredNames.has(name))
  const singleProperty = primary.length === 1 ? primary[0]?.[1] : undefined
  const compact = singleProperty?.type === 'string' && choices(singleProperty).length > 0 && choices(singleProperty).length <= 4
  const title = request.requestedSchema?.title || copy.questionPending
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
    if (disabled) return
    for (const [name, property] of Object.entries(properties)) {
      const value = values[name]
      if (required.has(name) && value === '') {
        setValidationError(copy.questionRequired(property.title || name))
        return
      }
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

  const renderField = ([name, property]: [string, AcpElicitationProperty]) => {
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
    if (options.length > 0 && options.length <= 4) {
      return <fieldset className="code-acp-elicitation-options" key={name}>
        <legend>{label}</legend>
        {options.map(option => <label className="code-acp-elicitation-checkbox" key={option.value}>
          <input type="radio" name={`${request.requestId}-${name}`} value={option.value}
            checked={values[name] === option.value} required={required.has(name)}
            onChange={() => setValues(current => ({ ...current, [name]: option.value }))} />
          <span>{option.label}</span>
        </label>)}
        {property.description ? <small>{property.description}</small> : null}
      </fieldset>
    }
    return options.length > 0 ? (
      <div className="code-acp-select-question" key={name}>
        <CodeSelect
          label={label}
          value={String(values[name] ?? '')}
          required={required.has(name)}
          options={[{ value: '', label: copy.questionChoose, disabled: required.has(name) }, ...options]}
          disabled={disabled}
          onChange={value => setValues(current => ({ ...current, [name]: value }))}
        />
        {property.description ? <small>{property.description}</small> : null}
      </div>
    ) : (
      <label key={name}>
        <span>{label}</span>
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
            data-field={name}
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
        {property.description ? <small>{property.description}</small> : null}
      </label>
    )
  }

  return (
    <form className={`code-acp-request code-acp-elicitation ${compact ? 'is-compact-question' : ''}`} data-testid="code-acp-elicitation" data-status={request.status || 'pending'} onSubmit={submit}
      onInvalidCapture={event => {
        if (event.target instanceof HTMLInputElement && deferredNames.has(event.target.dataset.field || '') && !draft?.detailsExpanded) {
          event.preventDefault()
          onDetailsChange?.(true)
          const input = event.target
          requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.reportValidity() } })
        }
      }}>
      {request.requestedSchema?.title || request.origin === 'subagent' || acceptedUrl ? <header><strong>{title}</strong>{request.origin === 'subagent' ? <span>{copy.subagent}</span> : null}</header> : null}
      <div className="code-acp-elicitation-heading">
        {onLater ? <QuestionGlyph /> : null}
        <p className="code-acp-elicitation-message">{request.message}</p>
        {deferred.length > 0 ? <button type="button" className="code-acp-questions-toggle"
          aria-label={copy.questionDetails} title={copy.questionDetails} aria-expanded={Boolean(draft?.detailsExpanded)}
          aria-controls={`${request.requestId}-details`} onClick={() => onDetailsChange?.(!draft?.detailsExpanded)}><PencilGlyph /></button> : null}
        {!acceptedUrl ? <button type="button" className="code-acp-questions-toggle" disabled={disabled}
          onClick={() => onRespond(request.requestId, 'decline')}>{copy.questionSkip}</button> : null}
        {onLater ? <button type="button" className="code-acp-questions-toggle" disabled={draft?.status === 'submitting'} onClick={onLater}>{copy.questionLater}</button> : null}
      </div>
      {request.requestedSchema?.description ? <small>{request.requestedSchema.description}</small> : null}
      {draft?.error ? <small className="code-acp-elicitation-error" role="alert">{draft.error}</small> : null}
      {validationError ? <small className="code-acp-elicitation-error" role="alert">{validationError}</small> : null}
      <div className="code-acp-elicitation-answer">
        {request.mode === 'url' ? (
          safeUrl ? (
            <a className="code-acp-elicitation-link" href={safeUrl} target="_blank" rel="noreferrer">Open secure link</a>
          ) : <small role="alert">The Agent provided an unsupported link.</small>
        ) : (
          <fieldset className="code-acp-request-questions code-acp-elicitation-fields" disabled={disabled}>
            {primary.map(renderField)}
          </fieldset>
        )}
        {acceptedUrl ? <small className="code-acp-elicitation-waiting">Waiting for the Agent to confirm completion…</small> : (
          <div className="code-acp-request-actions">
            <button type="submit" className="approve" disabled={disabled || (request.mode === 'url' && !safeUrl)}>
              {draft?.status === 'submitting' ? copy.questionSubmitting : request.mode === 'url' ? 'Continue' : copy.questionSubmit}
            </button>
            {request.mode === 'url' ? <button type="button" disabled={disabled} onClick={() => onRespond(request.requestId, 'cancel')}>{copy.cancel}</button> : null}
          </div>
        )}
      </div>
      {deferred.length > 0 ? <fieldset id={`${request.requestId}-details`} className="code-acp-request-questions code-acp-elicitation-fields code-acp-elicitation-details"
        disabled={disabled} hidden={!draft?.detailsExpanded}>{deferred.map(renderField)}</fieldset> : null}
    </form>
  )
}
