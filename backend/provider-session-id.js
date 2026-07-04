const crypto = require('crypto');

const TEMPORARY_PROVIDER_SESSION_ID_PREFIX = 'tmp_uuid';
const SAFE_PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

function randomUuid() {
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

function createProviderSessionId() {
  return randomUuid();
}

function createTemporaryProviderSessionId() {
  return `${TEMPORARY_PROVIDER_SESSION_ID_PREFIX}_${randomUuid()}`;
}

function isTemporaryProviderSessionId(sessionId) {
  return String(sessionId || '').trim().startsWith(TEMPORARY_PROVIDER_SESSION_ID_PREFIX);
}

function isSafeProviderSessionId(sessionId, options = {}) {
  const value = String(sessionId || '').trim();
  if (value.startsWith('-')) return false;
  if (!SAFE_PROVIDER_SESSION_ID_RE.test(value)) return false;
  if (options.allowTemporary !== true && isTemporaryProviderSessionId(value)) return false;
  return true;
}

module.exports = {
  SAFE_PROVIDER_SESSION_ID_RE,
  TEMPORARY_PROVIDER_SESSION_ID_PREFIX,
  createProviderSessionId,
  createTemporaryProviderSessionId,
  isSafeProviderSessionId,
  isTemporaryProviderSessionId,
};
