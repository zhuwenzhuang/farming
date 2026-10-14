export interface RuntimePublicationOperations {
  readStatus(url: string): Promise<number>;
  upload(tarball: string, label: string): Promise<number>;
  observe(receiptFile: string, candidateSha: string, stateFile: string, resultFile: string | null): Promise<number>;
}

export function publishRuntimePackages(
  packageDirectory: string,
  evidenceDirectory: string,
  priorDirectory: string,
  candidateSha: string,
  dependencies?: RuntimePublicationOperations,
): Promise<string[]>;
