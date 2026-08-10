import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'empty',
  prefixes: ['code-empty'],
  expected: {
    combined: [65, '441dbfbc757e435822ba66ad284ed0a54008069316227430dd8c1ffc20adac0c'],
    base: [49, 'b33a72d6c06347d86b5ab5f7673d641a4c5766617bcca0d7f8660ce313429bd3'],
    dark: [16, '2801a7c9e2f28581cb42f349d6b9106a78738b89bccb61d34833b18fd9f864eb'],
  },
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
  mustHaveDark: ['.code-empty-workspace'],
})

console.log('test-empty-style-ownership passed')
