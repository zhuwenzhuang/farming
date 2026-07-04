import { useState, useCallback } from 'react'
import type { Agent } from '@/types/agent'

interface MobileMainAgentBarProps {
  mainAgent: Agent | null
  mainAgentId: string | null
  onOpenSession: () => void
  sendInput: (agentId: string, data: string) => void
}

export function MobileMainAgentBar({ mainAgent, mainAgentId, onOpenSession, sendInput }: MobileMainAgentBarProps) {
  const [input, setInput] = useState('')

  const handleSubmit = useCallback(() => {
    if (!mainAgentId) return
    if (input.trim()) {
      sendInput(mainAgentId, input + '\r')
      setInput('')
    }
    onOpenSession()
  }, [input, mainAgentId, sendInput, onOpenSession])

  if (!mainAgent) return null

  return (
    <div className="mobile-main-bar" data-testid="mobile-main-bar">
      <button
        className="mobile-main-icon fx-crt-panel-compact"
        data-testid="mobile-main-open"
        onClick={onOpenSession}
      >
        M
      </button>
      <input
        className="mobile-main-input"
        data-testid="mobile-main-input"
        placeholder="Send to main agent..."
        name="main-agent-command"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
      />
      <button
        className="mobile-main-submit fx-crt-panel-compact"
        data-testid="mobile-main-submit"
        onClick={handleSubmit}
      >
        ⏎
      </button>
    </div>
  )
}
