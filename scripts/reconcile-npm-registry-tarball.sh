#!/usr/bin/env bash
set -euo pipefail

# Reconciles one locally built npm tarball against the digest that a registry
# already publishes for the same package version, before any reuse/republish
# decision. A version slot occupied by different bytes is a visible conflict;
# uncertain registry evidence never becomes a silent reuse.
#
# Usage: reconcile-npm-registry-tarball.sh <tarball> <package@version> [--registry URL]
#
# Contract:
#   - dist.integrity must provide at least one sha512 SRI token, and one token
#     must exactly match the local tarball's sha512 (SRI fields may carry
#     several space-separated tokens).
#   - dist.shasum, when present, is cross-checked against the local sha1.
#   - the registry document must identify exactly the requested package/version.
#   - registry URLs must not embed credentials; NPM_TOKEN is sent as a bearer
#     token when set and is never printed.
#
# Exit codes:
#   0  the registry publishes a tarball with exactly the local digests
#   1  the registry publishes different bytes for this version (mismatch)
#   2  reconciliation is impossible (version absent, registry error, wrong
#      document, missing sha512 integrity, or invalid arguments)

TARBALL=""
PACKAGE_SPEC=""
REGISTRY="${npm_config_registry:-https://registry.npmjs.org/}"

usage() {
  echo "Usage: $0 <tarball> <package@version> [--registry URL]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry)
      if [ -z "${2:-}" ]; then usage; exit 2; fi
      REGISTRY="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *)
      if [ -z "${TARBALL}" ]; then
        TARBALL="$1"
      elif [ -z "${PACKAGE_SPEC}" ]; then
        PACKAGE_SPEC="$1"
      else
        usage; exit 2
      fi
      shift ;;
  esac
done

if [ -z "${TARBALL}" ] || [ -z "${PACKAGE_SPEC}" ]; then
  usage
  exit 2
fi
if [ ! -f "${TARBALL}" ]; then
  echo "Local npm tarball does not exist: ${TARBALL}" >&2
  exit 2
fi
if [[ "${REGISTRY}" != http://* ]] && [[ "${REGISTRY}" != https://* ]]; then
  echo "Registry must be an http(s) URL." >&2
  exit 2
fi

PACKAGE_NAME="${PACKAGE_SPEC%@*}"
PACKAGE_VERSION="${PACKAGE_SPEC##*@}"
if [ -z "${PACKAGE_NAME}" ] || [ -z "${PACKAGE_VERSION}" ] || [ "${PACKAGE_NAME}" = "${PACKAGE_SPEC}" ]; then
  echo "Package spec must be <name>@<version>: ${PACKAGE_SPEC}" >&2
  exit 2
fi

node - "${TARBALL}" "${PACKAGE_NAME}" "${PACKAGE_VERSION}" "${REGISTRY}" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');

const [tarballPath, packageName, packageVersion, registryInput] = process.argv.slice(2);
const registry = registryInput.endsWith('/') ? registryInput : `${registryInput}/`;

let registryUrl;
try {
  registryUrl = new URL(registry);
} catch {
  console.error('Registry must be a valid http(s) URL.');
  process.exit(2);
}
if (registryUrl.username !== '' || registryUrl.password !== '') {
  console.error(
    'Registry URL must not embed credentials; authenticate through NPM_TOKEN instead.',
  );
  process.exit(2);
}

const digestOf = (algorithm, encoding) => {
  const hash = crypto.createHash(algorithm);
  const fd = fs.openSync(tarballPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    while (bytesRead > 0) {
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest(encoding);
};

const localSha512 = `sha512-${digestOf('sha512', 'base64')}`;
const localSha1 = digestOf('sha1', 'hex');

/** SRI integrity may carry several space-separated tokens. */
function sha512Tokens(integrity) {
  return String(integrity || '')
    .split(/\s+/)
    .filter(token => token.startsWith('sha512-'));
}

async function main() {
  const encodedName = encodeURIComponent(packageName);
  const encodedVersion = encodeURIComponent(packageVersion);
  const url = new URL(`${encodedName}/${encodedVersion}`, registryUrl);
  const headers = { accept: 'application/json' };
  if (process.env.NPM_TOKEN) headers.authorization = `Bearer ${process.env.NPM_TOKEN}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    console.error(
      `Cannot reconcile ${packageName}@${packageVersion}: registry request failed: `
      + `${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
  if (response.status === 404) {
    console.error(`${packageName}@${packageVersion} is not published in ${registryUrl.origin}`);
    process.exit(2);
  }
  if (response.status !== 200) {
    console.error(
      `Cannot reconcile ${packageName}@${packageVersion}: registry returned HTTP ${response.status}`,
    );
    process.exit(2);
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    console.error(
      `Registry metadata for ${packageName}@${packageVersion} is not JSON: `
      + `${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
  const metadataName = metadata && typeof metadata === 'object' ? String(metadata.name || '') : '';
  const metadataVersion = metadata && typeof metadata === 'object' ? String(metadata.version || '') : '';
  if (metadataName !== packageName || metadataVersion !== packageVersion) {
    console.error(
      `Registry returned the wrong document for ${packageName}@${packageVersion}: `
      + `found ${metadataName || 'unknown'}@${metadataVersion || 'unknown'}; refusing to decide reuse.`,
    );
    process.exit(2);
  }
  const dist = metadata.dist;
  const integrityField = typeof dist?.integrity === 'string' ? dist.integrity.trim() : '';
  const registrySha512Tokens = sha512Tokens(integrityField);
  const registryShasum = typeof dist?.shasum === 'string' ? dist.shasum.trim().toLowerCase() : '';
  if (registrySha512Tokens.length === 0) {
    console.error(
      `Registry metadata for ${packageName}@${packageVersion} provides no sha512 dist.integrity `
      + 'token; refusing to decide reuse without the authoritative digest.',
    );
    process.exit(2);
  }
  const mismatches = [];
  if (!registrySha512Tokens.includes(localSha512)) {
    mismatches.push(`sha512 integrity: registry=${integrityField}, local=${localSha512}`);
  }
  if (registryShasum && registryShasum !== localSha1) {
    mismatches.push(`sha1 shasum: registry=${registryShasum}, local=${localSha1}`);
  }
  if (mismatches.length > 0) {
    console.error(
      `Registry already publishes DIFFERENT bytes for ${packageName}@${packageVersion}; `
      + `the local tarball must not be treated as the published artifact.\n  ${mismatches.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(
    `Registry tarball digest matches the local tarball for ${packageName}@${packageVersion}; `
    + 'reuse of the published version is safe.',
  );
}

main().catch((error) => {
  console.error(
    `Cannot reconcile ${packageName}@${packageVersion}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(2);
});
NODE
