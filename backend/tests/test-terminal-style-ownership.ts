import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'terminal',
  prefixes: ['code-terminal', 'terminal-session', 'terminal-context'],
  componentSources: [
    'src/components/AgentTerminalPane.tsx',
    'src/components/code/AgentWorkPane.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/CodeWorkspace.tsx',
  ],
  unstyledClassNames: [
    'code-terminal-search-case-sensitive',
    'code-terminal-search-input',
    'code-terminal-search-regex',
    'code-terminal-search-whole-word',
  ],
  mustHaveBase: ['.code-terminal-grid', '.code-terminal-pane'],
})

console.log('test-terminal-style-ownership passed')
