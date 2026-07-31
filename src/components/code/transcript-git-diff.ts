interface TranscriptGitComparisonSource {
  available?: boolean
  base: string
  head: string
}

interface TranscriptGitComparisonSources {
  commits: TranscriptGitComparisonSource[]
  staged: TranscriptGitComparisonSource & { available: boolean }
  unstaged: TranscriptGitComparisonSource & { available: boolean }
}

export type TranscriptGitDiffTarget =
  | { kind: 'unavailable' }
  | { kind: 'working-copy' }
  | { base: string; head: string; kind: 'last-commit' }

export const unavailableTranscriptGitDiffTarget: TranscriptGitDiffTarget = { kind: 'unavailable' }
export const workingCopyTranscriptGitDiffTarget: TranscriptGitDiffTarget = { kind: 'working-copy' }

export function transcriptGitDiffTargetForRepository(
  sources: TranscriptGitComparisonSources,
): TranscriptGitDiffTarget {
  if (sources.staged.available || sources.unstaged.available) {
    return workingCopyTranscriptGitDiffTarget
  }
  const latestCommit = sources.commits[0]
  return latestCommit
    ? { base: latestCommit.base, head: latestCommit.head, kind: 'last-commit' }
    : workingCopyTranscriptGitDiffTarget
}

export function transcriptGitDiffSearchParams(
  workspaceRoot: string,
  target: TranscriptGitDiffTarget,
) {
  const params = new URLSearchParams({ root: workspaceRoot })
  if (target.kind === 'last-commit') {
    params.set('base', target.base)
    params.set('head', target.head)
  }
  return params
}
