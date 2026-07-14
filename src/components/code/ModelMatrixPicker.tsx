import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { ChevronDownGlyph } from '@/components/IconGlyphs'

export interface ModelMatrixReasoningOption {
  value: string
  label: string
}

export interface ModelMatrixModelOption {
  value: string
  label: string
  reasoning: ModelMatrixReasoningOption[]
}

interface MatrixFamilyModel extends ModelMatrixModelOption {
  variant: 'sol' | 'terra' | 'luna'
}

interface MatrixSelection {
  row: number
  column: number
  x?: number
  y?: number
}

interface MatrixPointerGesture {
  pointerId: number
  startX: number
  startY: number
  dragged: boolean
}

const VARIANT_ORDER = ['sol', 'terra', 'luna'] as const
const MATRIX_DRAG_THRESHOLD = 4
const MATRIX_STAGE_TRANSITION_MS = 240

export function modelMatrixFamily(models: ModelMatrixModelOption[], currentModel: string) {
  const currentMatch = currentModel.match(/^(.*?)[-\s](sol|terra|luna)$/i)
  const family = currentMatch?.[1]?.toLowerCase()
  if (!family) return null
  const familyModels = models.flatMap(model => {
    const match = model.value.match(/^(.*?)[-\s](sol|terra|luna)$/i)
    const modelFamily = match?.[1]?.toLowerCase()
    const variant = match?.[2]?.toLowerCase()
    if (!modelFamily || modelFamily !== family || !variant) return []
    return [{ ...model, variant: variant as MatrixFamilyModel['variant'] }]
  }).sort((left, right) => VARIANT_ORDER.indexOf(left.variant) - VARIANT_ORDER.indexOf(right.variant))
  return familyModels.length >= 2 ? familyModels : null
}

function SpeedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.85 1.35a.55.55 0 0 1 .55.68L8.28 6.1h3.07a.55.55 0 0 1 .42.9l-5.5 6.6a.55.55 0 0 1-.96-.48l1.12-4.2H3.65a.55.55 0 0 1-.44-.88l5.2-6.48a.55.55 0 0 1 .44-.21Z" />
    </svg>
  )
}

function MatrixRocker({
  label,
  active,
  disabled,
  unavailable,
  onChange,
}: {
  label: string
  active: boolean
  disabled?: boolean
  unavailable?: boolean
  onChange: (active: boolean) => void
}) {
  const [kicking, setKicking] = useState(false)
  const kickTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (kickTimerRef.current !== null) window.clearTimeout(kickTimerRef.current)
  }, [])

  function startLandingKick() {
    if (kickTimerRef.current !== null) window.clearTimeout(kickTimerRef.current)
    setKicking(true)
    // Reduced-motion disables the CSS animation, so keep a timeout fallback
    // that always clears the transient impact class.
    kickTimerRef.current = window.setTimeout(() => {
      kickTimerRef.current = null
      setKicking(false)
    }, 650)
  }

  function finishLandingKick() {
    if (kickTimerRef.current !== null) window.clearTimeout(kickTimerRef.current)
    kickTimerRef.current = null
    setKicking(false)
  }

  return (
    <div className={`code-model-matrix-rocker is-ultra ${active ? 'is-active' : ''} ${unavailable ? 'is-disabled' : ''}`}>
      <span>{label}</span>
      <button
        type="button"
        className="code-model-matrix-rocker-button"
        disabled={disabled || unavailable}
        aria-label="Ultra reasoning"
        aria-pressed={active}
        onClick={() => {
          if (!active) startLandingKick()
          onChange(!active)
        }}
      >
        <span className={`code-model-matrix-rocker-control ${kicking ? 'is-kicked' : ''}`} aria-hidden="true">
          <span className="code-model-matrix-rocker-slot">
            <span className="code-model-matrix-rocker-energy" />
          </span>
          <span className="code-model-matrix-rocker-knob-position">
            <span
              className={`code-model-matrix-rocker-knob ${kicking ? 'is-kicked' : ''}`}
              onAnimationEnd={finishLandingKick}
            />
          </span>
        </span>
      </button>
    </div>
  )
}

