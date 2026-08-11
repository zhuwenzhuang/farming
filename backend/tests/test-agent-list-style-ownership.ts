import { assertDomainStyleOwnership } from './style-ownership-contract'

assertDomainStyleOwnership({
  domain: 'agent-list',
  prefixes: ['code-agent', 'code-agents'],
  // Transcript rendering and sidebar resource slots have their own owners.
  excludePrefixes: ['code-agent-transcript', 'code-agent-resource'],
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
})

console.log('test-agent-list-style-ownership passed')
