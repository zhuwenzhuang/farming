import type { AgentManager } from './agent-manager.cjs';
import { AgentCommunicationCredentials, type CommunicationGrant } from './agent-communication-credentials.cjs';
import { AgentCommunicationService } from './agent-communication-service.cjs';

type CommunicationManager = Pick<AgentManager, 'resolveCommunicationAgent' | 'executePeerMessage' | 'reconcilePeerMessage'> & Partial<Pick<AgentManager, 'cancelPeerMessage'>>;

/** One instance owns credentials and the communication journal for one Config. */
export class AgentCommunicationRuntime {
  readonly credentials: AgentCommunicationCredentials;
  readonly service: AgentCommunicationService;
  private readonly tokens = new Map<string, Promise<string>>();
  private readonly manager: () => CommunicationManager;

  constructor(configDir: string, manager: () => CommunicationManager) {
    this.manager = manager;
    this.credentials = new AgentCommunicationCredentials(configDir);
    this.service = new AgentCommunicationService(configDir, {
      resolveTarget: (grant, agentId) => this.resolveTarget(grant, agentId),
      resolveSource: async grant => {
        const principal = grant.principal;
        if (principal.kind === 'external') return {
          version: 1, direction: 'incoming', senderAddress: `external:${principal.peerId}`, senderName: principal.name,
        };
        const source = this.manager().resolveCommunicationAgent(principal.agentId);
        return { version: 1, direction: 'incoming', senderAddress: `agent:${source.agentId}`, senderName: source.name, senderAgentId: source.agentId, senderSessionKey: source.sessionKey, ...(grant.initiatedBy ? { initiatedBy: grant.initiatedBy } : {}) };
      },
      cancel: async request => {
        const manager = this.manager();
        if (!manager.cancelPeerMessage) throw new Error('Cancellation is unavailable');
        await manager.cancelPeerMessage({ agentId: request.target.agentId, sessionKey: request.target.sessionKey, requestId: request.requestId });
      },
      reconcile: request => this.manager().reconcilePeerMessage({
        agentId: request.target.agentId, sessionKey: request.target.sessionKey,
        requestId: request.requestId, text: request.text,
        source: { ...request.source, senderTaskId: request.taskId, ...(request.replyToTaskId ? { inReplyToTaskId: request.replyToTaskId } : {}) },
      }),
      execute: request => this.manager().executePeerMessage({
        agentId: request.target.agentId, sessionKey: request.target.sessionKey,
        requestId: request.requestId, text: request.text,
        source: { ...request.source, senderTaskId: request.taskId, ...(request.replyToTaskId ? { inReplyToTaskId: request.replyToTaskId } : {}) },
      }),
    });
  }

  async resolveTarget(grant: CommunicationGrant, agentId: string) {
    if (grant.principal.kind === 'external' && !grant.targets.includes(agentId)) {
      throw new Error('Agent is not available to this peer');
    }
    if (grant.principal.kind === 'agent') this.manager().resolveCommunicationAgent(grant.principal.agentId);
    return this.manager().resolveCommunicationAgent(agentId);
  }

  async tokenForLaunch(agentId: string): Promise<string> {
    const existing = this.tokens.get(agentId);
    if (existing) {
      const token = await existing;
      if (await this.credentials.authenticate(token)) return token;
      if (this.tokens.get(agentId) === existing) this.tokens.delete(agentId);
      return this.tokenForLaunch(agentId);
    }
    const issuance = this.credentials.issue({ kind: 'agent', agentId }, [], Date.now() + 30 * 86400000)
      .then(issued => issued.token);
    this.tokens.set(agentId, issuance);
    try { return await issuance; }
    catch (error) {
      if (this.tokens.get(agentId) === issuance) this.tokens.delete(agentId);
      throw error;
    }
  }
}
