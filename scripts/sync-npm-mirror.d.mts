export interface MirrorSyncReceipt {
  schemaVersion: number;
  packageName: string;
  version: string;
  gitHead: string;
  filename: string;
  bytes: number;
  sha256: string;
  integrity: string;
  shasum: string;
}

export interface MirrorSyncState {
  packageName: string;
  version: string;
  gitHead: string;
  selectedVersions?: string[];
  intentAt?: string;
  taskId?: string;
  taskUrl?: string;
  taskState?: string;
  status: 'requesting' | 'observing' | 'verified' | 'not-latest' | 'uncertain' | 'incomplete' | 'pending' | 'failed';
  reason: string;
  observedAt: string;
}

export function syncNpmMirror(
  receipt: MirrorSyncReceipt,
  candidateSha: string,
  journal: string,
  options?: {
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<MirrorSyncState>;
