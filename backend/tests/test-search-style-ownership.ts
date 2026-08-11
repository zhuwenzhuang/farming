import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'search',
  prefixes: ['code-search'],
  componentSources: [
    'src/components/code/SearchPanel.tsx',
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/CodeWorkspace.tsx',
  ],
  mustHaveBase: ['.code-search-panel', '.code-search-result-copy'],
})

console.log('test-search-style-ownership passed')
