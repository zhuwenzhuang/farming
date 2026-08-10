import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'agent-list',
  prefixes: ['code-agent', 'code-agents'],
  // Transcript rendering and sidebar resource slots have their own owners.
  excludePrefixes: ['code-agent-transcript', 'code-agent-resource'],
  expected: {
    combined: [184, '29878524ee550a3bbd092143865ce38ce389ab3c479057472a7d730e68ba0a82'],
    base: [143, 'f827b44d74702605b2adc01eee6bf8edd9ba598cc050c12a6fc0fa6a1d3760ac'],
    dark: [41, 'ff5fbc732bf7b5d38896d6da8041c7ec547f322773103c651b9588cc42d4b871'],
  },
  componentSources: [
    'src/components/code/AgentLaunchSubmenu.tsx',
    'src/components/code/AgentWorkPane.tsx',
    'src/components/code/CodeSidebar.tsx',
    'src/components/code/SearchPanel.tsx',
  ],
  unstyledClassNames: [
    'code-agent-chat-view',
    'code-agent-hover-preview-browser-count',
    'code-agent-hover-preview-desktop-count',
    'code-agent-new-worktree-fork',
    'code-agent-rail-item',
    'code-agent-row-age',
    'code-agent-row-archive',
    'code-agent-row-detail',
    'code-agent-row-pin',
    'code-agent-show-less',
    'code-agent-show-more',
    'code-agent-terminal-view',
  ],
  mustHaveBase: ['.code-agent-row', '.code-agent-rail-button', '.code-agent-dot'],
  mustHaveDark: ['.code-agent-row', '.code-agents-section'],
})

console.log('test-agent-list-style-ownership passed')
