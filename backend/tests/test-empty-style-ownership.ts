import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'empty',
  prefixes: ['code-empty'],
  componentSources: [
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/SearchPanel.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/code/CodeSidebar.tsx',
  ],
  unstyledClassNames: [
    'code-empty-compact-history',
    'code-empty-compact-new-agent',
    'code-empty-compact-plugins',
    'code-empty-history-search',
    'code-empty-home-connector-mask',
    'code-empty-home-connector-weight',
    'code-empty-home-history',
    'code-empty-home-new-agent',
    'code-empty-search',
  ],
  mustHaveBase: ['.code-empty-workspace', '.code-empty-home'],
})

console.log('test-empty-style-ownership passed')
