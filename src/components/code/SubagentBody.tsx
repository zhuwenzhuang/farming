import { useCallback, useState, type ReactNode, type ComponentProps } from 'react'
import type { AgentGoal } from '../../../shared/agent-goal'
import type { AgentTranscriptProcessItem } from './acp/acp-entry-projection'
import { AgentGoalActivityPreview, AgentPlanActivityPreview } from './AgentActivityDock'
import type { Agent } from '@/types/agent'
import { useAgentWithLiveRuntimeState } from '@/lib/agent-live-state'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { AcpTranscriptPane } from './acp/AcpTranscriptPane'
import type { CodeCopy } from './copy'

export function SubagentBody({ agent: structuralAgent, active, stickyTurnPromptEnabled = true, renderComposer, onOpenFile, onReadLatest, onQuoteSelection, onQuoteInParent, copy }: {
  agent: Agent
  active: boolean
  stickyTurnPromptEnabled?: boolean
  renderComposer: (agent: Agent, active: boolean) => ReactNode
  onOpenFile: ComponentProps<typeof AcpTranscriptPane>['onOpenWorkspaceFilePath']
  onReadLatest: (agentId: string) => void
  onQuoteSelection: (agentId: string, text: string) => void
  onQuoteInParent?: (text: string) => void
  copy: CodeCopy
}) {
  const agent = useAgentWithLiveRuntimeState(structuralAgent)!
  const runtime = isAcpRuntime(agent) ? agent.runtimeBinding : null
  const [goal, setGoal] = useState<AgentGoal | null>(null)
  const [plan, setPlan] = useState<AgentTranscriptProcessItem | undefined>(undefined)
  const [expanded, setExpanded] = useState<'goal' | 'plan' | null>(null)
  const visibleGoal = goal && goal.status !== 'complete' ? goal : null
  const readLatest = useCallback(() => onReadLatest(agent.id), [agent.id, onReadLatest])
  const quoteSelection = useCallback((text: string) => onQuoteSelection(agent.id, text), [agent.id, onQuoteSelection])
  return <>
    <AcpTranscriptPane pendingElicitations={runtime?.pendingElicitations} stickyTurnPromptEnabled={stickyTurnPromptEnabled} agentId={agent.id} readingIdentity={agent.providerSessionKey}
      workspaceRootId={agent.workspaceRootId} workspaceRoot={agent.projectWorkspace || agent.cwd}
      active={active} expectHistory forkedFromAgent copy={copy}
      refreshSignal={runtime?.sessionRevision || 0} runtimeState={runtime?.state || ''}
      onReadLatest={readLatest} onOpenWorkspaceFilePath={onOpenFile} onQuoteSelection={quoteSelection} onQuoteSelectionInParent={onQuoteInParent}
      onGoalChange={setGoal} onActivePlanChange={setPlan} />
    {visibleGoal || plan ? <section className="code-agent-activity-dock" data-testid="code-agent-activity-dock" aria-label="Agent activity"
      onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(null) } }}>
      {visibleGoal ? <AgentGoalActivityPreview goal={visibleGoal} expanded={expanded === 'goal'} onToggle={() => setExpanded(value => value === 'goal' ? null : 'goal')} /> : null}
      {plan ? <AgentPlanActivityPreview plan={plan} expanded={expanded === 'plan'} onToggle={() => setExpanded(value => value === 'plan' ? null : 'plan')} /> : null}
    </section> : null}
    {renderComposer(agent, active)}
  </>
}
