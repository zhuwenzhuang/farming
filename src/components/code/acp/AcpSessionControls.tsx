import { CheckGlyph, ChevronDownGlyph, ChevronRightGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../copy'
import type {
  AcpSessionConfigBoolean,
  AcpSessionConfigOption,
  AcpSessionConfigSelect,
  AcpSessionConfigSelectOption,
  AcpSessionSnapshot,
} from './types'

export type AcpComposerMenu = 'commands' | 'mode' | 'model' | null

function selectOptions(option: AcpSessionConfigSelect) {
  return option.options.flatMap(candidate => (
    'options' in candidate ? candidate.options : [candidate]
  ))
}

function optionMatches(option: AcpSessionConfigOption, pattern: RegExp) {
  return pattern.test(`${option.id} ${option.name} ${option.category || ''}`)
}

function findSelectOption(session: AcpSessionSnapshot, pattern: RegExp) {
  return session.configOptions.find((option): option is AcpSessionConfigSelect => (
    option.type === 'select' && optionMatches(option, pattern)
  ))
}

function findBooleanOption(session: AcpSessionSnapshot, pattern: RegExp) {
  return session.configOptions.find((option): option is AcpSessionConfigBoolean => (
    option.type === 'boolean' && optionMatches(option, pattern)
  ))
}

function currentSelectOption(option: AcpSessionConfigSelect | undefined) {
  return option ? selectOptions(option).find(candidate => candidate.value === option.currentValue) : undefined
}

function compactModelLabel(label: string) {
  const compact = label.trim().replace(/^gpt[-\s]*/i, '')
  return compact || label
}

function ModeIcon() {
  return (
    <svg className="filled" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.6 1.2h2.8l.38 1.55c.36.13.7.32 1.01.56l1.51-.48 1.4 2.42-1.14 1.08c.03.22.04.44.04.67s-.01.45-.04.67l1.14 1.08-1.4 2.42-1.51-.48c-.31.24-.65.43-1.01.56L9.4 12.8H6.6l-.38-1.55a5.1 5.1 0 0 1-1.01-.56l-1.51.48-1.4-2.42 1.14-1.08A5 5 0 0 1 3.4 7c0-.23.01-.45.04-.67L2.3 5.25l1.4-2.42 1.51.48c.31-.24.65-.43 1.01-.56L6.6 1.2Zm1.4 3.3A2.5 2.5 0 1 0 8 9.5a2.5 2.5 0 0 0 0-5Z" />
    </svg>
  )
}

function SpeedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.85 1.35a.55.55 0 0 1 .55.68L8.28 6.1h3.07a.55.55 0 0 1 .42.9l-5.5 6.6a.55.55 0 0 1-.96-.48l1.12-4.2H3.65a.55.55 0 0 1-.44-.88l5.2-6.48a.55.55 0 0 1 .44-.21Z" />
    </svg>
  )
}

function SelectOptions({
  option,
  currentValue,
  label,
  onSelect,
}: {
  option: AcpSessionConfigSelect
  currentValue: string
  label: (candidate: AcpSessionConfigSelectOption) => string
  onSelect: (value: string) => void
}) {
  return selectOptions(option).map(candidate => (
    <button
      key={candidate.value}
      type="button"
      className={`code-model-option ${candidate.value === currentValue ? 'selected' : ''}`}
      role="menuitemradio"
      aria-checked={candidate.value === currentValue}
      onClick={() => onSelect(candidate.value)}
    >
      <span className="code-model-option-copy">
        <span>{label(candidate)}</span>
      </span>
      {candidate.value === currentValue ? <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span> : null}
    </button>
  ))
}

