#!/usr/bin/env bash
set -euo pipefail

# This is also served verbatim by the documentation site as /install.sh.
main() {
  [ "$#" -le 1 ] || { echo 'Usage: bash install.sh [--help]' >&2; return 1; }
  case "${1:-}" in
    '') ;;
    --help) printf '%s\n' 'Usage: bash install.sh [--help]' 'Installs Farming only. Start it separately with the Farming CLI.' 'Optional: FARMING_VERSION, FARMING_NPM_REGISTRY, FARMING_INSTALL_ROOT, FARMING_BIN_DIR'; return ;;
    *) echo "Unknown installer argument: $1" >&2; return 1 ;;
  esac
  local root="${FARMING_INSTALL_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/farming/app}"
  local bin_dir="${FARMING_BIN_DIR:-${HOME}/.local/bin}"
  case "${root}:${bin_dir}" in /*:/*) ;; *) echo 'Installation and bin directories must be absolute.' >&2; return 1 ;; esac
  local carrier
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) carrier=node-bin-darwin-arm64 ;;
    Darwin-x86_64) carrier=node-darwin-x64 ;;
    Linux-x86_64) carrier=node-linux-x64 ;;
    Linux-aarch64|Linux-arm64) carrier=node-linux-arm64 ;;
    *) echo 'Supported installer platforms: macOS and glibc Linux, x64 and arm64.' >&2; return 1 ;;
  esac
  local legacy=0 glibc minor
  if [ "$(uname -s)" = Linux ]; then
    glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    case "${glibc}" in
      'glibc 2.'*) minor="${glibc#glibc 2.}"; minor="${minor%%.*}" ;;
      *) echo 'This installer requires glibc Linux.' >&2; return 1 ;;
    esac
    if [ "${minor}" -lt 28 ]; then
      if [ "${minor}" -lt 17 ] || [ "${carrier}" != node-linux-x64 ]; then
        echo 'Required: glibc 2.28+, or glibc 2.17+ on Linux x64.' >&2; return 1
      fi
      legacy=1
    fi
  fi
  mkdir -p "$(dirname "${root}")" "${bin_dir}"
  local lock="${root}.install-lock" stage=''
  if ! mkdir "${lock}" 2>/dev/null; then
    echo "Another installation owns ${lock}. If its process has exited, remove that empty lock directory and retry." >&2
    return 1
  fi
  # Locals remain in scope until main returns; EXIT owns only this exact stage.
  trap 'test -z "${stage:-}" || rm -rf -- "${stage}"; rmdir -- "${lock}"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  local entry="${bin_dir}/farming"
  if [ -e "${entry}" ] || [ -L "${entry}" ]; then
    if [ ! -L "${entry}" ] || [ "$(readlink "${entry}")" != "${root}/farming" ]; then
      echo "${entry} already belongs to another installation. Choose FARMING_BIN_DIR or remove that entry yourself." >&2
      exit 1
    fi
  fi
  if [ -e "${root}" ]; then
    if [ ! -f "${root}/.farming-user-install-v1" ] || [ ! -x "${root}/farming" ]; then
      echo "Refusing to replace an unmanaged directory: ${root}" >&2; exit 1
    fi
    echo 'Farming is already installed. Use Settings → Updates to update it.'
  else
    local registry="${FARMING_NPM_REGISTRY:-${npm_config_registry:-}}"
    if [ -z "${registry}" ] && command -v npm >/dev/null 2>&1; then
      registry="$(npm config get registry 2>/dev/null || true)"
    fi
    registry="${registry:-https://registry.npmjs.org}"
    registry="${registry%/}"
    case "${registry}" in
      https://*|http://127.0.0.1:*|http://localhost:*) ;;
      *) echo 'FARMING_NPM_REGISTRY must be an HTTPS npm registry.' >&2; exit 1 ;;
    esac
    local missing='' command
    for command in curl tar gzip openssl sed tr mktemp chmod touch mv ln cat; do
      command -v "${command}" >/dev/null || missing="${missing} ${command}"
    done
    if [ -n "${missing}" ]; then
      echo "Missing basic tools:${missing}. Install these tools and run the installer again. Node.js and npm are downloaded automatically." >&2
      exit 1
    fi
    stage="$(mktemp -d "${root}.staging.XXXXXX")"
    local requested="${FARMING_VERSION:-latest}"
    case "${requested}" in *[!A-Za-z0-9.+-]*|'') echo 'Invalid FARMING_VERSION.' >&2; exit 1 ;; esac
    echo 'Downloading Farming from npm…'
    fetch_package farming-code "${requested}" "${stage}/farming"
    local node_version npm_version
    node_version="$(json_string "${carrier}" "${stage}/farming/package/package.json")"
    npm_version="$(json_string npm "${stage}/farming/package/package.json")"
    if ! [[ "${node_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${npm_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo 'This Farming version does not include the user-directory installer runtime. Select a release that supports it.' >&2
      exit 1
    fi
    echo "Preparing private Node.js ${node_version} and npm ${npm_version}…"
    fetch_package "${carrier}" "${node_version}" "${stage}/node"
    fetch_package npm "${npm_version}" "${stage}/npm"
    local node_bin="${stage}/node/package/bin/node"
    local loader="${stage}/farming/package/dist/runtime/glibc228/ld-2.28.so"
    local library_path="$(dirname "${loader}")"
    if [ "${legacy}" = 1 ] && [ ! -x "${loader}" ]; then
      echo 'This Farming package is missing its legacy Linux runtime.' >&2; exit 1
    fi
    # These variables are local to this process; npm scripts are disabled.
    local npm_cli="${stage}/npm/package/bin/npm-cli.js"
    local prefix="${stage}/installation"
    # Bootstrap downloads and later updates stay on the chosen filesystem,
    # even when HOME or the user's global npm cache is unavailable or full.
    local npm_config_cache="${prefix}/cache/npm"
    export npm_config_cache
    run_node "${npm_cli}" cache add "${stage}/node.tgz" --registry="${registry}" --ignore-scripts
    run_node "${npm_cli}" cache add "${stage}/npm.tgz" --registry="${registry}" --ignore-scripts
    run_node "${npm_cli}" install --global --prefix "${prefix}" "${stage}/farming.tgz" \
      --registry="${registry}" --ignore-scripts --include=optional --omit=dev --no-audit --no-fund
    local package_root="${prefix}/lib/node_modules/farming-code"
    # These pins are installer metadata, not optional application dependencies.
    # Reuse the verified bootstrap downloads instead of installing a second copy.
    mkdir -p "${package_root}/node_modules"
    mv "${stage}/node/package" "${package_root}/node_modules/${carrier}"
    mv "${stage}/npm/package" "${package_root}/node_modules/npm"
    chmod +x "${package_root}/bin/farming-node" "${package_root}/bin/farming-npm"
    "${package_root}/bin/farming-node" -e \
      'const path=require("path"); const root=process.argv[1]; require(path.join(root,"node_modules/node-pty")); require(path.join(root,"node_modules/npm/package.json")); console.log("Private Node.js and native PTY verified.")' "${package_root}"
    "${package_root}/bin/farming-node" "${package_root}/bin/farming" runtime prepare \
      --config-dir "${stage}/preflight-config" --no-activate
    cat > "${prefix}/farming" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
entry="$0"
while [ -L "${entry}" ]; do
  target="$(readlink "${entry}")"
  case "${target}" in /*) entry="${target}" ;; *) entry="$(dirname "${entry}")/${target}" ;; esac
done
root="$(cd "$(dirname "${entry}")" && pwd)"
package_root="${root}/lib/node_modules/farming-code"
registry="${FARMING_NPM_REGISTRY:-${npm_config_registry:-$(< "${root}/.farming-npm-registry")}}"
export FARMING_NPM_REGISTRY="${registry}" npm_config_registry="${registry}"
export npm_config_cache="${root}/cache/npm"
export FARMING_PACKAGE_INSTALLATIONS_DIR="${FARMING_PACKAGE_INSTALLATIONS_DIR:-${root}/packages}"
exec "${package_root}/bin/farming-node" "${package_root}/bin/farming" "$@"
LAUNCHER
    chmod +x "${prefix}/farming"
    printf '%s\n' "${registry}" > "${prefix}/.farming-npm-registry"
    chmod 600 "${prefix}/.farming-npm-registry"
    touch "${prefix}/.farming-user-install-v1"
    mv "${prefix}" "${root}"
  fi
  [ -L "${entry}" ] || ln -s "${root}/farming" "${entry}"
  echo "Installed: ${entry}"
  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *) printf 'For future terminals, add this directory to PATH: %s\n' "${bin_dir}" ;;
  esac
  printf '\nStart Farming:\n  %q daemon\n' "${entry}"
  # Execute cleanup while main's local variables are still in scope.
  test -z "${stage}" || rm -rf -- "${stage}"
  stage=''
  rmdir -- "${lock}"
  trap - EXIT INT TERM
}

json_string() {
  # The queried registry fields and pinned dependency names are unique string
  # properties. No returned JSON is evaluated as shell code.
  tr -d '\n\r' < "$2" | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p"
}

download() {
  curl --fail --silent --show-error --location --connect-timeout 20 --max-time 600 --retry 2 "$1" -o "$2"
}

fetch_package() {
  local name="$1" version="$2" destination="$3" url expected actual
  mkdir -p "${destination}"
  download "${registry}/${name}/${version}" "${destination}/metadata.json"
  url="$(json_string tarball "${destination}/metadata.json")"
  expected="$(json_string integrity "${destination}/metadata.json")"
  case "${url}" in https://registry.npmjs.org/*) url="${registry}/${url#https://registry.npmjs.org/}" ;; esac
  case "${url}" in https://*|http://127.0.0.1:*/*|http://localhost:*/*) ;; *) echo "Invalid npm tarball URL for ${name}." >&2; exit 1 ;; esac
  case "${expected}" in sha512-*) ;; *) echo "Missing SHA-512 npm integrity for ${name}." >&2; exit 1 ;; esac
  download "${url}" "${destination}.tgz"
  actual="sha512-$(openssl dgst -sha512 -binary "${destination}.tgz" | openssl base64 -A)"
  [ "${actual}" = "${expected}" ] || { echo "Integrity mismatch for ${name}; nothing installed." >&2; exit 1; }
  tar -xzf "${destination}.tgz" -C "${destination}"
  [ -f "${destination}/package/package.json" ] || { echo "Invalid package archive: ${name}" >&2; exit 1; }
}

run_node() {
  if [ "${legacy}" = 1 ]; then
    "${loader}" --library-path "${library_path}" "${node_bin}" "$@"
  else
    "${node_bin}" "$@"
  fi
}

main "$@"
