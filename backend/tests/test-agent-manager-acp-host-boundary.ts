const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const managerSource = fs.readFileSync(path.join(projectRoot, 'backend/agent-manager.cts'), 'utf8');

assert(
  managerSource.includes('new AcpRuntimeHostRuntime({'),
  'AgentManager must construct the ACP Host facade by default',
);
assert(
  !managerSource.includes('new AcpRuntime()'),
  'AgentManager must not fall back to the in-process ACP engine',
);
assert(
  !managerSource.includes("import { AcpRuntime,"),
  'the in-process ACP engine must stay behind the Host process boundary',
);
assert(
  managerSource.includes('AgentManager requires an exact Config directory or an explicit ACP runtime'),
  'AgentManager must not bind the ACP Host to an implicit user Config instance',
);

console.log('AgentManager ACP Host boundary tests passed');
