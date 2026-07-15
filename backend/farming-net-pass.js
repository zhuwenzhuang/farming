const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASS_QUERY_PARAM = 'farming_net_pass';
const PASS_SCOPE = 'farming:open';
const DEFAULT_PASS_TTL_SECONDS = 30;
const MAX_PASS_TTL_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

function normalizeAudience(value) {
  const audience = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(audience)) {
    throw new Error('Invalid Farming Net audience');
  }
  return audience;
}

function normalizeIssuerId(value) {
  const issuerId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(issuerId)) {
    throw new Error('Invalid Farming Net issuer id');
  }
  return issuerId;
}

function normalizeSubject(value) {
  const subject = String(value || 'owner').trim();
  if (!subject || subject.length > 80 || /[\x00-\x1f\x7f]/.test(subject)) {
    throw new Error('Invalid Farming Net subject');
  }
  return subject;
}

function safeTtlSeconds(value) {
  const ttl = Number(value);
  if (!Number.isInteger(ttl)) return DEFAULT_PASS_TTL_SECONDS;
  return Math.min(MAX_PASS_TTL_SECONDS, Math.max(5, ttl));
}

function publicKeyDetails(publicKeyPem) {
  const publicKey = publicKeyPem && typeof publicKeyPem === 'object' && publicKeyPem.type === 'public'
    ? publicKeyPem
    : crypto.createPublicKey(String(publicKeyPem || ''));
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Farming Net requires an Ed25519 public key');
  }
  const canonicalPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const issuer = `fnet_${crypto.createHash('sha256').update(der).digest('base64url').slice(0, 24)}`;
  return { canonicalPem, issuer, publicKey };
}

function privateKeyDetails(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(String(privateKeyPem || ''));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Farming Net requires an Ed25519 private key');
  }
  const canonicalPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicDetails = publicKeyDetails(crypto.createPublicKey(privateKey));
  return { canonicalPem, privateKey, publicDetails };
}

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, contents, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(tempFile, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // The rename already consumed the temporary file.
    }
  }
}

function loadOrCreateFarmingNetSigningIdentity(options = {}) {
  const privateKeyFile = options.privateKeyFile;
  const publicKeyFile = options.publicKeyFile;
  if (!privateKeyFile || !publicKeyFile) {
    throw new Error('Farming Net signing key paths are required');
  }

  let privateKeyPem = '';
  try {
    privateKeyPem = fs.readFileSync(privateKeyFile, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    const generated = crypto.generateKeyPairSync('ed25519');
    const generatedPem = generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    try {
      fs.mkdirSync(path.dirname(privateKeyFile), { recursive: true });
      fs.writeFileSync(privateKeyFile, generatedPem, { flag: 'wx', mode: 0o600 });
      privateKeyPem = generatedPem;
    } catch (writeError) {
      if (!writeError || writeError.code !== 'EEXIST') throw writeError;
      privateKeyPem = fs.readFileSync(privateKeyFile, 'utf8');
    }
  }

  const details = privateKeyDetails(privateKeyPem);
  fs.chmodSync(privateKeyFile, 0o600);
  writePrivateFile(publicKeyFile, details.publicDetails.canonicalPem);
  return {
    issuer: details.publicDetails.issuer,
    privateKey: details.privateKey,
    privateKeyFile,
    publicKey: details.publicDetails.publicKey,
    publicKeyFile,
    publicKeyPem: details.publicDetails.canonicalPem,
  };
}

function encodeJsonSegment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJsonSegment(segment) {
  if (typeof segment !== 'string' || segment.length < 2 || segment.length > 2048) {
    throw new Error('Invalid Farming Net pass segment');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Invalid Farming Net pass encoding');
  }
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Farming Net pass JSON');
  }
  return parsed;
}

