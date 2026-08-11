import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'transcript',
  // code-acp composer/auth surfaces belong to the Composer owner; only the
  // embedded terminal, progress, and terminal cards render inside transcripts.
  prefixes: ['code-agent-transcript', 'code-acp-embedded', 'code-acp-progress', 'code-acp-terminal'],
  expected: {
    combined: [561, 'ac6e68f845ae06d64434a22c102b9be801f58438c6045278cff1e13e5f314ec4'],
    base: [408, 'b8efcdd423f3d94eb40e436eae6847b251123d10bc6d0d15bdf4544bc425b61e'],
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
