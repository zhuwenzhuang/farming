import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

interface SqliteStatementSync {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementSync;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { open?: boolean; readOnly?: boolean; timeout?: number }
  ) => SqliteDatabaseSync;
}

const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function loadNodeSqlite(): NodeSqliteModule | null {
  try {
    return require('node:sqlite') as NodeSqliteModule;
  } catch {
    return null;
  }
}

export function isSafeAgyConversationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CONVERSATION_ID_RE.test(value.trim());
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function encodeLengthDelimitedField(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeVarint(payload.length), payload]);
}

export function buildAgyTrajectoryMetadataBlob(
  conversationId: string,
  trajectoryId: string = crypto.randomUUID(),
  cwd?: string
): Buffer {
  const cidBuf = Buffer.from(conversationId, 'utf8');
  const tidBuf = Buffer.from(trajectoryId, 'utf8');
  const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmedCwd && path.isAbsolute(trimmedCwd)) {
    const normalizedPath = path.resolve(trimmedCwd);
    const fileUri = pathToFileURL(normalizedPath).href;
    const uriBuf = Buffer.from(fileUri, 'utf8');
    const workspaceEntry = Buffer.concat([
      encodeLengthDelimitedField(0x0a, uriBuf),
      Buffer.from([0x1a, 0x00])
    ]);
    return Buffer.concat([
      encodeLengthDelimitedField(0x0a, workspaceEntry),
      encodeLengthDelimitedField(0x1a, tidBuf),
      encodeLengthDelimitedField(0x32, cidBuf),
      encodeLengthDelimitedField(0x3a, uriBuf)
    ]);
  }
  return Buffer.concat([
    encodeLengthDelimitedField(0x1a, tidBuf),
    encodeLengthDelimitedField(0x32, cidBuf)
  ]);
}

