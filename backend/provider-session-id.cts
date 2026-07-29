'use strict';

import * as crypto from 'crypto';

const TEMPORARY_PROVIDER_SESSION_ID_PREFIX = 'tmp_uuid';
const SAFE_PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

interface SafeProviderSessionIdOptions {
  allowTemporary?: boolean;
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(6).toString('hex'),
  ].join('-');
}

function createProviderSessionId(): string {
  return randomUuid();
}

function createTemporaryProviderSessionId(): string {
  return `${TEMPORARY_PROVIDER_SESSION_ID_PREFIX}_${randomUuid()}`;
}

function isTemporaryProviderSessionId(sessionId: unknown): boolean {
  return String(sessionId || '').trim().startsWith(TEMPORARY_PROVIDER_SESSION_ID_PREFIX);
}

function isSafeProviderSessionId(
  sessionId: unknown,
  options: SafeProviderSessionIdOptions = {},
): boolean {
  const value = String(sessionId || '').trim();
  if (value.startsWith('-')) return false;
  if (!SAFE_PROVIDER_SESSION_ID_RE.test(value)) return false;
  if (options.allowTemporary !== true && isTemporaryProviderSessionId(value)) return false;
  return true;
}

export {
  SAFE_PROVIDER_SESSION_ID_RE,
  TEMPORARY_PROVIDER_SESSION_ID_PREFIX,
  createProviderSessionId,
  createTemporaryProviderSessionId,
  isSafeProviderSessionId,
  isTemporaryProviderSessionId,
};