function FastBoost({
  active,
  available,
  disabled,
  onChange,
}: {
  active: boolean
  available: boolean
  disabled?: boolean
  onChange: (active: boolean) => void
}) {
  const [kicking, setKicking] = useState(false)
  const unavailable = !available
  const interactionDisabled = disabled || unavailable
  return (
    <button
      type="button"
      className={`code-model-matrix-fast ${active ? 'is-active' : ''} ${unavailable ? 'is-disabled' : ''}`}
      aria-label="Fast mode"
      aria-pressed={active}
      aria-disabled={interactionDisabled}
      disabled={interactionDisabled}
      onClick={() => {
        setKicking(true)
        onChange(!active)
      }}
    >
      <span
        className={`code-model-matrix-fast-bolt ${kicking ? 'is-kicked' : ''}`}
        aria-hidden="true"
        onAnimationEnd={() => setKicking(false)}
      >
        <SpeedIcon />
      </span>
      <span>Fast</span>
      <small>{available ? (active ? 'ON' : 'OFF') : '—'}</small>
    </button>
  )
}

export function ModelMatrixPicker({
  models,
  currentModel,
  currentReasoning,
  fastAvailable,
  fast,
  disabled,
  onSelect,
  onFastChange,
  advanced,
}: {
  models: ModelMatrixModelOption[]
  currentModel: string
  currentReasoning: string
  fastAvailable: boolean
  fast: boolean
  disabled?: boolean
  onSelect: (model: string, reasoning: string) => void
  onFastChange: (fast: boolean) => void
  advanced: ReactNode
}) {
  const family = modelMatrixFamily(models, currentModel)
  const matrixSupportsCurrent = Boolean(
    family?.find(model => model.value === currentModel)?.reasoning.some(option => option.value === currentReasoning)
  )
  const [advancedOpen, setAdvancedOpen] = useState(!matrixSupportsCurrent)
  const [dragSelection, setDragSelection] = useState<MatrixSelection | null>(null)
  const [pendingProfile, setPendingProfile] = useState<{ model: string; reasoning: string } | null>(null)
  const [pendingFast, setPendingFast] = useState<boolean | null>(null)
  const familyAvailableRef = useRef(Boolean(family))
  const lastStandardReasoningRef = useRef(new Map<string, string>())
  const pointerGestureRef = useRef<MatrixPointerGesture | null>(null)
  const queuedDragSelectionRef = useRef<MatrixSelection | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const matrixStageRef = useRef<HTMLDivElement | null>(null)
  const matrixPanelRef = useRef<HTMLDivElement | null>(null)
  const advancedPanelRef = useRef<HTMLDivElement | null>(null)
  const previousStageHeightRef = useRef<number | null>(null)
  const stageAnimationFrameRef = useRef<number | null>(null)
  const stageAnimationTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const becameAvailable = !familyAvailableRef.current && Boolean(family)
    familyAvailableRef.current = Boolean(family)
    if (becameAvailable && matrixSupportsCurrent) {
      previousStageHeightRef.current = matrixStageRef.current?.getBoundingClientRect().height ?? null
      setAdvancedOpen(false)
    }
  }, [family, matrixSupportsCurrent])

  useEffect(() => {
    if (!pendingProfile) return undefined
    if (currentModel === pendingProfile.model && currentReasoning === pendingProfile.reasoning) {
      setPendingProfile(null)
      return undefined
    }
    const timeout = window.setTimeout(() => setPendingProfile(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [currentModel, currentReasoning, pendingProfile])

  useEffect(() => {
    if (pendingFast === null) return undefined
    if (!fastAvailable || fast === pendingFast) {
      setPendingFast(null)
      return undefined
    }
    const timeout = window.setTimeout(() => setPendingFast(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [fast, fastAvailable, pendingFast])

  useEffect(() => () => {
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current)
    if (stageAnimationFrameRef.current !== null) window.cancelAnimationFrame(stageAnimationFrameRef.current)
    if (stageAnimationTimerRef.current !== null) window.clearTimeout(stageAnimationTimerRef.current)
  }, [])

  useLayoutEffect(() => {
    const stage = matrixStageRef.current
    const activePanel = advancedOpen ? advancedPanelRef.current : matrixPanelRef.current
    const fromHeight = previousStageHeightRef.current
    previousStageHeightRef.current = null
    if (!stage || !activePanel) return

    if (stageAnimationFrameRef.current !== null) window.cancelAnimationFrame(stageAnimationFrameRef.current)
    if (stageAnimationTimerRef.current !== null) window.clearTimeout(stageAnimationTimerRef.current)
    stageAnimationFrameRef.current = null
    stageAnimationTimerRef.current = null

    const toHeight = activePanel.getBoundingClientRect().height
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (fromHeight === null || reducedMotion || Math.abs(fromHeight - toHeight) < 1) {
      stage.style.height = `${toHeight}px`
      stage.style.overflow = advancedOpen ? 'visible' : 'hidden'
      return
    }

    stage.style.height = `${fromHeight}px`
    stage.style.overflow = 'hidden'
    // Force the captured height to become the transition's starting frame.
    void stage.offsetHeight
    stageAnimationFrameRef.current = window.requestAnimationFrame(() => {
      stage.style.height = `${toHeight}px`
      stageAnimationFrameRef.current = null
    })
    stageAnimationTimerRef.current = window.setTimeout(() => {
      stage.style.height = `${toHeight}px`
      stage.style.overflow = advancedOpen ? 'visible' : 'hidden'
      stageAnimationTimerRef.current = null
    }, MATRIX_STAGE_TRANSITION_MS + 40)
  }, [advancedOpen])

  if (!family) return advanced

  const current = family.find(model => model.value === currentModel) ?? family[0]!
  const reasoning = current.reasoning.filter(option => option.value !== 'ultra')
  if (currentReasoning !== 'ultra' && reasoning.some(option => option.value === currentReasoning)) {
    lastStandardReasoningRef.current.set(current.value, currentReasoning)
  }
  const baseReasoning = lastStandardReasoningRef.current.get(current.value)
    || reasoning[reasoning.length - 1]?.value
    || currentReasoning
  const effectiveReasoning = currentReasoning === 'ultra' ? baseReasoning : currentReasoning
  const currentReasoningIndex = Math.max(0, reasoning.findIndex(option => option.value === effectiveReasoning))
  const currentReasoningLabel = current.reasoning.find(option => option.value === currentReasoning)?.label || currentReasoning

  function selectCell(model: MatrixFamilyModel, effort: string) {
    if (disabled) return
    setPendingProfile({ model: model.value, reasoning: effort })
    lastStandardReasoningRef.current.set(model.value, effort)
    onSelect(model.value, effort)
  }

  const matrixRows = family.map(model => ({
    model,
    reasoning: model.reasoning.filter(option => option.value !== 'ultra'),
  }))
  const selectedRow = Math.max(0, matrixRows.findIndex(row => row.model.value === currentModel))
  const selectedColumn = Math.max(0, matrixRows[selectedRow]?.reasoning.findIndex(option => option.value === effectiveReasoning) ?? 0)
  const pendingRow = pendingProfile ? matrixRows.findIndex(row => row.model.value === pendingProfile.model) : -1
  const pendingColumn = pendingRow >= 0
    ? matrixRows[pendingRow]?.reasoning.findIndex(option => option.value === pendingProfile?.reasoning) ?? -1
    : -1
  const pendingSelection: MatrixSelection | null = pendingRow >= 0 && pendingColumn >= 0
    ? { row: pendingRow, column: pendingColumn }
    : null
  const visibleSelection: MatrixSelection = dragSelection ?? pendingSelection ?? { row: selectedRow, column: selectedColumn }
  const visibleRow = matrixRows[visibleSelection.row] ?? matrixRows[0]!
  const visibleColumn = Math.min(visibleSelection.column, Math.max(0, visibleRow.reasoning.length - 1))
  const visibleReasoning = visibleRow.reasoning[visibleColumn]
  const controlModel = pendingProfile
    ? family.find(model => model.value === pendingProfile.model) ?? current
    : current
  const controlReasoning = pendingProfile?.reasoning ?? currentReasoning
  const controlStandardReasoning = controlModel.reasoning.filter(option => option.value !== 'ultra')
  const ultraOption = controlModel.reasoning.find(option => option.value === 'ultra')
  const controlBaseReasoning = lastStandardReasoningRef.current.get(controlModel.value)
    || controlStandardReasoning[controlStandardReasoning.length - 1]?.value
    || controlReasoning
  const controlReasoningLabel = controlModel.reasoning.find(option => option.value === controlReasoning)?.label
    || controlReasoning
  const ultraActive = Boolean(ultraOption) && controlReasoning === 'ultra'
  const visibleFast = pendingFast ?? fast
  const selectionX = `${(
    typeof visibleSelection.x === 'number'
      ? visibleSelection.x
      : (visibleColumn + .5) / Math.max(1, visibleRow.reasoning.length)
  ) * 100}%`
  const selectionYValue = typeof visibleSelection.y === 'number'
    ? visibleSelection.y
    : (visibleSelection.row + .5) / Math.max(1, matrixRows.length)
  const selectionY = `${selectionYValue * 100}%`
  const selectionRowTop = `${Math.max(0, Math.min(
    1 - (1 / Math.max(1, matrixRows.length)),
    selectionYValue - (.5 / Math.max(1, matrixRows.length))
  )) * 100}%`
  const selectionRowHeight = `${100 / Math.max(1, matrixRows.length)}%`

  function selectionFromPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const rawX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)))
    const rawY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)))
    const row = Math.max(0, Math.min(matrixRows.length - 1, Math.floor(
      rawY * matrixRows.length
    )))
    const columns = matrixRows[row]?.reasoning.length || 1
    const column = Math.max(0, Math.min(columns - 1, Math.floor(
      rawX * columns
    )))
    return {
      row,
      column,
      x: Math.max(.5 / columns, Math.min(1 - (.5 / columns), rawX)),
      y: Math.max(.5 / matrixRows.length, Math.min(1 - (.5 / matrixRows.length), rawY)),
    }
  }

  function commitSelection(selection: MatrixSelection) {
    const row = matrixRows[selection.row]
    const option = row?.reasoning[selection.column]
    if (row && option) selectCell(row.model, option.value)
  }

  function changeFast(value: boolean) {
    if (disabled || !fastAvailable || visibleFast === value) return
    setPendingFast(value)
    onFastChange(value)
  }

  function changeUltra(value: boolean) {
    if (disabled || !ultraOption || ultraActive === value) return
    const reasoningValue = value ? ultraOption.value : controlBaseReasoning
    setPendingProfile({ model: controlModel.value, reasoning: reasoningValue })
    if (!value) lastStandardReasoningRef.current.set(controlModel.value, reasoningValue)
    onSelect(controlModel.value, reasoningValue)
  }

  function queueDragSelection(selection: MatrixSelection) {
    queuedDragSelectionRef.current = selection
    if (dragFrameRef.current !== null) return
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null
      const nextSelection = queuedDragSelectionRef.current
      queuedDragSelectionRef.current = null
      if (nextSelection) setDragSelection(nextSelection)
    })
  }

  function clearQueuedDragSelection() {
    queuedDragSelectionRef.current = null
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
  }

  function finishPointerGesture(event: PointerEvent<HTMLDivElement>, commit = true) {
    const gesture = pointerGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const selection = selectionFromPointer(event)
    pointerGestureRef.current = null
    clearQueuedDragSelection()
    if (commit) commitSelection(selection)
    setDragSelection(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function toggleAdvanced() {
    previousStageHeightRef.current = matrixStageRef.current?.getBoundingClientRect().height ?? null
    setAdvancedOpen(value => !value)
  }

  return (
    <div
      className={`code-model-matrix-shell is-${visibleRow.model.variant}`}
      data-testid="code-model-matrix-picker"
      data-advanced={advancedOpen ? 'open' : 'closed'}
      data-fast={visibleFast ? 'on' : 'off'}
      data-ultra={ultraActive ? 'on' : 'off'}
    >
      <div className="code-model-matrix-stage" ref={matrixStageRef}>
        <div
          ref={matrixPanelRef}
          className="code-model-matrix"
          aria-hidden={advancedOpen}
          inert={advancedOpen ? true : undefined}
        >
            <div
              className="code-model-matrix-head"
              style={{ '--matrix-columns': visibleRow.reasoning.length } as CSSProperties}
              aria-hidden="true"
            >
              {visibleRow.reasoning.map(option => <span key={option.value}>{option.label}</span>)}
            </div>
            <div className="code-model-matrix-labels" aria-hidden="true">
              {matrixRows.map(({ model }) => (
                <span key={model.value} className={model.value === visibleRow.model.value ? 'selected' : ''} data-variant={model.variant}>
                  {model.variant.charAt(0).toUpperCase() + model.variant.slice(1)}
                </span>
              ))}
            </div>
            <div
              className={`code-model-matrix-surface ${dragSelection ? 'is-dragging' : ''}`}
              role="radiogroup"
              aria-label="Model and reasoning"
              style={{
                '--matrix-columns': reasoning.length,
                '--matrix-rows': matrixRows.length,
                '--matrix-selection-x': selectionX,
                '--matrix-selection-y': selectionY,
                '--matrix-selection-row-top': selectionRowTop,
                '--matrix-selection-row-height': selectionRowHeight,
              } as CSSProperties}
              onPointerDown={event => {
                if (disabled) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                pointerGestureRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  dragged: false,
                }
              }}
              onPointerMove={event => {
                const gesture = pointerGestureRef.current
                if (!gesture || gesture.pointerId !== event.pointerId) return
                if (event.pointerType === 'mouse' && event.buttons === 0) {
                  finishPointerGesture(event)
                  return
                }
                const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY)
                if (!gesture.dragged && distance >= MATRIX_DRAG_THRESHOLD) gesture.dragged = true
                if (gesture.dragged) queueDragSelection(selectionFromPointer(event))
              }}
              onPointerUp={event => finishPointerGesture(event)}
              onPointerCancel={event => finishPointerGesture(event, false)}
              onLostPointerCapture={event => {
                if (pointerGestureRef.current?.pointerId !== event.pointerId) return
                pointerGestureRef.current = null
                clearQueuedDragSelection()
                setDragSelection(null)
              }}
            >
              <span className="code-model-matrix-fill" data-variant={visibleRow.model.variant} aria-hidden="true" />
              <div className="code-model-matrix-cells">
                {matrixRows.flatMap(({ model, reasoning: rowReasoning }, row) => rowReasoning.map((option, column) => {
                  const selected = row === visibleSelection.row && column === visibleColumn
                  return (
                    <button
                      key={`${model.value}:${option.value}`}
                      type="button"
                      className={selected ? 'selected' : ''}
                      role="radio"
                      data-matrix-cell
                      data-testid={`code-model-matrix-cell-${model.variant}-${option.value}`}
                      aria-label={`${model.label}, ${option.label}`}
                      aria-checked={selected}
                      disabled={disabled}
                      style={{
                        '--matrix-cell-left': `${(column / Math.max(1, rowReasoning.length)) * 100}%`,
                        '--matrix-cell-top': `${(row / Math.max(1, matrixRows.length)) * 100}%`,
                        '--matrix-cell-width': `${100 / Math.max(1, rowReasoning.length)}%`,
                        '--matrix-cell-height': `${100 / Math.max(1, matrixRows.length)}%`,
                      } as CSSProperties}
                      onClick={event => {
                        if (event.detail === 0) selectCell(model, option.value)
                      }}
                    />
                  )
                }))}
              </div>
              <span className="code-model-matrix-thumb" data-variant={visibleRow.model.variant} aria-hidden="true" />
            </div>
            <div className="code-model-matrix-rockers">
              <MatrixRocker
                label={ultraOption?.label || 'Ultra'}
                active={ultraActive}
                disabled={disabled}
                unavailable={!ultraOption}
                onChange={changeUltra}
              />
            </div>
            <FastBoost
              active={fastAvailable && visibleFast}
              available={fastAvailable}
              disabled={disabled}
              onChange={changeFast}
            />
            <span className="code-model-matrix-current" aria-live="polite">
              {dragSelection
                ? `${visibleRow.model.label} · ${visibleReasoning?.label || ''}`
                : pendingProfile
                  ? `${controlModel.label} · ${controlReasoningLabel}`
                : `${current.label} · ${currentReasoningLabel || reasoning[currentReasoningIndex]?.label}`}
            </span>
        </div>
        <div
          ref={advancedPanelRef}
          className="code-model-matrix-advanced"
          data-testid="code-model-matrix-advanced"
          aria-hidden={!advancedOpen}
          inert={advancedOpen ? undefined : true}
        >
          {advanced}
        </div>
      </div>
      <button
        type="button"
        className="code-model-matrix-advanced-toggle"
        data-testid="code-model-matrix-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={toggleAdvanced}
      >
        <span>Advanced</span>
        <ChevronDownGlyph className={advancedOpen ? 'expanded' : ''} />
      </button>
    </div>
  )
}
