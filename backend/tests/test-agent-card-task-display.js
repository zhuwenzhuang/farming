const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const component = fs.readFileSync(path.join(__dirname, '../../src/components/AgentCard.tsx'), 'utf8');
  const format = fs.readFileSync(path.join(__dirname, '../../src/lib/format.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../../src/styles/main.css'), 'utf8');
  const types = fs.readFileSync(path.join(__dirname, '../../src/types/agent.ts'), 'utf8');

  assert(component.includes('agent.task'), 'AgentCard should read agent.task');
  assert(component.includes('agent-task'), 'AgentCard should render task summary');
  assert(component.includes('child-badge'), 'AgentCard should render child badge for parentAgentId');
  assert(format.includes('customTitle'), 'agentTitle should allow a user-provided custom title');
  assert(format.includes('if (customTitle) return truncateTitle(customTitle)'), 'agentTitle should prefer custom titles before agent titles');
  assert(format.includes("if (agent.isMain) return 'Main Agent'"), 'agentTitle should use a clear Main Agent label');
  assert(format.includes('meaningfulSessionTitle(agent.sessionTitle, agent)'), 'agentTitle should use agent-updated session titles');
  assert(format.includes('return agentDisplayName(agent.command)'), 'agentTitle should fall back to the agent display name');
  assert(styles.includes('.agent-task'), 'main.css should style task summary');
  assert(styles.includes('.child-badge'), 'main.css should style child badge');
  assert(types.includes('parentAgentId?: string'), 'Agent type should include parentAgentId');
  assert(types.includes('customTitle?: string'), 'Agent type should include customTitle');
  assert(types.includes('task?: string'), 'Agent type should include task');

  console.log('✓ AgentCard displays child task metadata');
}

run();
