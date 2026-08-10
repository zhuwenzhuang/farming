import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'search',
  prefixes: ['code-search'],
  expected: {
    combined: [48, '2a4735059ce76f254c2862020794e33373b974cee5850a70141e27c7cee89f54'],
    base: [34, '44a2114bc7e38ed5f16dbe0fb30df119c8c4647a84d9701ae4d0a57b91574400'],
    dark: [14, '75b667590141962d65f327805224b0bf17e262f259416885e20c2a44d8fd2c30'],
  },
  componentSources: [
    'src/components/code/SearchPanel.tsx',
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/CodeWorkspace.tsx',
  ],
  mustHaveBase: ['.code-search-panel', '.code-search-result-copy'],
  mustHaveDark: ['.code-search-panel-header'],
})

console.log('test-search-style-ownership passed')
