import { useCallback, type ReactNode, type ComponentProps } from 'react'
import type { Agent } from '@/types/agent'
import { useAgentWithLiveRuntimeState } from '@/lib/agent-live-state'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { AcpTranscriptPane } from './acp/AcpTranscriptPane'
import type { CodeCopy } from './copy'

export function SideChatBody({ agent: structuralAgent, active, renderComposer, onOpenFile, onReadLatest, copy }: {
  agent: Agent
  active: boolean
  renderComposer: (agent: Agent, active: boolean) => ReactNode
  onOpenFile: ComponentProps<typeof AcpTranscriptPane>['onOpenWorkspaceFilePath']
  onReadLatest: (agentId: string) => void
  copy: CodeCopy
}) {
  const agent = useAgentWithLiveRuntimeState(structuralAgent)!
  const runtime = isAcpRuntime(agent) ? agent.runtimeBinding : null
  const readLatest = useCallback(() => onReadLatest(agent.id), [agent.id, onReadLatest])
  return <>
    <AcpTranscriptPane agentId={agent.id} readingIdentity={agent.providerSessionKey}
      workspaceRootId={agent.workspaceRootId} workspaceRoot={agent.projectWorkspace || agent.cwd}
      active={active} expectHistory forkedFromAgent copy={copy}
      refreshSignal={runtime?.sessionRevision || 0} runtimeState={runtime?.state || ''}
      onReadLatest={readLatest} onOpenWorkspaceFilePath={onOpenFile} />
    {renderComposer(agent, active)}
  </>
}
