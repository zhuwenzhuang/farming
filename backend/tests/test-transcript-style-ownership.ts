import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'transcript',
  // code-acp composer/auth surfaces belong to the Composer owner; only the
  // embedded terminal, progress, and terminal cards render inside transcripts.
  prefixes: ['code-agent-transcript', 'code-acp-embedded', 'code-acp-progress', 'code-acp-terminal'],
  componentSources: [
    'src/components/code/acp/AcpEmbeddedTerminal.tsx',
    'src/components/code/AgentActivityDock.tsx',
    'src/components/code/AgentTranscriptPane.tsx',
  ],
  unstyledClassNames: [
    'code-acp-terminal-stop',
    'code-acp-terminal-sync-error',
    'code-agent-transcript-copy-answer',
    'code-agent-transcript-markdown-render-error',
    'code-agent-transcript-mermaid-render-error',
    'code-agent-transcript-process-group-toggle',
    'code-agent-transcript-process-item-toggle',
    'code-agent-transcript-steer-content',
    'code-agent-transcript-tool-render-error',
    'code-agent-transcript-turn-render-error',
  ],
  mustHaveBase: ['.code-agent-transcript', '.code-agent-transcript-turn', '.code-acp-progress-update'],
})

console.log('test-transcript-style-ownership passed')
