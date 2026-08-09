import {
  normalizeAgentActivityScope,
} from './agent-activity-delivery.cjs';
import {
  agentStateScopeTransition,
  normalizeAgentStateScope,
} from './agent-state-broadcast-protocol.cjs';
import {
  normalizeSessionPreviewScope,
  sessionPreviewScopeCheckpointRequired,
} from './session-preview-delivery.cjs';
import type { FocusAgentMessage } from '../shared/browser-protocol.js';

interface WebSocketFocusScopeClient {
  acpRevisionCheckpointPending?: boolean;
  acpRevisionSentRevision?: number;
  activityScope?: 'all' | 'focused' | 'none';
  activityScopeDeclared?: boolean;
  agentActivityAllCheckpointPending?: boolean;
  agentActivityCheckpointPending?: boolean;
  agentActivityResyncPending?: boolean;
  focusedAgentId?: string | null;
  previewScope?: 'none' | 'focused' | 'all';
  previewScopeDeclared?: boolean;
  stateScope?: 'all' | 'focused';
  stateSnapshotInProgress?: boolean;
  streamScope?: 'focused' | 'all';
}

type WebSocketFocusScopeMessage = FocusAgentMessage & {
  refreshState?: boolean;
  streamScope?: 'focused' | 'all';
};

interface WebSocketFocusScopePorts<Client extends WebSocketFocusScopeClient = WebSocketFocusScopeClient> {
  declarePreviewScope(client: Client): boolean;
  prioritizeTranscript(agentId: string): void;
  sendAcpRevision(client: Client, agentId: string): void;
  sendFocusedActivity(client: Client, agentId: string): void;
  sendState(client: Client): void;
  sendAllActivitySnapshot(client: Client): void;
  sendPreviewHydration(client: Client): void;
}

function createWebSocketFocusScopeHandlers<Client extends WebSocketFocusScopeClient>(
  ports: WebSocketFocusScopePorts<Client>,
) {
  const stateResync = (client: Client) => {
    ports.sendState(client);
  };

  const focusAgent = (client: Client, data: WebSocketFocusScopeMessage) => {
    const previousActivityScope = normalizeAgentActivityScope(client.activityScope);
    const nextActivityScope = normalizeAgentActivityScope(data.activityScope ?? previousActivityScope);
    const previousStateScope = normalizeAgentStateScope(client.stateScope);
    const previousPreviewScope = normalizeSessionPreviewScope(client.previewScope);
    const nextPreviewScope = normalizeSessionPreviewScope(data.previewScope ?? previousPreviewScope);
    const previewScopeDeclared = Object.prototype.hasOwnProperty.call(data, 'previewScope');
    const initialPreviewHydrationPending = previewScopeDeclared
      ? ports.declarePreviewScope(client)
      : false;
    const previousFocusedAgentId = client.focusedAgentId;
    const focusChanged = previousFocusedAgentId !== data.agentId;
    const scopeChanged = previousActivityScope !== nextActivityScope;
    const stateScopeTransition = agentStateScopeTransition(
      previousStateScope,
      previousFocusedAgentId,
      normalizeAgentStateScope(data.stateScope ?? previousStateScope),
      data.agentId,
    );
    const previewCheckpointRequired = sessionPreviewScopeCheckpointRequired(
      previousPreviewScope,
      previousFocusedAgentId,
      nextPreviewScope,
      data.agentId,
    );
    if (Object.prototype.hasOwnProperty.call(data, 'activityScope')) {
      client.activityScopeDeclared = true;
    }
    if (scopeChanged) {
      if (client.agentActivityAllCheckpointPending || client.agentActivityCheckpointPending) {
        client.agentActivityResyncPending = true;
      }
      client.agentActivityAllCheckpointPending = false;
      client.agentActivityCheckpointPending = false;
    } else if (focusChanged && client.agentActivityCheckpointPending) {
      client.agentActivityResyncPending = true;
      client.agentActivityCheckpointPending = false;
    }
    const activitySnapshotRequired = nextActivityScope === 'all'
      && scopeChanged
      && client.activityScopeDeclared === true
      && client.agentActivityResyncPending === true;
    if (focusChanged) {
      client.acpRevisionCheckpointPending = false;
      client.acpRevisionSentRevision = -1;
    }
    client.focusedAgentId = data.agentId;
    client.activityScope = nextActivityScope;
    client.previewScope = nextPreviewScope;
    client.stateScope = stateScopeTransition.scope;
    if (data.agentId) {
      ports.prioritizeTranscript(data.agentId);
      ports.sendAcpRevision(client, data.agentId);
      if (nextActivityScope === 'focused') ports.sendFocusedActivity(client, data.agentId);
    }
    if (data.streamScope === 'focused' || data.streamScope === 'all') {
      client.streamScope = data.streamScope;
    }
    const stateSnapshotRequired = data.refreshState === true
      || stateScopeTransition.snapshotRequired
      || (
        client.stateSnapshotInProgress === true
        && previousStateScope !== stateScopeTransition.scope
      );
    if (stateSnapshotRequired) {
      // State scope checkpoints the Agent projection. Activity and Preview
      // retain their independent recovery paths around the snapshot barrier.
      ports.sendState(client);
    } else {
      if (activitySnapshotRequired) ports.sendAllActivitySnapshot(client);
      if (
        !client.stateSnapshotInProgress
        && (initialPreviewHydrationPending || previewCheckpointRequired)
      ) ports.sendPreviewHydration(client);
    }
  };

  return { focusAgent, stateResync };
}

export { createWebSocketFocusScopeHandlers };
export type { WebSocketFocusScopeClient, WebSocketFocusScopeMessage, WebSocketFocusScopePorts };