/** Validate provider identity without repairing or creating historical data. */
export function hasAgyConversationDatabase(agyHomePath: string, conversationId: string): boolean {
  if (!isSafeAgyConversationId(conversationId)) return false;
  const sqlite = loadNodeSqlite();
  if (!sqlite) return false;
  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(path.join(agyHomePath, 'conversations', `${conversationId.trim()}.db`), { readOnly: true, timeout: 1000 });
    const row = db.prepare('SELECT cascade_id FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId.trim());
    return row?.cascade_id === conversationId.trim();
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Pre-initializes `<agyHomePath>/conversations/<conversationId>.db` with an empty
 * `trajectory_meta` record so `agy --conversation <conversationId>` starts a fresh
 * session with that exact UUID without emitting "not found, starting new conversation".
 */
export function ensureAgyConversationDatabase(
  agyHomePath: string,
  conversationId: string,
  cwd?: string
): boolean {
  const normalizedHome = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  const normalizedId = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!normalizedHome || !isSafeAgyConversationId(normalizedId)) return false;

  const sqlite = loadNodeSqlite();
  if (!sqlite) return false;

  const conversationsDir = path.join(normalizedHome, 'conversations');
  const dbPath = path.join(conversationsDir, `${normalizedId}.db`);
  if (fs.existsSync(dbPath)) {
    if (!hasAgyConversationDatabase(normalizedHome, normalizedId)) return false;
    let existingDb: SqliteDatabaseSync | null = null;
    try {
      existingDb = new sqlite.DatabaseSync(dbPath, { timeout: 1000 });
      existingDb.exec(
        'PRAGMA journal_mode = WAL;' +
        'PRAGMA user_version = 1;' +
        'DELETE FROM trajectory_meta WHERE trajectory_type = 0 AND EXISTS (SELECT 1 FROM trajectory_meta WHERE cascade_id = ' +
        `'${normalizedId.replace(/'/g, "''")}' AND trajectory_type != 0);`
      );
      const metaRow = existingDb
        .prepare('SELECT trajectory_id FROM trajectory_meta WHERE cascade_id = ? AND trajectory_type != 0 LIMIT 1')
        .get(normalizedId);
      const trajectoryId =
        typeof metaRow?.trajectory_id === 'string' && metaRow.trajectory_id.trim()
          ? metaRow.trajectory_id.trim()
          : crypto.randomUUID();
      const blobRow = existingDb
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
        .get();
      const existingBlob = blobRow?.data;
      const hasNonEmptyBlob =
        (existingBlob instanceof Uint8Array || Buffer.isBuffer(existingBlob)) &&
        existingBlob.byteLength > 0;
      if (!hasNonEmptyBlob) {
        const metadataBlob = buildAgyTrajectoryMetadataBlob(normalizedId, trajectoryId, cwd);
        existingDb
          .prepare("INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)")
          .run(metadataBlob);
      }
    } catch {
      // Ignore best-effort repair failures on read-only or locked DBs.
    } finally {
      try {
        existingDb?.close();
      } catch {
        // Ignore close errors.
      }
    }
    return true;
  }

  let db: SqliteDatabaseSync | null = null;
  try {
    fs.mkdirSync(conversationsDir, { recursive: true });
    db = new sqlite.DatabaseSync(dbPath);
    db.exec(
      'PRAGMA user_version = 1;' +
      'CREATE TABLE IF NOT EXISTS `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`));' +
      'CREATE TABLE IF NOT EXISTS `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));' +
      'CREATE INDEX IF NOT EXISTS `idx_steps_status` ON `steps`(`status`);' +
      'CREATE INDEX IF NOT EXISTS `idx_steps_step_type` ON `steps`(`step_type`);' +
      'CREATE TABLE IF NOT EXISTS `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));' +
      'CREATE TABLE IF NOT EXISTS `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));' +
      'CREATE TABLE IF NOT EXISTS `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));' +
      'CREATE TABLE IF NOT EXISTS `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`));' +
      'CREATE TABLE IF NOT EXISTS `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));'
    );
    const trajectoryId = crypto.randomUUID();
    const metadataBlob = buildAgyTrajectoryMetadataBlob(normalizedId, trajectoryId, cwd);
    db.prepare(
      'INSERT OR IGNORE INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 17)'
    ).run(trajectoryId, normalizedId);
    db.prepare(
      "INSERT OR IGNORE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)"
    ).run(metadataBlob);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export interface AgyConversationSummaryRow {
  conversationId: string;
  title: string | null;
  stepCount: number;
  updatedAtMs: number | null;
  cwd?: string | null;
}

function parseFirstWorkspaceUri(rawWorkspaceUris: unknown): string | null {
  if (typeof rawWorkspaceUris !== 'string' || !rawWorkspaceUris.trim()) return null;
  try {
    const parsed = JSON.parse(rawWorkspaceUris) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const trimmed = item.trim();
      if (trimmed.startsWith('file://')) {
        try {
          const url = new URL(trimmed);
          const decoded = decodeURIComponent(url.pathname);
          if (decoded) return decoded;
        } catch {
          const fallback = decodeURIComponent(trimmed.slice('file://'.length));
          if (fallback) return fallback;
        }
      } else if (path.isAbsolute(trimmed)) {
        return trimmed;
      }
    }
  } catch {
    // Ignore malformed workspace_uris JSON.
  }
  return null;
}

export function readAgyConversationSummaries(agyHomePath: string): Map<string, AgyConversationSummaryRow> {
  const result = new Map<string, AgyConversationSummaryRow>();
  const normalizedHome = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  if (!normalizedHome) return result;

  const summaryDbPath = path.join(normalizedHome, 'conversation_summaries.db');
  if (!fs.existsSync(summaryDbPath)) return result;

  const sqlite = loadNodeSqlite();
  if (!sqlite) return result;

  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(summaryDbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris FROM conversation_summaries'
        )
        .all();
      for (const row of rows) {
        const key = typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
        if (!isSafeAgyConversationId(key)) continue;
        const stepCount =
          typeof row.step_count === 'number' && Number.isFinite(row.step_count)
            ? row.step_count
            : 0;
        const cleanedTitle = cleanAgyUserInputText(row.title);
        const cleanedPreview = cleanAgyUserInputText(row.preview);
        const previewFirstLine = cleanedPreview
          ? cleanedPreview.split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
          : '';
        const title = cleanedTitle || previewFirstLine || null;
        const parsedTime =
          typeof row.last_modified_time === 'string' ? Date.parse(row.last_modified_time) : NaN;
        const updatedAtMs = Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : null;
        const cwd = parseFirstWorkspaceUri(row.workspace_uris);
        result.set(key, {
          conversationId: key,
          title,
          stepCount,
          updatedAtMs,
          cwd
        });
      }
    } catch {
      // Table conversation_summaries may not exist in synthetic test fixtures.
    }

    try {
      const rows = db
        .prepare('SELECT key, step_count, summary_blob FROM trajectory_summaries')
        .all();
      for (const row of rows) {
        const key = typeof row.key === 'string' ? row.key.trim() : '';
        if (!isSafeAgyConversationId(key) || result.has(key)) continue;
        const stepCount = typeof row.step_count === 'number' && Number.isFinite(row.step_count)
          ? row.step_count
          : 0;
        let title: string | null = null;
        const blob = row.summary_blob;
        if (blob instanceof Uint8Array || Buffer.isBuffer(blob)) {
          const buf = Buffer.from(blob);
          if (buf.length >= 2 && buf[0] === 0x0a) {
            const titleLen = buf[1];
            if (buf.length >= 2 + titleLen && titleLen > 0) {
              const candidate = buf.subarray(2, 2 + titleLen).toString('utf8').trim();
              if (candidate && !candidate.startsWith('1.0:')) {
                title = candidate;
              }
            }
          }
        }
        result.set(key, {
          conversationId: key,
          title,
          stepCount,
          updatedAtMs: null,
          cwd: null
        });
      }
    } catch {
      // Table trajectory_summaries may not exist in real agy 1.3.5 DBs.
    }
  } catch {
    // Ignore corrupt or locked summary DB and fall back to transcript scanning.
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
  return result;
}

export function readAgyConversationStepCount(dbPath: string): number | null {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const sqlite = loadNodeSqlite();
  if (!sqlite) return null;
  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS step_count FROM steps').get();
      if (row && typeof row.step_count === 'number' && Number.isFinite(row.step_count)) {
        return row.step_count;
      }
    } catch {
      // Fall back to legacy/synthetic trajectory_meta.step_count column.
    }
    const legacyRow = db.prepare('SELECT step_count FROM trajectory_meta LIMIT 1').get();
    if (
      legacyRow &&
      typeof legacyRow.step_count === 'number' &&
      Number.isFinite(legacyRow.step_count)
    ) {
      return legacyRow.step_count;
    }
    return 0;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

// Capture the persisted boundary before admitting a turn. Missing evidence must
// never allow a previous completed turn to override a new provider error.
export function readAgyLatestUserStepIndex(agyHomePath: string, conversationId: string): number | null {
  if (!agyHomePath.trim() || !isSafeAgyConversationId(conversationId)) return null;
  const sqlite = loadNodeSqlite();
  if (!sqlite) return null;
  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(path.join(agyHomePath, 'conversations', `${conversationId}.db`), { readOnly: true });
    const row = db.prepare('SELECT MAX(idx) AS max_idx FROM steps WHERE step_type = 14').get();
    return row?.max_idx === null ? -1 : typeof row?.max_idx === 'number' ? row.max_idx : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* Ignore close errors. */ }
  }
}

