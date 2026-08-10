import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'transcript',
  // code-acp composer/auth surfaces belong to the Composer owner; only the
  // embedded terminal, progress, and terminal cards render inside transcripts.
  prefixes: ['code-agent-transcript', 'code-acp-embedded', 'code-acp-progress', 'code-acp-terminal'],
  expected: {
    combined: [561, 'e5a155c21188de1c835c67ccfb4e2ee9c72d4d70674d7d5f2b1b2c738ffebc73'],
    base: [408, '5cfccc90c7173ee7bbb993d5f0896002da305cf30d968b0008d50a493c2305ac'],
    dark: [153, '9eed57cb5e0380fb27c44a01a70b9dc3c429a7c09ab8cb530b9b33aac7017154'],
  },
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
  mustHaveDark: ['.code-agent-transcript'],
})

console.log('test-transcript-style-ownership passed')