function createFarmingNetPass(identity, options = {}) {
  if (!identity || !identity.privateKey || !identity.issuer) {
    throw new Error('Farming Net signing identity is required');
  }
  const audience = normalizeAudience(options.audience);
  const subject = normalizeSubject(options.subject);
  const nowSeconds = Math.floor(Number(options.nowMs ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error('Invalid Farming Net pass time');
  }
  const ttlSeconds = safeTtlSeconds(options.ttlSeconds);
  const header = {
    alg: 'EdDSA',
    kid: normalizeIssuerId(identity.issuer),
    typ: 'FarmingNetPass',
  };
  const payload = {
    aud: audience,
    exp: nowSeconds + ttlSeconds,
    iat: nowSeconds,
    iss: header.kid,
    jti: crypto.randomBytes(18).toString('base64url'),
    scope: PASS_SCOPE,
    sub: subject,
  };
  const signingInput = `${encodeJsonSegment(header)}.${encodeJsonSegment(payload)}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), identity.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function normalizeFarmingNetTrust(rawTrust) {
  if (!rawTrust || typeof rawTrust !== 'object' || Array.isArray(rawTrust)) {
    throw new Error('Invalid Farming Net trust document');
  }
  const audience = normalizeAudience(rawTrust.audience);
  const seenIssuers = new Set();
  const issuers = (Array.isArray(rawTrust.issuers) ? rawTrust.issuers : []).map(rawIssuer => {
    if (!rawIssuer || typeof rawIssuer !== 'object' || Array.isArray(rawIssuer)) {
      throw new Error('Invalid Farming Net trusted issuer');
    }
    const id = normalizeIssuerId(rawIssuer.id);
    const details = publicKeyDetails(rawIssuer.publicKey);
    if (details.issuer !== id) {
      throw new Error('Farming Net trusted issuer id does not match its public key');
    }
    if (seenIssuers.has(id)) throw new Error('Duplicate Farming Net trusted issuer');
    seenIssuers.add(id);
    return {
      id,
      name: String(rawIssuer.name || '').trim().slice(0, 80),
      publicKey: details.canonicalPem,
    };
  });
  if (issuers.length === 0 || issuers.length > 16) {
    throw new Error('Farming Net trust requires between 1 and 16 issuers');
  }
  return { version: 1, audience, issuers };
}

function writeFarmingNetTrust(filePath, trust) {
  const normalized = normalizeFarmingNetTrust(trust);
  writePrivateFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function loadFarmingNetTrust(filePath) {
  try {
    return normalizeFarmingNetTrust(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

class FarmingNetPassVerifier {
  constructor(options = {}) {
    this.trustFile = String(options.trustFile || '');
    this.seenPasses = new Map();
  }

  verify(pass, options = {}) {
    try {
      if (!this.trustFile) return { valid: false, reason: 'trust_not_configured' };
      const trust = loadFarmingNetTrust(this.trustFile);
      if (!trust) return { valid: false, reason: 'trust_not_configured' };
      if (typeof pass !== 'string' || pass.length < 32 || pass.length > 4096) {
        return { valid: false, reason: 'invalid_pass' };
      }
      const segments = pass.split('.');
      if (segments.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(segments[2])) {
        return { valid: false, reason: 'invalid_pass' };
      }
      const header = decodeJsonSegment(segments[0]);
      const payload = decodeJsonSegment(segments[1]);
      if (header.alg !== 'EdDSA' || header.typ !== 'FarmingNetPass') {
        return { valid: false, reason: 'invalid_header' };
      }
      const issuerId = normalizeIssuerId(header.kid);
      const issuer = trust.issuers.find(item => item.id === issuerId);
      if (!issuer || payload.iss !== issuerId) return { valid: false, reason: 'untrusted_issuer' };
      if (payload.aud !== trust.audience) return { valid: false, reason: 'wrong_audience' };
      if (payload.scope !== PASS_SCOPE) return { valid: false, reason: 'wrong_scope' };
      normalizeSubject(payload.sub);
      if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
        return { valid: false, reason: 'invalid_time' };
      }
      if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_PASS_TTL_SECONDS) {
        return { valid: false, reason: 'invalid_lifetime' };
      }
      const nowSeconds = Math.floor(Number(options.nowMs ?? Date.now()) / 1000);
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < payload.iat - CLOCK_SKEW_SECONDS) {
        return { valid: false, reason: 'not_yet_valid' };
      }
      if (nowSeconds >= payload.exp) return { valid: false, reason: 'expired' };
      if (typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti)) {
        return { valid: false, reason: 'invalid_jti' };
      }

      const publicKey = publicKeyDetails(issuer.publicKey).publicKey;
      const signature = Buffer.from(segments[2], 'base64url');
      const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii');
      if (!crypto.verify(null, signingInput, publicKey, signature)) {
        return { valid: false, reason: 'invalid_signature' };
      }

      for (const [key, expiresAt] of this.seenPasses) {
        if (expiresAt <= nowSeconds) this.seenPasses.delete(key);
      }
      const replayKey = `${issuerId}:${payload.jti}`;
      if (this.seenPasses.has(replayKey)) return { valid: false, reason: 'replayed' };
      this.seenPasses.set(replayKey, payload.exp);
      return { valid: true, payload };
    } catch {
      return { valid: false, reason: 'invalid_pass' };
    }
  }
}

module.exports = {
  CLOCK_SKEW_SECONDS,
  DEFAULT_PASS_TTL_SECONDS,
  FarmingNetPassVerifier,
  MAX_PASS_TTL_SECONDS,
  PASS_QUERY_PARAM,
  PASS_SCOPE,
  createFarmingNetPass,
  loadFarmingNetTrust,
  loadOrCreateFarmingNetSigningIdentity,
  normalizeFarmingNetTrust,
  writeFarmingNetTrust,
};
