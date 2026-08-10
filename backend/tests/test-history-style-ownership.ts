import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'history',
  prefixes: ['code-history'],
  expected: {
    combined: [46, '61e6c0822094942b79532e85dcd2727bf2fc4bfa0c2b3b990fd6f12ef7cb49fe'],
    base: [32, 'ba1c0e7371bb9862b4c48eeaad33b930f406fa3725b5bb137a5b4c8a9669eb36'],
    dark: [14, 'c4d96bb991f3ec04e420d2e3eb3cbd5abbb4ca0905a074ad846f61cc2383b61a'],
  },
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
  mustHaveDark: ['.code-history-panel-header'],
})

console.log('test-history-style-ownership passed')
