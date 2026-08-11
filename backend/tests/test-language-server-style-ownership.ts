import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'language-server',
  prefixes: ['code-language-server'],
  componentSources: [
    'src/components/files/FileEditorPane.tsx',
    'src/components/files/LanguageServerPanel.tsx',
  ],
  unstyledClassNames: ['code-language-server-dock-width'],
  mustHaveBase: ['.code-language-server-panel', '.code-language-server-node'],
})

console.log('test-language-server-style-ownership passed')
