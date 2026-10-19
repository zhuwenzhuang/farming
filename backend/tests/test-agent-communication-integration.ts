import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import express from 'express';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { AgentManager } from '../agent-manager.cts';
import { ConfigManager } from '../config-manager.cts';
import { AcpRuntime } from '../acp-runtime.cts';
import { AcpRuntimeHostProcess } from '../acp-runtime-host-process.cts';
import { AcpRuntimeHostRuntime } from '../acp-runtime-host-runtime.cts';
import { AgentCommunicationRuntime } from '../agent-communication-runtime.cts';
import { createAgentCommunicationA2aRouter } from '../agent-communication-a2a.cts';
import { runCommunicationCommand } from '../agent-communication-cli.cts';

const require = createRequire(import.meta.url);

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Communication execution exceeded the test deadline')), 15000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}


for (const provider of ['claude', 'codex', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) test(`${provider}: A2A CLI executes through manager, Host socket and ACP process with correlated full reply`, { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-integration-'));
  // Pi validates its system CLI identity before the injected ACP launcher runs.
  // Own that prerequisite instead of depending on a developer's installed CLI.
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'pi'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.1"; else echo "pi - AI coding assistant with read, bash, edit, write tools"; fi\n', { mode: 0o755 });
  const config = new ConfigManager({ configDir: root }); config.init();
  const socketPath = path.join(root, 'host.sock');
  const engine = new AcpRuntime({ configDir: root, resolveLaunch: () => ({
    command: process.execPath, args: ['--import', require.resolve('tsx'), path.resolve('backend/tests/fixtures/fake-acp-agent.mts')], version: 'test',
  }) });
  const host = new AcpRuntimeHostProcess({ configDir: root, socketPath, runtime: engine, exitOnShutdown: false });
  const facade = new AcpRuntimeHostRuntime({ configDir: root, socketPath, connectRetries: 5 });
  const communication: AgentCommunicationRuntime = new AgentCommunicationRuntime(root, () => manager);
  const manager = new AgentManager(config, { acpRuntime: facade, skipExecutablePreflight: true,
    agentShellEnvProvider: () => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }),
    communicationToken: id => communication.tokenForLaunch(id),
  });
  const app = express(); const server = app.listen(0, '127.0.0.1');
  try {
    await host.start(); await manager.recoveryGate.wait();
    let startError = '';
    const target = await manager.startAgent(provider, root, (_id, error) => { startError = error || ''; }, { agentRuntimeMode: 'chat', wantsMain: false });
    assert.ok(target, startError);
    const live = manager.resolveCommunicationAgent(target);
    assert.ok(live.sessionKey);
    const grant = await communication.credentials.issue({ kind: 'external', peerId: 'test-peer', name: 'Peer reviewer' }, [target], Date.now() + 60000);
    if (!server.listening) await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    app.use('/api/a2a', createAgentCommunicationA2aRouter({ authorizeExternal: async () => 1, credentials: communication.credentials,
      service: communication.service, endpointBaseUrl: baseUrl + '/api/a2a',
      resolveTarget: (identity, agentId) => communication.resolveTarget(identity, agentId),
    }));
    let output = '';
    const options = { baseUrl, token: grant.token, write: (text: string) => { output = text; } };
    const command = { operation: 'send' as const, agentId: target, messageId: 'integration-1', text: 'farming peer integration: verify identity and complete response' };
    await runCommunicationCommand(command, options);
    const taskId = (JSON.parse(output) as { id: string }).id;
    await bounded(communication.service.waitForSettledOperations());
    const result = await communication.service.get(grant.grant, target, taskId);
    assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    const part = result.artifacts[0].parts[0].content; assert.equal(part?.$case, 'text');
    const reply = JSON.parse(String(part?.value)) as { request: string; envelope: string; agentId: string; hasCommunicationToken: boolean; result: string };
    assert.equal(reply.request, command.text);
    assert.match(reply.envelope, /external:test-peer/);
    assert.match(reply.envelope, /Peer reviewer/);
    assert.equal(reply.agentId, target);
    assert.equal(reply.hasCommunicationToken, true);
    assert.ok(reply.result.length > 1000);
    const session = await manager.getAcpSessionForRead(target);
    assert.ok(session);
    const entries = session.entries as Array<{ role?: string; content?: Array<{ text?: string }>; _meta?: { peerMessage?: { senderAddress?: string } } }>;
    assert.equal(entries.filter(entry => entry.role === 'user').length, 1, JSON.stringify(entries));
    assert.equal(entries.find(entry => entry.role === 'user')?._meta?.peerMessage?.senderAddress, 'external:test-peer');
    assert.equal(entries.find(entry => entry.role === 'user')?.content?.[0].text, command.text);
    await runCommunicationCommand(command, options);
    assert.equal((JSON.parse(output) as { id: string }).id, taskId);
    // Crash image: Host settled, but the communication owner's final write was lost.
    // Use another Config journal to avoid two writers touching one live journal.
    const recovery = path.join(root, 'recovery'); await fs.mkdir(recovery);
    const image = JSON.parse(await fs.readFile(path.join(root, 'agent-communications.json'), 'utf8'));
    image.records[0].delivery = 'working'; image.records[0].task.status.state = 'TASK_STATE_WORKING';
    image.records[0].task.artifacts = [];
    await fs.writeFile(path.join(recovery, 'agent-communications.json'), JSON.stringify(image));
    const restored = new AgentCommunicationRuntime(recovery, () => manager);
    const [recovered, concurrentRecovery] = await Promise.all([
      restored.service.get(grant.grant, target, taskId), restored.service.get(grant.grant, target, taskId),
    ]);
    assert.deepEqual(concurrentRecovery, recovered);
    assert.equal(recovered.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.deepEqual(recovered.artifacts[0].parts, result.artifacts[0].parts);
    const receiptRequest = { agentId: target, sessionKey: live.sessionKey, requestId: image.records[0].execution.requestId,
      text: command.text, source: { ...image.records[0].execution.source, senderTaskId: taskId } };
    await assert.rejects(manager.reconcilePeerMessage({ ...receiptRequest, text: 'different content' }), /does not match/);
    assert.equal(await manager.reconcilePeerMessage({ ...receiptRequest, sessionKey: 'replacement' }), null);
    const sender = await manager.startAgent(provider === 'qwen' ? 'claude' : 'qwen', root, undefined,
      { agentRuntimeMode: 'chat', wantsMain: false });
    assert.ok(sender);
    const senderToken = await communication.tokenForLaunch(sender);
    const senderGrant = await communication.credentials.authenticate(senderToken); assert.ok(senderGrant);
    const requests = ['one', 'two'].map(label => ({ operation: 'send' as const, agentId: target,
      messageId: `local-${label}`, text: `farming peer integration concurrent ${label}` }));
    const taskIds = await Promise.all(requests.map(async request => {
      let text = '';
      await runCommunicationCommand(request, { baseUrl, token: senderToken, write: value => { text = value; } });
      return (JSON.parse(text) as { id: string }).id;
    }));
    await bounded(communication.service.waitForSettledOperations());
    for (let index = 0; index < taskIds.length; index++) {
      const task = await communication.service.get(senderGrant, target, taskIds[index]);
      assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
      const reply = JSON.parse(String(task.artifacts[0].parts[0].content?.value)) as { request: string; envelope: string };
      assert.equal(reply.request, requests[index].text, 'queued requests must receive their own final result');
      assert.ok(reply.envelope.includes(`agent:${sender}`));
    }
    const after = await manager.getAcpSessionForRead(target);
    const received = (after?.entries as typeof entries).filter(entry => entry.role === 'user');
    assert.equal(received.length, 3);
    assert.equal(received.filter(entry => entry._meta?.peerMessage?.senderAddress === `agent:${sender}`).length, 2);
    await runCommunicationCommand({ operation: 'send', agentId: target, messageId: 'followup',
      replyToTaskId: taskIds[0], text: 'farming peer integration followup' },
    { baseUrl, token: senderToken, write: value => { output = value; } });
    const followupId = (JSON.parse(output) as { id: string }).id;
    await bounded(communication.service.waitForSettledOperations());
    const followup = await communication.service.get(senderGrant, target, followupId);
    const original = await communication.service.get(senderGrant, target, taskIds[0]);
    assert.equal(followup.contextId, original.contextId);
    assert.deepEqual(followup.history[0].referenceTaskIds, [taskIds[0]]);
    assert.ok(String(followup.artifacts[0].parts[0].content?.value).includes(taskIds[0]),
      'provider must see the trusted relation to the prior Task');



    const cancelTask = await communication.service.send(senderGrant, target, SendMessageRequest.fromJSON({
      message: { messageId: 'cancel-original', parts: [{ text: 'farming peer integration peer-cancel' }] },
    }));
    const deadline = Date.now() + 5000;
    let cancelRequestId = '';
    while (Date.now() < deadline) {
      const journal = JSON.parse(await fs.readFile(path.join(root, 'agent-communications.json'), 'utf8'));
      const record = journal.records.find((item: { task: { id: string } }) => item.task.id === cancelTask.id);
      cancelRequestId = record.execution.requestId;
      const operation = await facade.getPromptOperation(target, cancelRequestId);
      const transcript = await manager.getAcpSessionForRead(target);
      if (operation?.status === 'provider-owned' && JSON.stringify(transcript?.entries).includes('peer-cancel')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(Date.now() < deadline, 'cancel fixture reaches original running turn');
    const canceled = await bounded(communication.service.cancel(senderGrant, target, cancelTask.id));
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
    await bounded(communication.service.waitForSettledOperations());
    const later = await communication.service.send(senderGrant, target, SendMessageRequest.fromJSON({
      message: { messageId: 'after-cancel', parts: [{ text: 'farming peer integration peer-delay=3000' }] },
    }));
    const laterDeadline = Date.now() + 2000;
    let laterRunning = false;
    while (Date.now() < laterDeadline) {
      const journal = JSON.parse(await fs.readFile(path.join(root, 'agent-communications.json'), 'utf8'));
      const record = journal.records.find((item: { task: { id: string } }) => item.task.id === later.id);
      const operation = await facade.getPromptOperation(target, record.execution.requestId);
      if (operation?.status === 'provider-owned') { laterRunning = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(laterRunning, true, 'prove the newer turn is already running before canceling the old request');
    await assert.rejects(facade.cancelPrompt(target, cancelRequestId), /original running prompt/,
      'canceling the old request must not interrupt a subsequent turn');
    await bounded(communication.service.waitForSettledOperations());
    assert.equal((await communication.service.get(senderGrant, target, later.id)).status?.state, TaskState.TASK_STATE_COMPLETED);
    const failure = await communication.service.send(senderGrant, target, SendMessageRequest.fromJSON({
      message: { messageId: 'definitive-failure', parts: [{ text: 'farming peer integration peer-failure' }] },
    }));
    await bounded(communication.service.waitForSettledOperations());
    assert.equal((await communication.service.get(senderGrant, target, failure.id)).status?.state, TaskState.TASK_STATE_FAILED);

    await assert.rejects(manager.executePeerMessage({ agentId: target, sessionKey: 'replaced-session', requestId: 'new-request', text: command.text,
      source: { version: 1, direction: 'incoming', senderAddress: 'external:test-peer' },
    }), /no longer matches/);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { await manager.dispose(); }
    finally {
      facade.disconnect();
      try { await host.dispose(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  }
});

test('repeated Host disposal waits for the same checkpoint and runtime cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-disposal-'));
  const engine = new AcpRuntime({ configDir: root });
  const originalDispose = engine.dispose.bind(engine);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  engine.dispose = async () => { await blocked; await originalDispose(); };
  const host = new AcpRuntimeHostProcess({ configDir: root, socketPath: path.join(root, 'host.sock'), runtime: engine, exitOnShutdown: false });
  try {
    await host.start();
    const first = host.dispose(); const second = host.dispose();
    assert.equal(first, second, 'all callers must await the original in-flight cleanup');
    let completed = false; void second.then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    release(); await second; assert.equal(completed, true);
  } finally { release(); await host.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
