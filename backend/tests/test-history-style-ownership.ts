import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'history',
  prefixes: ['code-history'],
  componentSources: [
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/CodeMainArea.tsx',
  ],
  unstyledClassNames: [
    'code-history-agents',
    'code-history-back',
    'code-history-error',
    'code-history-loading',
    'code-history-page-status',
    'code-history-refresh-error',
    'code-history-resume-id',
    'code-history-search-box',
    'code-history-search-loading',
  ],
  mustHaveBase: ['.code-history-panel', '.code-history-card-title'],
})

console.log('test-history-style-ownership passed')