export function AcpModeControl({
  session,
  updatingId,
  open,
  onToggle,
  onSetMode,
}: {
  session: AcpSessionSnapshot
  updatingId: string
  open: boolean
  onToggle: () => void
  onSetMode: (modeId: string) => void
}) {
  const modes = session.modes?.availableModes || []
  if (modes.length === 0) return null
  const currentModeId = session.currentModeId || session.modes?.currentModeId || ''
  const currentMode = modes.find(mode => mode.id === currentModeId) || modes[0]

  return (
    <div className="code-composer-menu-anchor">
      <button
        type="button"
        className="code-composer-approval muted"
        data-testid="code-acp-mode"
        data-acp-value={currentModeId}
        aria-label="Agent mode"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={Boolean(updatingId)}
        onClick={onToggle}
      >
        <span className="code-tool-icon" aria-hidden="true"><ModeIcon /></span>
        <span className="code-composer-approval-label">{currentMode?.name || currentModeId}</span>
        <span className="code-chevron" aria-hidden="true"><ChevronDownGlyph /></span>
      </button>
      {open ? (
        <div className="code-approval-menu code-composer-menu" role="menu" data-testid="code-acp-mode-menu">
          <div className="code-approval-menu-header">
            <span>Mode</span>
            {currentMode?.description ? <small>{currentMode.description}</small> : null}
          </div>
          {modes.map(mode => (
            <button
              key={mode.id}
              type="button"
              className={`code-approval-option ${mode.id === currentModeId ? 'selected' : ''}`}
              role="menuitemradio"
              aria-checked={mode.id === currentModeId}
              onClick={() => onSetMode(mode.id)}
            >
              <span className="code-approval-option-icon muted" aria-hidden="true"><ModeIcon /></span>
              <span className="code-approval-option-copy">
                <span>{mode.name}</span>
                {mode.description ? <small>{mode.description}</small> : null}
              </span>
              {mode.id === currentModeId ? <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AcpModelControl({
  session,
  updatingId,
  copy,
  open,
  pane,
  onToggle,
  onSetPane,
  onSetConfigOption,
}: {
  session: AcpSessionSnapshot
  updatingId: string
  copy: CodeCopy
  open: boolean
  pane: 'model' | 'speed' | null
  onToggle: () => void
  onSetPane: (pane: 'model' | 'speed' | null) => void
  onSetConfigOption: (configId: string, value: string | boolean) => void
}) {
  const model = findSelectOption(session, /(^|[\s_-])model([\s_-]|$)/i)
  const reasoning = findSelectOption(session, /(reasoning|thought)/i)
  const fastMode = findBooleanOption(session, /(fast|speed)/i)
  const extraOptions = session.configOptions.filter(option => (
    option !== model
    && option !== reasoning
    && option !== fastMode
    && option.category !== 'mode'
    && option.id !== 'mode'
  ))
  const currentModel = currentSelectOption(model)
  const currentReasoning = currentSelectOption(reasoning)
  if (!model && !reasoning && !fastMode && extraOptions.length === 0) return null
  const disabled = Boolean(updatingId)

  return (
    <div className="code-composer-menu-anchor model-picker">
      <button
        type="button"
        className="code-composer-model-picker"
        data-testid="code-acp-model-picker"
        data-agent-model-preset={`${model?.currentValue || ''}:${reasoning?.currentValue || ''}`}
        aria-label={copy.modelAndReasoning}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={[currentModel?.name, currentReasoning?.name, fastMode?.currentValue ? fastMode.name : ''].filter(Boolean).join(' · ')}
        onClick={onToggle}
      >
        {fastMode?.currentValue ? <span className="code-composer-speed-active" aria-hidden="true"><SpeedIcon /></span> : null}
        <span className="code-composer-model-label desktop">{compactModelLabel(currentModel?.name || model?.currentValue || 'Model')}</span>
        <span className="code-composer-model-label mobile">{compactModelLabel(currentModel?.name || model?.currentValue || 'Model')}</span>
        {currentReasoning ? <span className="code-composer-model-picker-muted desktop">{currentReasoning.name}</span> : null}
        {currentReasoning ? <span className="code-composer-model-picker-muted mobile">{currentReasoning.name}</span> : null}
        <span className="code-chevron" aria-hidden="true"><ChevronDownGlyph /></span>
      </button>
      {open ? (
        <div className="code-model-picker-menu code-composer-menu" role="menu" data-testid="code-acp-model-menu">
          {reasoning ? (
            <>
              <div className="code-model-menu-header">{copy.reasoning}</div>
              <SelectOptions
                option={reasoning}
                currentValue={reasoning.currentValue}
                label={candidate => copy.reasoningOptionLabel(candidate.value, candidate.name)}
                onSelect={value => onSetConfigOption(reasoning.id, value)}
              />
              <div className="code-context-menu-separator" role="separator" />
            </>
          ) : null}
          {model ? (
            <div className="code-model-nested-anchor">
              <button
                type="button"
                className={`code-model-nested-trigger ${pane === 'model' ? 'selected' : ''}`}
                role="menuitem"
                data-testid="code-acp-model-submenu-trigger"
                onClick={() => onSetPane(pane === 'model' ? null : 'model')}
              >
                <span>{currentModel?.name || model.currentValue}</span>
                <ChevronRightGlyph className="code-menu-chevron-right" />
              </button>
              {pane === 'model' ? (
                <div className="code-model-submenu code-composer-menu" role="menu" data-testid="code-acp-model-submenu">
                  <SelectOptions
                    option={model}
                    currentValue={model.currentValue}
                    label={candidate => candidate.name}
                    onSelect={value => onSetConfigOption(model.id, value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {fastMode ? (
            <div className="code-model-nested-anchor">
              <button
                type="button"
                className={`code-model-nested-trigger ${pane === 'speed' ? 'selected' : ''}`}
                role="menuitem"
                data-testid="code-acp-speed-submenu-trigger"
                onClick={() => onSetPane(pane === 'speed' ? null : 'speed')}
              >
                <span>{copy.speed}</span>
                <ChevronRightGlyph className="code-menu-chevron-right" />
              </button>
              {pane === 'speed' ? (
                <div className="code-speed-submenu code-composer-menu" role="menu" data-testid="code-acp-speed-submenu">
                  {[false, true].map(value => (
                    <button
                      key={String(value)}
                      type="button"
                      className={`code-model-option ${fastMode.currentValue === value ? 'selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={fastMode.currentValue === value}
                      onClick={() => onSetConfigOption(fastMode.id, value)}
                    >
                      <span className="code-model-option-copy">
                        <span className="code-speed-option-label">
                          {value ? <span className="code-speed-option-icon" aria-hidden="true"><SpeedIcon /></span> : null}
                          <span>{value ? fastMode.name : copy.serviceTierLabel('default', 'Standard')}</span>
                        </span>
                        <small>{value ? (fastMode.description || copy.serviceTierDescription('priority', '')) : copy.serviceTierDescription('default', '')}</small>
                      </span>
                      {fastMode.currentValue === value ? <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {extraOptions.map(option => option.type === 'select' ? (
            <div key={option.id}>
              <div className="code-context-menu-separator" role="separator" />
              <div className="code-model-menu-header">{option.name}</div>
              <SelectOptions
                option={option}
                currentValue={option.currentValue}
                label={candidate => candidate.name}
                onSelect={value => onSetConfigOption(option.id, value)}
              />
            </div>
          ) : (
            <button
              key={option.id}
              type="button"
              className={`code-model-option ${option.currentValue ? 'selected' : ''}`}
              role="menuitemcheckbox"
              aria-checked={option.currentValue}
              onClick={() => onSetConfigOption(option.id, !option.currentValue)}
            >
              <span className="code-model-option-copy">
                <span>{option.name}</span>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {option.currentValue ? <span className="code-menu-check" aria-hidden="true"><CheckGlyph /></span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
