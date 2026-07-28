#!/usr/bin/env node

const assert = require('assert');

async function main() {
  const imported = await import('../../src/lib/terminal-attachment.ts');
  const {
    createTerminalAttachmentLeaseCoordinator,
  } = imported.default || imported;

  const scheduled = [];
  const coordinator = createTerminalAttachmentLeaseCoordinator(commit => scheduled.push(commit));
  const mount = {};
  let starts = 0;
  let teardowns = 0;

  const start = () => {
    starts += 1;
    return () => {
      teardowns += 1;
    };
  };

  const first = coordinator.acquire('agent-1', mount, start);
  first.release();
  const replacement = coordinator.acquire('agent-1', mount, start);
  scheduled.splice(0).forEach(commit => commit());

  assert.strictEqual(starts, 1, 'a same-owner effect handoff must reuse the attachment');
  assert.strictEqual(teardowns, 0, 'a same-owner effect handoff must cancel the pending release');

  first.release();
  assert.strictEqual(teardowns, 0, 'a stale lease must not release the current owner');

  replacement.release();
  scheduled.splice(0).forEach(commit => commit());
  assert.strictEqual(teardowns, 1, 'a real unmount must eventually release the attachment');

  const mountA = {};
  const mountB = {};
  const ownershipCoordinator = createTerminalAttachmentLeaseCoordinator(commit => scheduled.push(commit));
  let mountATeardowns = 0;
  let mountBTeardowns = 0;

  const leaseA = ownershipCoordinator.acquire('agent-1', mountA, () => () => {
    mountATeardowns += 1;
  });
  const leaseB = ownershipCoordinator.acquire('agent-1', mountB, () => () => {
    mountBTeardowns += 1;
  });

  assert.strictEqual(mountATeardowns, 1, 'changing the mount must synchronously release the old owner');
  leaseA.release();
  assert.strictEqual(mountATeardowns, 1, 'an old lease must not release a newer mount');

  leaseB.release();
  scheduled.splice(0).forEach(commit => commit());
  assert.strictEqual(mountBTeardowns, 1, 'the current mount must release after its lease ends');

  const agentCoordinator = createTerminalAttachmentLeaseCoordinator(commit => scheduled.push(commit));
  let firstAgentTeardowns = 0;
  const firstAgentLease = agentCoordinator.acquire('agent-1', mount, () => () => {
    firstAgentTeardowns += 1;
  });
  const secondAgentLease = agentCoordinator.acquire('agent-2', mount, () => () => {});
  assert.strictEqual(firstAgentTeardowns, 1, 'changing the Agent must release the old owner');
  firstAgentLease.release();
  secondAgentLease.release();
  scheduled.splice(0).forEach(commit => commit());

  console.log('✓ terminal attachment lease state transitions');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
