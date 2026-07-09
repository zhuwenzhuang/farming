import { CodexTranscriptPane, type CodexTranscriptPaneProps } from './CodexTranscriptPane'

type CodexAppServerTranscriptPaneProps = Omit<CodexTranscriptPaneProps, 'source'>

// App Server Chat intentionally has its own data path. It renders only the
// normalized events received from the managed App Server connection; it never
// reads terminal output or Codex rollout JSONL.
export function CodexAppServerTranscriptPane(props: CodexAppServerTranscriptPaneProps) {
  return <CodexTranscriptPane {...props} source="app-server" />
}
