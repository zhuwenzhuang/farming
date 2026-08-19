interface AcpSessionRevision {
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
  revision: number;
}

type AcpRevisionClientDelivery = 'defer' | 'send' | 'skip';

function acpRevisionClientDelivery(
  interested: boolean,
  sentCursor: AcpSessionRevision | null | undefined,
  bufferedAmount: number,
  maxBufferedAmount: number,
  session: AcpSessionRevision,
): AcpRevisionClientDelivery {
  if (!interested) return 'skip';
  if (
    sentCursor
    && sentCursor.sessionId === session.sessionId
    && sentCursor.runtimeEpoch === session.runtimeEpoch
    && session.revision <= sentCursor.revision
  ) return 'skip';
  return bufferedAmount > maxBufferedAmount ? 'defer' : 'send';
}

export {
  acpRevisionClientDelivery,
};

export type {
  AcpRevisionClientDelivery,
  AcpSessionRevision,
};
