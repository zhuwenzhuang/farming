interface AcpSessionRevision {
  agentId: string;
  revision: number;
}

type AcpRevisionClientDelivery = 'defer' | 'send' | 'skip';

function acpRevisionClientDelivery(
  focusedAgentId: string | null | undefined,
  sentRevision: number | null | undefined,
  bufferedAmount: number,
  maxBufferedAmount: number,
  session: AcpSessionRevision,
): AcpRevisionClientDelivery {
  if (!focusedAgentId || focusedAgentId !== session.agentId) return 'skip';
  if (Number.isFinite(sentRevision) && session.revision <= Number(sentRevision)) return 'skip';
  return bufferedAmount > maxBufferedAmount ? 'defer' : 'send';
}

export {
  acpRevisionClientDelivery,
};

export type {
  AcpRevisionClientDelivery,
  AcpSessionRevision,
};
