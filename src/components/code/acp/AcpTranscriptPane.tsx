import { AgentTranscriptPane, type AgentTranscriptPaneProps } from '../AgentTranscriptPane'

type AcpTranscriptPaneProps = Omit<AgentTranscriptPaneProps, 'source'>

export function AcpTranscriptPane(props: AcpTranscriptPaneProps) {
  return <AgentTranscriptPane {...props} source="acp" groupProcessActions />
}
