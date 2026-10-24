import { useLayoutEffect, useRef } from 'react'
import { ComposerRichInput } from './ComposerRichInput'
import { ComposerAttachments } from './ComposerAttachments'
import type { ComposerInputElement } from './composer-input-element'
import type { AgentComposerState } from './composer-state'
import type { CodeCopy } from './copy'

export function SubagentPreparation({ state, update, error, retryable, onCheck, copy, language }: {
  state: AgentComposerState
  update: (change: (state: AgentComposerState) => AgentComposerState) => void
  error?: string; retryable?: boolean; onCheck: () => void; copy: CodeCopy; language: 'en' | 'zh'
}) {
  const input = useRef<ComposerInputElement>(null)
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  return <>
    <div className="code-subagent-preparation" role={error ? 'alert' : 'status'}>
      <span>{error || (language === 'zh' ? '正在准备子 Agent，可以先写问题。就绪后即可发送。' : 'Preparing subagent. You can draft your question now and send when ready.')}</span>
      {error ? <button type="button" className="code-agent-transcript-subagent-control" onClick={onCheck}>{retryable ? language === 'zh' ? '重试' : 'Retry' : language === 'zh' ? '核对创建结果' : 'Check creation result'}</button> : null}
    </div>
    <div className="code-composer code-subagent-preparation-composer" data-testid="code-subagent-preparation-composer">
      <ComposerAttachments attachments={[]} onRemove={() => {}} references={state.contextReferences}
        onRemoveReference={id => update(current => ({ ...current, contextReferences: current.contextReferences?.filter(item => item.id !== id) }))} />
      <ComposerRichInput inputRef={input} value={state.draft} document={state.draftDocument} disabled={false}
        placeholder={copy.askFollowUpChanges} data-testid="code-subagent-preparation-input"
        onValueChange={(draft, draftDocument) => update(current => ({ ...current, draft, draftDocument }))} />
    </div>
  </>
}
