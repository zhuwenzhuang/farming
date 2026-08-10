import assert from 'assert';
import { AgentStartAdmissionCoordinator } from '../agent-start-admission-coordinator.cjs';

async function main() {
  const coordinator = new AgentStartAdmissionCoordinator();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let admittedToken: symbol | undefined;
  let executionCount = 0;
  const reports: Array<Record<string, unknown>> = [];
  const execute = async (token: symbol, report: (
    agentId: string | null,
    error?: string | null,
    metadata?: Record<string, unknown>,
  ) => void) => {
    executionCount += 1;
    admittedToken = token;
    await gate;
    report('agent-a', null, { source: 'test' });
    return 'agent-a';
  };
  const first = coordinator.start({
    execute,
    report: (agentId, error, metadata) => reports.push({ agentId, error, metadata }),
    requestId: 'request-a',
    signature: 'signature-a',
    workspaceKey: '/workspace/initial',
  });
  await Promise.resolve();
  assert(admittedToken);
  assert.strictEqual(coordinator.has(admittedToken), true);
  coordinator.setWorkspace(admittedToken, '/workspace/final');
  assert.strictEqual(
    coordinator.pendingForWorkspace('/workspace', (root, candidate) => candidate.startsWith(root)).length,
    1,
  );

  const duplicate = coordinator.start({
    execute,
    report: (agentId, error, metadata) => reports.push({ agentId, error, metadata }),
    requestId: 'request-a',
    signature: 'signature-a',
    workspaceKey: '/workspace/final',
  });
  const conflicting = coordinator.start({
    execute,
    report: (agentId, error) => reports.push({ agentId, error }),
    requestId: 'request-a',
    signature: 'signature-b',
    workspaceKey: '/workspace/final',
  });
  assert.strictEqual(await conflicting, null);
  assert.match(String(reports.at(-1)?.error), /different Agent parameters/);
  assert.strictEqual(executionCount, 1);

  release();
  assert.strictEqual(await first, 'agent-a');
  assert.strictEqual(await duplicate, 'agent-a');
  assert.strictEqual(reports.length, 3);
  assert.deepStrictEqual(reports.at(-1)?.metadata, {
    source: 'test',
    deduplicated: true,
  });
  assert.strictEqual(coordinator.has(admittedToken), false);
  assert.deepStrictEqual(coordinator.pendingOperations(), []);

  console.log('Agent start admission coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
