import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'terminal',
  prefixes: ['code-terminal', 'terminal-session', 'terminal-context'],
  expected: {
    combined: [150, '6c7792efe696e07a07cf457ba1d218b8ae0231aa4e4ccedc7b05ae5149a83883'],
    base: [96, '876fb7d8f210a5f7c062d2bde3ef165c838cafd1ad9fa6bbae4d266c844a5cbd'],
    dark: [54, 'eda362a5f29da2b5735c80a932b58023af6811087d155daa4888ca1b0d9f9e00'],
  },
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
  mustHaveDark: ['.code-terminal-grid'],
})

console.log('test-terminal-style-ownership passed')
