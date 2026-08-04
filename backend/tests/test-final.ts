const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');
let state = null;
let stateGeneration = '';
let stateSequence = -1;
let snapshot = null;
let tests = [];

function applyDelta(agents, upserts, removedAgentIds) {
  const removals = new Set(removedAgentIds || []);
  const replacements = new Map((upserts || []).map(agent => [agent.id, agent]));
  const retained = new Set();
  const next = [];
  for (const agent of agents || []) {
    if (removals.has(agent.id)) continue;
    next.push(replacements.get(agent.id) || agent);
    retained.add(agent.id);
  }
  for (const agent of upserts || []) {
    if (!removals.has(agent.id) && !retained.has(agent.id)) next.push(agent);
  }
  return next;
}

ws.on('open', () => {
  console.log('=== Farming Test Suite ===\n');
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'state') {
      if (!msg.snapshot) {
        state = msg.state;
      } else if (msg.snapshot.offset === 0) {
        const { agents, ...metadata } = msg.state;
        snapshot = { id: msg.snapshot.id, total: msg.snapshot.total, metadata, agents: [...agents] };
      } else if (snapshot && snapshot.id === msg.snapshot.id && snapshot.agents.length === msg.snapshot.offset) {
        snapshot.agents.push(...msg.state.agents);
      } else {
        snapshot = null;
        ws.send(JSON.stringify({ type: 'state-resync' }));
        return;
      }
      if (msg.snapshot?.complete && snapshot && snapshot.agents.length === snapshot.total) {
        state = { ...snapshot.metadata, agents: snapshot.agents };
        snapshot = null;
      }
      stateGeneration = msg.generation;
      stateSequence = msg.sequence;
    } else if (
      msg.type === 'state-delta'
      && state
      && msg.generation === stateGeneration
      && msg.sequence === stateSequence + 1
    ) {
      state = {
        ...state,
        ...(msg.state || {}),
        agents: applyDelta(state.agents, msg.upserts, msg.removedAgentIds),
      };
      stateSequence = msg.sequence;
    } else if (msg.type === 'error') {
      console.log('ERROR:', msg.message);
    }
  });
  
  runTests();
});

async function runTests() {
  await delay(1000);
  const initialAgentIds = new Set((state?.agents || []).map((agent) => agent.id));
  const initialMainAgentId = state?.mainAgentId || null;
  
  // Test 1: ls should be pending (non-tty)
  console.log('1. Testing non-tty command (ls)...');
  ws.send(JSON.stringify({ type: 'start-agent', command: 'ls' }));
  await delay(3000);
  const lsAgent = state.agents.find(a => a.command === 'ls');
  tests.push({
    name: 'Non-tty rejection',
    ok: !lsAgent || lsAgent.status !== 'running',
    detail: lsAgent ? `ls status: ${lsAgent.status}` : 'ls not found'
  });
  
  // Test 2: bash should succeed without breaking existing Main Agent ownership
  console.log('2. Testing tty command (bash)...');
  ws.send(JSON.stringify({ type: 'start-agent', command: 'bash' }));
  await delay(3000);
  const bashAgent = state.agents.find(
    (a) => a.command === 'bash' && a.status === 'running' && !initialAgentIds.has(a.id)
  );
  tests.push({
    name: 'TTY agent created',
    ok: !!bashAgent,
    detail: bashAgent ? `bash running${bashAgent.isMain ? ' as Main' : ''}` : 'bash not found'
  });
  tests.push({
    name: 'Main Agent ownership stable',
    ok: initialMainAgentId ? state.mainAgentId === initialMainAgentId : !!(bashAgent && bashAgent.isMain),
    detail: initialMainAgentId
      ? `mainAgentId: ${state.mainAgentId || 'none'}`
      : bashAgent && bashAgent.isMain
        ? 'bash became Main Agent'
        : 'bash did not become Main Agent'
  });
  
  // Test 3: Send input to bash
  if (bashAgent) {
    console.log('3. Testing input to bash...');
    await delay(1000);
    ws.send(JSON.stringify({ type: 'input', agentId: bashAgent.id, input: 'echo test123\n' }));
    await delay(3000);
    const updatedBash = state.agents.find(a => a.id === bashAgent.id);
    const hasOutput = updatedBash && updatedBash.output.includes('test123');
    tests.push({
      name: 'Input processed',
      ok: hasOutput,
      detail: hasOutput ? 'Output contains test123' : `Output: "${updatedBash ? updatedBash.output : 'none'}"`
    });
    
    // Test 4: Create second agent
    console.log('4. Testing second agent...');
    ws.send(JSON.stringify({ type: 'start-agent', command: 'python3' }));
    await delay(3000);
    const pythonAgent = state.agents.find(
      (a) => a.command === 'python3' && a.status === 'running' && !initialAgentIds.has(a.id)
    );
    tests.push({
      name: 'Second agent created',
      ok: !!pythonAgent && bashAgent && pythonAgent.id !== bashAgent.id && !pythonAgent.isMain,
      detail: pythonAgent ? 'python3 running and not Main' : 'python3 not found'
    });
    
    // Test 5: Archive Main Agent
    console.log('5. Testing archive Main Agent...');
    ws.send(JSON.stringify({ type: 'archive-agent', agentId: bashAgent.id }));
    await delay(1000);
    const deadBash = state.agents.find(a => a.id === bashAgent.id);
    tests.push({
      name: 'Main Agent archived',
      ok: !deadBash,
      detail: deadBash ? 'bash still exists' : 'bash removed'
    });
    tests.push({
      name: 'Other agent preserved',
      ok: !!pythonAgent && state.agents.some((agent) => agent.id === pythonAgent.id),
      detail: pythonAgent
        ? `${state.agents.filter((agent) => agent.id === pythonAgent.id).length} matching python3 agents remain`
        : `${state.agents.length} agents remain`
    });
  }
  
  // Summary
  console.log('\n=== Test Results ===');
  tests.forEach(t => {
    console.log(`${t.ok ? '✓' : '✗'} ${t.name}: ${t.detail}`);
  });
  const successCount = tests.filter(t => t.ok).length;
  console.log(`\nSuccess: ${successCount}/${tests.length}`);
  
  ws.close();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

ws.on('close', () => {
  process.exit(0);
});
