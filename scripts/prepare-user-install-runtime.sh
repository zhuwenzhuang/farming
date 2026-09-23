#!/usr/bin/env bash
set -euo pipefail

# Release preparation only. End users obtain this runtime inside the npm image.
root="$(cd "$(dirname "$0")/.." && pwd)"
destination="${1:-${root}}/dist/runtime/glibc228"
archive="${FARMING_GLIBC_RUNTIME_BUNDLE:-${FARMING_GLIBC_RUNTIME_CACHE:-}}"
expected=eaf615e3d72b096bc603476a481730e39b5e01e47dc874ae05e535be1bc7fb89
source_ref=ba989d6b879b75bc3a823b53e684cdd3ab1bdbcd
temporary="$(mktemp -d)"
trap 'chmod -R u+rwX "${temporary}"; rm -rf -- "${temporary}"' EXIT
if [ -z "${archive}" ]; then
  archive="${temporary}/lib.tgz"
  curl -fsSL --connect-timeout 20 --max-time 300 --retry 2 \
    "https://raw.githubusercontent.com/liuliping0315/glibc2.28_for_CentOS7/${source_ref}/lib.tgz" -o "${archive}"
fi
actual="$(openssl dgst -sha256 "${archive}" | awk '{print $NF}')"
[ "${actual}" = "${expected}" ] || { echo 'Private glibc runtime integrity mismatch.' >&2; exit 1; }
mkdir "${temporary}/extracted"
tar -xzf "${archive}" -C "${temporary}/extracted"
chmod -R u+rwX "${temporary}/extracted"
loader="$(find "${temporary}/extracted" -type f -name ld-2.28.so -print)"
[ -n "${loader}" ] && [ -f "${loader}" ] || { echo 'Private glibc loader is missing or ambiguous.' >&2; exit 1; }
mkdir -p "$(dirname "${destination}")"
rm -rf -- "${destination}"
mkdir -p "${destination}"
# npm excludes symlinks. Copy each loader/SONAME as a regular file, omitting
# static archives and duplicate versioned targets that are not runtime entries.
node - "$(dirname "${loader}")" "${destination}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [source, destination] = process.argv.slice(2);
for (const name of fs.readdirSync(source)) {
  if (name !== 'ld-2.28.so' && !/\.so\.[0-9]+$/.test(name)) continue;
  const target = path.join(destination, name);
  fs.copyFileSync(path.join(source, name), target);
  fs.chmodSync(target, 0o755);
}
for (const name of ['ld-2.28.so', 'libc.so.6', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']) {
  if (!fs.lstatSync(path.join(destination, name)).isFile()) throw new Error(`Missing runtime file: ${name}`);
}
NODE
cp "${root}/backend/data/LICENSE.glibc" "${destination}/LICENSE.glibc"
cp "${root}/backend/data/LICENSE.gcc" "${destination}/LICENSE.gcc"
cp "${root}/backend/data/LICENSE.gcc-runtime" "${destination}/LICENSE.gcc-runtime"
printf '%s\n' \
  'GNU C Library 2.28 compatibility runtime (LGPL-2.1-or-later).' \
  'Includes GCC runtime libraries (GPL-3.0 with the GCC Runtime Library Exception).' \
  "Carrier: https://github.com/liuliping0315/glibc2.28_for_CentOS7/tree/${source_ref}" \
  'Upstream source and license: https://ftp.gnu.org/gnu/glibc/glibc-2.28.tar.xz' \
  "Carrier SHA-256: ${expected}" > "${destination}/NOTICE"