export function didAgyCurrentTurnCompleteCleanly(
  agyHomePath: string,
  conversationId: string,
  previousUserStepIndex: number | null
): boolean {
  if (previousUserStepIndex === null) return false;
  const normalizedHome = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  const normalizedId = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!normalizedHome || !isSafeAgyConversationId(normalizedId)) return false;

  const dbPath = path.join(normalizedHome, 'conversations', `${normalizedId}.db`);
  if (!fs.existsSync(dbPath)) return false;

  const sqlite = loadNodeSqlite();
  if (!sqlite) return false;

  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const latestUserRow = db
      .prepare('SELECT MAX(idx) AS max_idx FROM steps WHERE step_type = 14')
      .get() as { max_idx?: number | null } | undefined;
    const latestUserIdx =
      typeof latestUserRow?.max_idx === 'number' && Number.isFinite(latestUserRow.max_idx)
        ? latestUserRow.max_idx
        : -1;
    if (latestUserIdx < 0 || latestUserIdx <= previousUserStepIndex) return false;

    const turnSteps = db
      .prepare('SELECT idx, step_type, status FROM steps WHERE idx > ? ORDER BY idx ASC')
      .all(latestUserIdx) as Array<{ idx?: number; step_type?: number; status?: number }>;
    if (!Array.isArray(turnSteps) || turnSteps.length === 0) return false;

    let lastCompletedPlannerResponseIndex = -1;
    for (let index = 0; index < turnSteps.length; index += 1) {
      const step = turnSteps[index];
      const stepType = typeof step.step_type === 'number' ? step.step_type : 0;
      const status = typeof step.status === 'number' ? step.status : 0;
      if (stepType === 15 && status === 3) {
        lastCompletedPlannerResponseIndex = index;
      }
    }
    if (lastCompletedPlannerResponseIndex < 0) return false;

    for (let index = lastCompletedPlannerResponseIndex + 1; index < turnSteps.length; index += 1) {
      const step = turnSteps[index];
      const stepType = typeof step.step_type === 'number' ? step.step_type : 0;
      const status = typeof step.status === 'number' ? step.status : 0;
      // step_type 17 is CORTEX_STEP_TYPE_ERROR_MESSAGE; status 7 is ERROR (except tool step 132 which model can recover from).
      if (stepType === 17) return false;
      if (status === 7 && stepType !== 132) return false;
    }
    const lastStep = turnSteps[turnSteps.length - 1];
    return lastStep?.status === 3;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export function readAgyConversationWorkspace(
  agyHomePath: string,
  conversationId: string
): string | null {
  const normalizedHome = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  const normalizedId = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!normalizedHome || !isSafeAgyConversationId(normalizedId)) return null;

  const dbPath = path.join(normalizedHome, 'conversations', `${normalizedId}.db`);
  if (!fs.existsSync(dbPath)) return null;

  const sqlite = loadNodeSqlite();
  if (!sqlite) return null;

  let db: SqliteDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    let blob: unknown = null;
    try {
      const row = db
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
        .get();
      blob = row?.data;
    } catch {
      // Fall back to legacy trajectory_meta.metadata_blob if present.
    }
    if (!blob) {
      try {
        const legacy = db.prepare('SELECT metadata_blob FROM trajectory_meta LIMIT 1').get();
        blob = legacy?.metadata_blob;
      } catch {
        // Ignore missing table/column.
      }
    }
    if (blob instanceof Uint8Array || Buffer.isBuffer(blob)) {
      const text = Buffer.from(blob).toString('utf8');
      const match = text.match(/file:\/\/\/[^\x00-\x1f"'\s<>]+/);
      if (match) {
        try {
          const url = new URL(match[0]);
          const decoded = decodeURIComponent(url.pathname);
          if (decoded && path.isAbsolute(decoded)) return decoded;
        } catch {
          const fallback = decodeURIComponent(match[0].slice('file://'.length));
          if (fallback && path.isAbsolute(fallback)) return fallback;
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export function unquoteAgyScalar(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function normalizeAgyToolArgs(
  rawArgs: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!rawArgs || typeof rawArgs !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rawArgs)) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        trimmed === 'true' ||
        trimmed === 'false' ||
        /^-?\d+(?:\.\d+)?$/.test(trimmed)
      ) {
        try {
          result[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Keep original string if JSON.parse fails.
        }
      }
    }
    result[key] = val;
  }
  return result;
}

export function cleanAgyUserInputText(raw: unknown, injectedPrompt = ''): string {
  if (typeof raw !== 'string') return '';
  let text = raw;
  const userReqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (userReqMatch) {
    text = userReqMatch[1];
  }
  // Older adapters prepended the configured instructions without a delimiter.
  // Remove only that exact leading payload, never a quoted occurrence in input.
  const prefix = injectedPrompt.trim();
  if (prefix && text.startsWith(`${prefix}\n\n`)) text = text.slice(prefix.length + 2);
  text = text.replace(/<farming-agent-context>[\s\S]*?<\/farming-agent-context>/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  text = text.replace(
    /(?:^|\r?\n)*Attached (?:image|audio):[^\r\n]*(?:(?:\r?\n)+(?:Image|Audio) path:[^\r\n]*)?/gi,
    ''
  );
  text = text.replace(/^(?:Image|Audio) path:[^\r\n]*$/gim, '');
  return text.trim();
}

export function agyExplicitHomeCliArgs(agyHomePath: string | null | undefined): string[] {
  const trimmed = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  if (!trimmed) return [];
  const resolved = path.resolve(trimmed);
  return ['--gemini_dir', path.dirname(resolved), '--app_data_dir', path.basename(resolved)];
}

export function agyHomeCliArgs(
  agyHomePath: string | null | undefined,
  defaultHomeRoot: string = os.homedir()
): string[] {
  const trimmed = typeof agyHomePath === 'string' ? agyHomePath.trim() : '';
  if (!trimmed) return [];
  const resolved = path.resolve(trimmed);
  const defaultResolved = path.resolve(defaultHomeRoot, '.gemini', 'antigravity');
  if (resolved === defaultResolved) return [];
  return agyExplicitHomeCliArgs(resolved);
}
