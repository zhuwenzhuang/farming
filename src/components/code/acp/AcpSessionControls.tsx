import type { AcpSessionConfigOption, AcpSessionConfigSelect, AcpSessionSnapshot } from './types'

function selectOptions(option: AcpSessionConfigSelect) {
  return option.options.flatMap(candidate => (
    'options' in candidate ? candidate.options : [candidate]
  ))
}

function usageLabel(session: AcpSessionSnapshot) {
  const total = session.usage?.totalTokens
  if (!Number.isFinite(total)) return ''
  return `${Math.round(Number(total) / 1000)}k tokens`
}

function AcpConfigControl({
  option,
  disabled,
  onChange,
}: {
  option: AcpSessionConfigOption
  disabled: boolean
  onChange: (value: string | boolean) => void
}) {
  if (option.type === 'boolean') {
    return (
      <button
        type="button"
        className={`code-acp-config-toggle ${option.currentValue ? 'active' : ''}`}
        data-testid={`code-acp-config-${option.id}`}
        aria-pressed={option.currentValue}
        title={option.description || option.name}
        disabled={disabled}
        onClick={() => onChange(!option.currentValue)}
      >
        {option.name}
      </button>
    )
  }

  return (
    <label className="code-acp-config-select" title={option.description || option.name}>
      <span>{option.name}</span>
      <select
        data-testid={`code-acp-config-${option.id}`}
        aria-label={option.name}
        value={option.currentValue}
        disabled={disabled}
        onChange={event => onChange(event.currentTarget.value)}
      >
        {selectOptions(option).map(candidate => (
          <option key={candidate.value} value={candidate.value}>{candidate.name}</option>
        ))}
      </select>
    </label>
  )
}

export function AcpSessionControls({
  session,
  updatingId,
  onSetMode,
  onSetConfigOption,
}: {
  session: AcpSessionSnapshot
  updatingId: string
  onSetMode: (modeId: string) => void
  onSetConfigOption: (configId: string, value: string | boolean) => void
}) {
  const modes = session.modes?.availableModes || []
  const currentModeId = session.currentModeId || session.modes?.currentModeId || ''
  const usage = usageLabel(session)
  const configOptions = session.configOptions.filter(option => (
    modes.length === 0 || (option.category !== 'mode' && option.id !== 'mode')
  ))

  return (
    <div className="code-acp-session-controls" data-testid="code-acp-session-controls">
      {modes.length > 0 ? (
        <label className="code-acp-config-select" title={modes.find(mode => mode.id === currentModeId)?.description || 'Agent mode'}>
          <span>Mode</span>
          <select
            data-testid="code-acp-mode"
            aria-label="Agent mode"
            value={currentModeId}
            disabled={Boolean(updatingId)}
            onChange={event => onSetMode(event.currentTarget.value)}
          >
            {modes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
          </select>
        </label>
      ) : null}
      {configOptions.map(option => (
        <AcpConfigControl
          key={option.id}
          option={option}
          disabled={Boolean(updatingId)}
          onChange={value => onSetConfigOption(option.id, value)}
        />
      ))}
      {usage ? <span className="code-acp-usage" title="ACP session token usage">{usage}</span> : null}
    </div>
  )
}
