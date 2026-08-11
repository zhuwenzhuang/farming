/// <reference path="../../frontend/skins/crt/app-protocol.types.d.ts" />

import type {
  AgentActivityLevel,
  AgentLifecycleStatus,
  ProviderCapabilitiesWire,
  RuntimeObservationWire,
} from '../../shared/agent-state-wire.js';
import type {
  AgentStateCursor,
  AgentStateSnapshotPage,
  ClientMessage,
  ServerMessage,
} from '../../shared/browser-protocol.js';

type Assert<Condition extends true> = Condition;
type Exact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type ExpectedCrtClientMessageType =
  | 'protocol-hello'
  | 'start-agent'
  | 'input'
  | 'composer-input'
  | 'interrupt-agent'
  | 'clear-terminal'
  | 'watch-workspace-files'
  | 'archive-agent'
  | 'focus-agent'
  | 'resize-agent'
  | 'acp-permission-response'
  | 'state-resync';

type ExpectedCrtServerMessageType =
  | 'protocol-hello'
  | 'protocol-error'
  | 'error'
  | 'state'
  | 'state-delta'
  | 'agent-started'
  | 'agent-update'
  | 'agent-read'
  | 'acp-session-revision'
  | 'session-preview'
  | 'session-output'
  | 'agent-activity'
  | 'agent-activity-snapshot'
  | 'system-stats'
  | 'browser-resource-snapshot'
  | 'browser-resource-updated'
  | 'browser-resource-deleted'
  | 'computer-resource-snapshot'
  | 'computer-resource-updated'
  | 'computer-resource-deleted'
  | 'composer-input-result';

type _AgentStatusParity = Assert<Exact<CrtProtocolAgentStatus, AgentLifecycleStatus>>;
type _ActivityLevelParity = Assert<Exact<CrtProtocolActivityLevel, AgentActivityLevel>>;
type _ProviderCapabilitiesParity = Assert<Exact<
  Pick<CrtProtocolProviderCapabilities, keyof ProviderCapabilitiesWire>,
  ProviderCapabilitiesWire
>>;
type _RuntimeObservationParity = Assert<Exact<
  Pick<CrtProtocolRuntimeObservation, keyof RuntimeObservationWire>,
  RuntimeObservationWire
>>;
type _SnapshotCursorParity = Assert<Exact<
  Pick<CrtProtocolStateServerMessage, keyof AgentStateCursor>,
  AgentStateCursor
>>;
type _DeltaCursorParity = Assert<Exact<
  Pick<CrtProtocolStateDeltaServerMessage, keyof AgentStateCursor>,
  AgentStateCursor
>>;
type _SnapshotPageParity = Assert<Exact<
  NonNullable<CrtProtocolStateServerMessage['snapshot']>,
  AgentStateSnapshotPage
>>;
type _DeclaredClientMessagesAreStable = Assert<Exact<
  CrtProtocolDeclaredClientMessage['type'],
  ExpectedCrtClientMessageType
>>;
type _DeclaredClientMessagesAreCanonical = Assert<
  Exclude<CrtProtocolDeclaredClientMessage['type'], ClientMessage['type']> extends never ? true : false
>;
type _ConsumedClientMessagesRetainTheDeclaration = Assert<Exact<
  CrtWebSocketClientMessage['type'],
  CrtProtocolDeclaredClientMessage['type']
>>;
type _DeclaredServerMessagesAreStable = Assert<Exact<
  CrtProtocolDeclaredServerMessage['type'],
  ExpectedCrtServerMessageType
>>;
type _DeclaredServerMessagesAreCanonical = Assert<
  Exclude<CrtProtocolDeclaredServerMessage['type'], ServerMessage['type']> extends never ? true : false
>;
type _ConsumedServerMessagesRetainTheDeclaration = Assert<Exact<
  CrtWebSocketServerMessage['type'],
  CrtProtocolDeclaredServerMessage['type']
>>;

console.log('CRT protocol declarations stay assignable to canonical shared wire types');
