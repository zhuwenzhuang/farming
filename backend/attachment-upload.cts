import type { Dirent } from 'fs';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AttachmentKind = 'audio' | 'image';

interface AttachmentRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface AttachmentResponse {
  headersSent: boolean;
  writableEnded: boolean;
  json(value: unknown): AttachmentResponse;
  status(code: number): AttachmentResponse;
}

interface AttachmentFileOperations {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  readdir(directory: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  stat(filePath: string): Promise<{ mtimeMs: number }>;
  unlink(filePath: string): Promise<void>;
  writeFile(filePath: string, body: Buffer, options: { flag: 'wx' }): Promise<void>;
}

interface AttachmentUploadStoreOptions {
  attachmentsDir: string;
  fileOperations?: AttachmentFileOperations;
  now?: () => number;
  randomHex?: () => string;
  warn?: (message: string, error: unknown) => void;
  retentionMs?: number;
  gcIntervalMs?: number;
}

interface StoredAttachment {
  path: string;
  name: string;
  type: string;
  size: number;
}

interface AttachmentError extends Error {
  code?: string | number;
}

const ATTACHMENT_EXTENSIONS: Record<AttachmentKind, Record<string, string>> = {
  image: {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  },
  audio: {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/webm': 'webm',
    'audio/x-wav': 'wav',
  },
};

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000;
const ATTACHMENT_FILENAME_RE = /^pasted-(?:image|audio)-\d+-[a-f0-9]{8,64}\.(?:aac|flac|gif|jpg|m4a|mp3|ogg|png|wav|webm|webp)$/;
const MAX_FILENAME_ATTEMPTS = 5;

function processError(error: unknown): AttachmentError {
  return error instanceof Error ? error as AttachmentError : new Error(String(error));
}

function normalizedContentType(value: unknown): string {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function attachmentExtension(kind: AttachmentKind, contentType: string): string {
  return ATTACHMENT_EXTENSIONS[kind][normalizedContentType(contentType)] || '';
}

class AttachmentUploadStore {
  readonly attachmentsDir: string;
  private readonly fileOperations: AttachmentFileOperations;
  private readonly now: () => number;
  private readonly randomHex: () => string;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly retentionMs: number;
  private readonly gcIntervalMs: number;
  private lastGcAt = 0;

  constructor(options: AttachmentUploadStoreOptions) {
    this.attachmentsDir = options.attachmentsDir;
    this.fileOperations = options.fileOperations || fs.promises;
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || (() => crypto.randomBytes(4).toString('hex'));
    this.warn = options.warn || ((message, error) => console.warn(message, processError(error).message));
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.gcIntervalMs = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
  }

  async store(kind: AttachmentKind, contentType: string, body: Buffer): Promise<StoredAttachment> {
    const extension = attachmentExtension(kind, contentType);
    if (!extension) throw new Error(`Unsupported ${kind} attachment type`);
    await this.fileOperations.mkdir(this.attachmentsDir, { recursive: true });

    for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
      const filename = `pasted-${kind}-${this.now()}-${this.randomHex()}.${extension}`;
      const filePath = path.join(this.attachmentsDir, filename);
      try {
        await this.fileOperations.writeFile(filePath, body, { flag: 'wx' });
        return { path: filePath, name: filename, type: normalizedContentType(contentType), size: body.length };
      } catch (caught) {
        const error = processError(caught);
        if (error.code === 'EEXIST') continue;
        try {
          await this.fileOperations.unlink(filePath);
        } catch (unlinkCaught) {
          if (processError(unlinkCaught).code !== 'ENOENT') {
            this.warn(`Failed to remove incomplete ${kind} attachment:`, unlinkCaught);
          }
        }
        throw error;
      }
    }
    throw new Error(`Failed to allocate unique ${kind} attachment filename`);
  }

  async cleanupExpired(options: { force?: boolean } = {}): Promise<void> {
    const now = this.now();
    if (!options.force && now - this.lastGcAt < this.gcIntervalMs) return;
    this.lastGcAt = now;

    let entries: Dirent[];
    try {
      entries = await this.fileOperations.readdir(this.attachmentsDir, { withFileTypes: true });
    } catch (caught) {
      if (processError(caught).code !== 'ENOENT') this.warn('Failed to scan attachments:', caught);
      return;
    }

    const cutoff = now - this.retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !ATTACHMENT_FILENAME_RE.test(entry.name)) return;
      const filePath = path.join(this.attachmentsDir, entry.name);
      try {
        const stat = await this.fileOperations.stat(filePath);
        if (stat.mtimeMs < cutoff) await this.fileOperations.unlink(filePath);
      } catch (caught) {
        if (processError(caught).code !== 'ENOENT') this.warn('Failed to remove expired attachment:', caught);
      }
    }));
  }
}

function createAttachmentUploadHandler(options: {
  kind: AttachmentKind;
  store: AttachmentUploadStore;
  reportError?: (message: string, error: unknown) => void;
}) {
  const { kind, store } = options;
  const reportError = options.reportError || ((message, error) => console.error(message, processError(error).message));
  return async function attachmentUploadHandler(req: AttachmentRequest, res: AttachmentResponse): Promise<void> {
    const contentType = normalizedContentType(req.headers['content-type']);
    if (!attachmentExtension(kind, contentType)) {
      res.status(415).json({ error: `unsupported ${kind} type` });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: `empty ${kind} attachment` });
      return;
    }
    try {
      const stored = await store.store(kind, contentType, req.body);
      res.status(201).json(stored);
      void store.cleanupExpired().catch(error => reportError('Failed to clean expired attachments:', error));
    } catch (error) {
      reportError(`Failed to store ${kind} attachment:`, error);
      if (!res.headersSent && !res.writableEnded) {
        res.status(500).json({ error: `failed to store ${kind} attachment` });
      }
    }
  };
}

export {
  AttachmentUploadStore,
  attachmentExtension,
  createAttachmentUploadHandler,
  type AttachmentFileOperations,
  type AttachmentKind,
  type StoredAttachment,
};
