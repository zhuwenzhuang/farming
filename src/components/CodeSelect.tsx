import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { CheckGlyph, ChevronDownGlyph } from '@/components/IconGlyphs'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import './CodeSelect.css'

export type CodeSelectOption = {
  value: string
  label: string
  disabled?: boolean
}

interface CodeSelectProps {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  density?: 'field' | 'toolbar'
  label?: ReactNode
  menuClassName?: string
  options: CodeSelectOption[]
  required?: boolean
  testId?: string
  triggerClassName?: string
  value: string
  onChange: (value: string) => void
}

export function CodeSelect({
  ariaLabel,
  className = '',
  disabled = false,
  density = 'field',
  label,
  menuClassName = '',
  options,
  required = false,
  testId,
  triggerClassName = '',
  value,
  onChange,
}: CodeSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const focusTargetRef = useRef<'selected' | 'first' | 'last'>('selected')
  const id = useId()
  const labelId = `${id}-label`
  const menuId = `${id}-menu`
  const selected = options.find(option => option.value === value) || options[0]

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  const openMenu = useCallback((focusTarget: 'selected' | 'first' | 'last' = 'selected') => {
    if (disabled || options.length === 0) return
    focusTargetRef.current = focusTarget
    setOpen(true)
  }, [disabled, options.length])

  useInteractionLayer({
    enabled: open,
    elements: () => [rootRef.current],
    onDismiss: () => close(),
    returnFocus: () => triggerRef.current,
  })

  useLayoutEffect(() => {
    if (!open) return
    const optionButtons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])]
    const focusTarget = focusTargetRef.current === 'first'
      ? optionButtons[0]
      : focusTargetRef.current === 'last'
        ? optionButtons[optionButtons.length - 1]
        : optionButtons.find(option => option.getAttribute('aria-selected') === 'true') || optionButtons[0]
    focusTarget?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (disabled || options.length === 0) setOpen(false)
  }, [disabled, options.length])

  const moveOptionFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const optionButtons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])]
    if (optionButtons.length === 0) return
    event.preventDefault()
    const currentIndex = optionButtons.indexOf(event.currentTarget)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? optionButtons.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % optionButtons.length
          : (currentIndex - 1 + optionButtons.length) % optionButtons.length
    optionButtons[nextIndex]?.focus()
  }

  return (
    <div
      className={`code-select ${density} ${open ? 'open' : ''} ${className}`.trim()}
      ref={rootRef}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      {label !== undefined ? <span className="code-select-label" id={labelId}>{label}</span> : null}
      <button
        type="button"
        className={`code-field code-select-trigger ${triggerClassName}`.trim()}
        ref={triggerRef}
        role="combobox"
        aria-label={label === undefined ? ariaLabel : undefined}
        aria-labelledby={label !== undefined ? labelId : undefined}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required || undefined}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => {
          if (open) close()
          else openMenu()
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          openMenu(event.key === 'ArrowDown' || event.key === 'Home' ? 'first' : 'last')
        }}
      >
        <span className="code-select-value">{selected?.label || value}</span>
        <span className="code-select-chevron" aria-hidden="true"><ChevronDownGlyph /></span>
      </button>
      {open ? (
        <div
          className={`code-menu-surface code-menu-list code-select-menu ${menuClassName}`.trim()}
          id={menuId}
          ref={menuRef}
          role="listbox"
          aria-label={label === undefined ? ariaLabel : undefined}
          aria-labelledby={label !== undefined ? labelId : undefined}
        >
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              className={`code-select-option ${option.value === value ? 'selected' : ''}`}
              role="option"
              aria-selected={option.value === value}
              data-value={option.value}
              disabled={option.disabled}
              onClick={() => {
                if (option.value !== value) onChange(option.value)
                close(true)
              }}
              onKeyDown={moveOptionFocus}
            >
              <span className="code-select-option-copy">{option.label}</span>
              <span className="code-select-check" aria-hidden="true">
                {option.value === value ? <CheckGlyph /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
