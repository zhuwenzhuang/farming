import { CodexTranscriptPane, type CodexTranscriptPaneProps } from './CodexTranscriptPane'

type JsonCliTranscriptPaneProps = Omit<CodexTranscriptPaneProps, 'source'>

export function JsonCliTranscriptPane(props: JsonCliTranscriptPaneProps) {
  return <CodexTranscriptPane {...props} source="json-cli" />
}
