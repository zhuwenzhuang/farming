import * as crypto from 'node:crypto';

const CAPABILITY_CREDENTIAL_BYTES = 32;
const CAPABILITY_CREDENTIAL_DIGEST_PREFIX = 'sha256:';

function capabilityCredentialDigest(token: unknown): string {
  const value = String(token || '').trim();
  if (!value) return '';
  return `${CAPABILITY_CREDENTIAL_DIGEST_PREFIX}${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')}`;
}

function createCapabilityCredential(): { digest: string; token: string } {
  const token = crypto.randomBytes(CAPABILITY_CREDENTIAL_BYTES).toString('base64url');
  return {
    digest: capabilityCredentialDigest(token),
    token,
  };
}

function verifyCapabilityCredential(token: unknown, expectedDigest: unknown): boolean {
  const actual = capabilityCredentialDigest(token);
  const expected = String(expectedDigest || '').trim();
  if (
    !actual.startsWith(CAPABILITY_CREDENTIAL_DIGEST_PREFIX)
    || !expected.startsWith(CAPABILITY_CREDENTIAL_DIGEST_PREFIX)
  ) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export {
  capabilityCredentialDigest,
  createCapabilityCredential,
  verifyCapabilityCredential,
};
