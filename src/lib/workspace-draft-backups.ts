import type { OpenWorkspaceFile } from './workspace-open-files'
import { workspaceOpenFileKey } from './workspace-open-files'

export interface WorkspaceDraftBackup {
  key: string
  agentId: string
  workspaceRoot?: string
  filePath: string
  baseSha1: string
  draft: string
  revision: number
  externalChanged: boolean
  updatedAt: number
}

interface WorkspaceDraftBackupStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const STORAGE_KEY = 'farming.workspaceDraftBackups.v1'
const MAX_BACKUPS = 32
const MAX_DRAFT_CHARACTERS = 1024 * 1024
const MAX_STORAGE_CHARACTERS = 2 * 1024 * 1024

function isWorkspaceDraftBackup(value: unknown): value is WorkspaceDraftBackup {
  if (!value || typeof value !== 'object') return false
  const backup = value as Partial<WorkspaceDraftBackup>
  return typeof backup.key === 'string' &&
    typeof backup.agentId === 'string' &&
    (backup.workspaceRoot === undefined || typeof backup.workspaceRoot === 'string') &&
    typeof backup.filePath === 'string' &&
    typeof backup.baseSha1 === 'string' &&
    typeof backup.draft === 'string' &&
    typeof backup.revision === 'number' &&
    Number.isFinite(backup.revision) &&
    typeof backup.externalChanged === 'boolean' &&
    typeof backup.updatedAt === 'number' &&
    Number.isFinite(backup.updatedAt)
}

export function createWorkspaceDraftBackup(
  file: OpenWorkspaceFile,
  updatedAt = Date.now()
): WorkspaceDraftBackup {
  return {
    key: workspaceOpenFileKey(file),
    agentId: file.agentId,
    ...(file.workspaceRoot !== undefined ? { workspaceRoot: file.workspaceRoot } : {}),
    filePath: file.file.path,
    baseSha1: file.file.sha1,
    draft: file.draft,
    revision: file.revision ?? 0,
    externalChanged: file.externalChanged,
    updatedAt,
  }
}

export function restoreWorkspaceOpenFileDraft(
  file: OpenWorkspaceFile,
  backup: WorkspaceDraftBackup
): OpenWorkspaceFile {
  if (backup.key !== workspaceOpenFileKey(file)) return file
  const dirty = backup.draft !== file.file.content
  return {
    ...file,
    draft: dirty ? backup.draft : file.file.content,
    dirty,
    revision: Math.max(file.revision ?? 0, backup.revision),
    externalChanged: dirty && (backup.externalChanged || backup.baseSha1 !== file.file.sha1),
    saving: false,
    saveRequestId: undefined,
    saveRevision: undefined,
    error: null,
    transient: false,
  }
}

export function loadWorkspaceDraftBackups(storage: WorkspaceDraftBackupStorage) {
  const backups = new Map<string, WorkspaceDraftBackup>()
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null') as {
      version?: unknown
      records?: unknown
    } | null
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return backups
    parsed.records.forEach(record => {
      if (isWorkspaceDraftBackup(record)) backups.set(record.key, record)
    })
  } catch {
    try {
      storage.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
  return backups
}

export function saveWorkspaceDraftBackups(
  storage: WorkspaceDraftBackupStorage,
  backups: ReadonlyMap<string, WorkspaceDraftBackup>
) {
  const records = Array.from(backups.values())
    .filter(backup => backup.draft.length <= MAX_DRAFT_CHARACTERS)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_BACKUPS)

  while (records.length > 0) {
    const payload = JSON.stringify({ version: 1, records })
    if (payload.length > MAX_STORAGE_CHARACTERS) {
      records.pop()
      continue
    }
    try {
      storage.setItem(STORAGE_KEY, payload)
      return
    } catch {
      records.pop()
    }
  }

  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
