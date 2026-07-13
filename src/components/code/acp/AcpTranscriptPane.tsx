import { CodexTranscriptPane, type CodexTranscriptPaneProps } from '../CodexTranscriptPane'

type AcpTranscriptPaneProps = Omit<CodexTranscriptPaneProps, 'source'>

export function AcpTranscriptPane(props: AcpTranscriptPaneProps) {
  return <CodexTranscriptPane {...props} source="acp" groupProcessActions />
}
