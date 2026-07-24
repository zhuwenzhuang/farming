import { AgentTranscriptPane, type AgentTranscriptPaneProps } from './AgentTranscriptPane'

type JsonCliTranscriptPaneProps = Omit<AgentTranscriptPaneProps, 'source'>

export function JsonCliTranscriptPane(props: JsonCliTranscriptPaneProps) {
  return <AgentTranscriptPane {...props} source="json-cli" />
}
