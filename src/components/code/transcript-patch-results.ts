import type {
  AgentTranscriptPatchChange,
  AgentTranscriptProcessItem,
} from './acp/acp-entry-projection'

export function isPatchResultItem(item: AgentTranscriptProcessItem) {
  return item.type === 'patch'
}

export function patchResultLines(item: AgentTranscriptProcessItem) {
  return String(item.detail || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('Success.'))
    .filter(isPatchResultLine)
    .slice(0, 16)
}

export function isPatchResultLine(line: string) {
  const trimmed = line.trim()
  return /^(add|added|delete|deleted|update|updated|move|moved|rename|renamed)\s+.+/i.test(trimmed) ||
    /^[AMDRC]\s+.+/.test(trimmed)
}

export function parsePatchResultLine(line: string) {
  const trimmed = line.trim()
  const gitStatusMatch = trimmed.match(/^([AMDRC])\s+(.+)$/)
  if (gitStatusMatch) {
    return {
      kind: gitStatusMatch[1] || '',
      path: gitStatusMatch[2] || trimmed,
      added: '',
      removed: '',
    }
  }
  const statsMatch = trimmed.match(/\s(\+\d+)(?:\s(-\d+))?$/)
  const added = statsMatch?.[1] || ''
  const removed = statsMatch?.[2] || ''
  const withoutStats = statsMatch ? trimmed.slice(0, statsMatch.index).trim() : trimmed
  const kindMatch = withoutStats.match(/^(add|added|delete|deleted|update|updated|move|moved|rename|renamed)\s+(.+)$/i)
  return {
    kind: kindMatch?.[1] || '',
    path: kindMatch?.[2] || withoutStats,
    added,
    removed,
  }
}

export type PatchResultRow = ReturnType<typeof parsePatchResultLine>

export function normalizeTranscriptPath(value: string) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim()
}

export function workspaceRelativeTranscriptPath(filePath: string, workspaceRoot?: string) {
  const normalizedPath = normalizeTranscriptPath(filePath)
  const normalizedRoot = normalizeTranscriptPath(workspaceRoot || '').replace(/\/+$/, '')
  if (!normalizedPath || !normalizedRoot) return normalizedPath
  const rootAliases = [normalizedRoot]
  if (normalizedRoot.startsWith('/private/')) rootAliases.push(normalizedRoot.slice('/private'.length))
  if (normalizedRoot.startsWith('/var/') || normalizedRoot.startsWith('/tmp/')) rootAliases.push(`/private${normalizedRoot}`)
  for (const root of rootAliases) {
    if (normalizedPath === root) return ''
    if (normalizedPath.startsWith(`${root}/`)) return normalizedPath.slice(root.length + 1)
  }
  return normalizedPath
}

export function patchRowDisplayPath(row: PatchResultRow, workspaceRoot?: string) {
  return workspaceRelativeTranscriptPath(row.path, workspaceRoot) || row.path
}

export function hasPatchStats(row: PatchResultRow) {
  return !!(row.added || row.removed)
}

export function mergePatchRows(rows: PatchResultRow[], workspaceRoot?: string) {
  const deduped: PatchResultRow[] = []
  const seen = new Map<string, number>()
  for (const row of rows) {
    const displayPath = patchRowDisplayPath(row, workspaceRoot)
    const key = displayPath || row.path
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, deduped.length)
      deduped.push({ ...row, path: displayPath || row.path })
      continue
    }
    const existing = deduped[existingIndex]
    if (!existing) continue
    if (hasPatchStats(row) || !hasPatchStats(existing)) {
      deduped[existingIndex] = { ...row, path: displayPath || row.path }
    }
  }
  return deduped
}

export function patchRowsForChanges(changes: AgentTranscriptPatchChange[], workspaceRoot?: string) {
  return mergePatchRows(changes.map(change => ({
    kind: change.kind,
    path: change.path,
    added: change.added > 0 ? `+${change.added}` : '',
    removed: change.removed > 0 ? `-${change.removed}` : '',
  })), workspaceRoot)
}

export function patchRowsForItems(items: AgentTranscriptProcessItem[], workspaceRoot?: string) {
  return mergePatchRows(
    items.flatMap(item => item.changes?.length
      ? patchRowsForChanges(item.changes)
      : patchResultLines(item).map(parsePatchResultLine)),
    workspaceRoot,
  )
}

export function patchRowsHaveUncommittedChanges(
  rows: PatchResultRow[],
  uncommittedPaths: ReadonlySet<string> | null,
  workspaceRoot?: string,
) {
  if (!uncommittedPaths) return false
  const patchPaths = new Set(rows.map(row => patchRowDisplayPath(row, workspaceRoot)))
  return [...uncommittedPaths].some(path => patchPaths.has(
    workspaceRelativeTranscriptPath(path, workspaceRoot) || normalizeTranscriptPath(path),
  ))
}

export function patchResultTitle(fileCount: number, failed: boolean) {
  if (failed) return fileCount === 1 ? 'Failed editing 1 file' : `Failed editing ${fileCount} files`
  return fileCount === 1 ? 'Edited 1 file' : `Edited ${fileCount} files`
}

export function patchResultSummary(fileCount: number, failed: boolean) {
  if (failed) return patchResultTitle(fileCount, failed)
  return fileCount === 1 ? '1 file changed' : `${fileCount} files changed`
}

export function patchDiffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added'
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('Index:') || line.startsWith('===')) return 'meta'
  return ''
}
