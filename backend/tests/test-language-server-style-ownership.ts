import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'language-server',
  prefixes: ['code-language-server'],
  expected: {
    combined: [93, 'a1d56b5af1680be563d31a0260b6dad64bb269b16a8d43dd693b8a92711843ba'],
    base: [65, 'b51f0e197e193f1e5bb6b27e0b58b98186693f7dec511f8db4c6fd78e6ae0558'],
    dark: [28, 'f091422cf22b33424c657b50a8ffe4fa0e6ce9a968a9a668099e9aedab181024'],
  },
  componentSources: [
    'src/components/files/FileEditorPane.tsx',
    'src/components/files/LanguageServerPanel.tsx',
  ],
  unstyledClassNames: ['code-language-server-dock-width'],
  mustHaveBase: ['.code-language-server-panel', '.code-language-server-node'],
  mustHaveDark: ['.code-language-server-node'],
})

console.log('test-language-server-style-ownership passed')
