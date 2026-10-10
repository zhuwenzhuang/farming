#!/usr/bin/env bash
set -euo pipefail

# Served verbatim as /farming_install.sh; /install.sh remains a compatible URL.
main() {
  local root="${FARMING_INSTALL_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/farming/app}"
  local mirror='' directory_set=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help)
        [ "$#" = 1 ] && [ "${directory_set}" = 0 ] && [ -z "${mirror}" ] || { echo 'Use --help on its own.' >&2; return 1; }
        printf '%s\n' 'Usage: bash farming_install.sh [--dir DIRECTORY] [--mirror cn]' '       bash farming_install.sh --help' 'Installs Farming only. Start it separately with the Farming CLI.' '--dir selects an absolute installation directory and overrides FARMING_INSTALL_ROOT.' '--mirror cn uses npmmirror downloads with official npm versions and integrity checks.' 'Optional: FARMING_VERSION, FARMING_NPM_REGISTRY, FARMING_INSTALL_ROOT, FARMING_BIN_DIR'
        return ;;
      --dir)
        [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${directory_set}" = 0 ] || { echo 'Usage: --dir DIRECTORY (once)' >&2; return 1; }
        root="$2"; directory_set=1; shift 2 ;;
      --mirror)
        [ "$#" -ge 2 ] && [ "$2" = cn ] && [ -z "${mirror}" ] || { echo 'Usage: --mirror cn (once)' >&2; return 1; }
        mirror=cn; shift 2 ;;
      *) echo "Unknown installer argument: $1" >&2; return 1 ;;
    esac
  done
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
  # EXIT may run after errexit has unwound main; these cleanup identities must
  # outlive its local scope.
  lock="${root}.install-lock"
  stage=''
  download_pids=()
  progress_rows=0
  progress_tty=0
  if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then progress_tty=1; fi
  if ! mkdir "${lock}" 2>/dev/null; then
    echo "Another installation owns ${lock}. If its process has exited, remove that empty lock directory and retry." >&2
    return 1
  fi
  # Locals remain in scope until main returns; EXIT owns only this exact stage.
  trap cleanup_install EXIT
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
    local metadata_registry="${registry}"
    if [ "${mirror}" = cn ]; then
      registry=https://registry.npmmirror.com
      metadata_registry=https://registry.npmjs.org
      progress_message 36 'China mirror · npmmirror downloads · official npm versions and SHA-512'
    fi
    case "${registry}" in
      https://*|http://127.0.0.1:*|http://localhost:*) ;;
      *) echo 'FARMING_NPM_REGISTRY must be an HTTPS npm registry.' >&2; exit 1 ;;
    esac
    local missing='' command
    for command in curl tar gzip sed tr mktemp chmod touch mv ln cat sleep tail; do
      command -v "${command}" >/dev/null || missing="${missing} ${command}"
    done
    if [ -n "${missing}" ]; then
      echo "Missing basic tools:${missing}. Install these tools and run the installer again. Node.js and npm are downloaded automatically." >&2
      exit 1
    fi
    local integrity_tool
    integrity_tool="$(select_integrity_tool)"
    stage="$(mktemp -d "${root}.staging.XXXXXX")"
    local requested="${FARMING_VERSION:-latest}"
    case "${requested}" in *[!A-Za-z0-9.+-]*|'') echo 'Invalid FARMING_VERSION.' >&2; exit 1 ;; esac
    progress_message 36 'Preparing Farming installation'
    fetch_package farming-code "${requested}" "${stage}/farming"
    local node_version npm_version runtime_version runtime_alias runtime_platform
    node_version="$(json_string "${carrier}" "${stage}/farming/package/package.json")"
    npm_version="$(json_string npm "${stage}/farming/package/package.json")"
    if ! [[ "${node_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${npm_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo 'This Farming version does not include the user-directory installer runtime. Select a release that supports it.' >&2
      exit 1
    fi
    runtime_platform="${carrier#node-}"
    [ "${carrier}" != node-bin-darwin-arm64 ] || runtime_platform=darwin-arm64
    runtime_alias="$(json_string "farming-code-runtime-${runtime_platform}" "${stage}/farming/package/package.json")"
    runtime_version=''
    case "${runtime_alias}" in
      npm:farming-code@*) runtime_version="${runtime_alias#npm:farming-code@}" ;;
      '') ;;
      *) echo 'Invalid Farming runtime package pin.' >&2; exit 1 ;;
    esac
    echo "Preparing private Node.js ${node_version} and npm ${npm_version}…"
    fetch_runtime_packages
    local node_bin="${stage}/node/package/bin/node"
    local runtime_root="${stage}/farming/package"
    if [ -n "${runtime_version}" ]; then runtime_root="${stage}/runtime/package"; fi
    local loader="${runtime_root}/dist/runtime/glibc228/ld-2.28.so"
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
    local node_command=("${node_bin}")
    if [ "${legacy}" = 1 ]; then node_command=("${loader}" --library-path "${library_path}" "${node_bin}"); fi
    run_install_step 'Preparing the Node.js cache' "${node_command[@]}" "${npm_cli}" cache add "${stage}/node.tgz" --registry="${registry}" --ignore-scripts
    if [ -n "${runtime_version}" ]; then
      run_install_step 'Preparing the platform runtime cache' "${node_command[@]}" "${npm_cli}" cache add "${stage}/runtime.tgz" --registry="${registry}" --ignore-scripts
    fi
    run_install_step 'Preparing the npm cache' "${node_command[@]}" "${npm_cli}" cache add "${stage}/npm.tgz" --registry="${registry}" --ignore-scripts
    run_install_step 'Installing Farming dependencies' "${node_command[@]}" "${npm_cli}" install --global --prefix "${prefix}" "${stage}/farming.tgz" \
      --registry="${registry}" --ignore-scripts --include=optional --omit=dev --no-audit --no-fund
    local package_root="${prefix}/lib/node_modules/farming-code"
    # These pins are installer metadata, not optional application dependencies.
    # Reuse the verified bootstrap downloads instead of installing a second copy.
    mkdir -p "${package_root}/node_modules"
    mv "${stage}/node/package" "${package_root}/node_modules/${carrier}"
    mv "${stage}/npm/package" "${package_root}/node_modules/npm"
    chmod +x "${package_root}/bin/farming-node" "${package_root}/bin/farming-npm"
    run_install_step 'Verifying Node.js and native terminals' "${package_root}/bin/farming-node" -e \
      'const path=require("path"); const root=process.argv[1]; require(path.join(root,"backend/packaged-node-pty.cjs")).nodePty; require(path.join(root,"node_modules/npm/package.json")); console.log("Private Node.js and native PTY verified.")' "${package_root}"
    run_install_step 'Preparing Farming runtimes' "${package_root}/bin/farming-node" "${package_root}/bin/farming" runtime prepare \
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
download_registry="${registry}"
if [ -f "${root}/.farming-download-registry" ]; then
  registry="${FARMING_NPM_REGISTRY:-$(< "${root}/.farming-npm-registry")}"
  download_registry="${npm_config_registry:-$(< "${root}/.farming-download-registry")}"
fi
export FARMING_NPM_REGISTRY="${registry}" npm_config_registry="${download_registry}"
export npm_config_cache="${root}/cache/npm"
export FARMING_PACKAGE_INSTALLATIONS_DIR="${FARMING_PACKAGE_INSTALLATIONS_DIR:-${root}/packages}"
exec "${package_root}/bin/farming-node" "${package_root}/bin/farming" "$@"
LAUNCHER
    chmod +x "${prefix}/farming"
    printf '%s\n' "${metadata_registry}" > "${prefix}/.farming-npm-registry"
    chmod 600 "${prefix}/.farming-npm-registry"
    if [ "${mirror}" = cn ]; then
      printf '%s\n' "${registry}" > "${prefix}/.farming-download-registry"
      chmod 600 "${prefix}/.farming-download-registry"
    fi
    touch "${prefix}/.farming-user-install-v1"
    progress_message 33 '◇ Finishing installation…'
    mv "${prefix}" "${root}"
  fi
  [ -L "${entry}" ] || ln -s "${root}/farming" "${entry}"
  progress_message 32 "✓ Farming installed: ${root}"
  printf 'Command: %s\n' "${entry}"
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

download_options() {
  curl_options=(--fail --show-error --location --connect-timeout 20 --max-time 600 --retry 2)
  if [[ "$1" = https://registry.npmmirror.com/* ]]; then
    curl_options=(--fail --show-error --location --connect-timeout 10 --max-time 600 --retry 0 --speed-limit 16384 --speed-time 20)
  fi
  # Capture curl's transfer telemetry privately; only our renderer reaches the terminal.
  if [[ "$2" != *.tgz ]]; then curl_options+=(--silent); fi
}

download() {
  local curl_options
  download_options "$1" "$2"
  curl "${curl_options[@]}" "$1" -o "$2"
}

download_is_running() {
  local running
  running="$(jobs -pr)"
  [[ $'\n'"${running}"$'\n' = *$'\n'"$1"$'\n'* ]]
}

cleanup_install() {
  local status=$? pid
  progress_end
  for pid in ${download_pids[@]+"${download_pids[@]}"}; do
    [ -n "${pid}" ] || continue
    if download_is_running "${pid}"; then kill -KILL "${pid}" 2>/dev/null || true; fi
    wait "${pid}" 2>/dev/null || true
  done
  test -z "${stage:-}" || rm -rf -- "${stage}"
  rmdir -- "${lock}"
  return "${status}"
}

select_integrity_tool() {
  local tool
  if command -v base64 >/dev/null && command -v od >/dev/null; then
    for tool in sha512sum shasum; do
      if command -v "${tool}" >/dev/null; then
        printf '%s\n' "${tool}"
        return
      fi
    done
  fi
  if command -v openssl >/dev/null; then
    echo openssl
    return
  fi
  echo 'Missing SHA-512 tools: install sha512sum or shasum (with base64 and od), or openssl. Nothing downloaded.' >&2
  return 1
}

verify_integrity() {
  local archive="$1" expected="$2" actual
  [[ "${expected}" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || return 1
  if [ "${integrity_tool}" = openssl ]; then
    actual="sha512-$(openssl dgst -sha512 -binary "${archive}" | openssl base64 -A)" || return 1
  else
    expected="$(printf '%s' "${expected#sha512-}" | base64 -d | od -An -v -tx1 | tr -d ' \n')" || return 1
    [ "${#expected}" = 128 ] || return 1
    case "${integrity_tool}" in
      sha512sum) actual="$(sha512sum "${archive}")" || return 1 ;;
      shasum) actual="$(shasum -a 512 "${archive}")" || return 1 ;;
      *) return 1 ;;
    esac
    actual="${actual%% *}"
  fi
  [ "${actual}" = "${expected}" ]
}

resolve_package() {
  local name="$1" version="$2" destination="$3"
  mkdir -p "${destination}"
  progress_message 33 "◇ Resolving ${name}@${version}…"
  download "${metadata_registry}/${name}/${version}" "${destination}/metadata.json"
  url="$(json_string tarball "${destination}/metadata.json")"
  expected="$(json_string integrity "${destination}/metadata.json")"
  fallback_url=''
  if [ "${mirror}" = cn ]; then
    case "${url}" in
      https://registry.npmjs.org/*) fallback_url="${url}" ;;
      *) echo "Invalid official npm tarball URL for ${name}." >&2; exit 1 ;;
    esac
  fi
  case "${url}" in https://registry.npmjs.org/*) url="${registry}/${url#https://registry.npmjs.org/}" ;; esac
  case "${url}" in https://*|http://127.0.0.1:*/*|http://localhost:*/*) ;; *) echo "Invalid npm tarball URL for ${name}." >&2; exit 1 ;; esac
  case "${expected}" in sha512-*) ;; *) echo "Missing SHA-512 npm integrity for ${name}." >&2; exit 1 ;; esac
}

extract_package() {
  local name="$1" destination="$2" expected="$3"
  progress_message 33 "◇ Verifying ${name} (SHA-512)…"
  verify_integrity "${destination}.tgz" "${expected}" || { echo "SHA-512 verification failed for ${name}; nothing installed." >&2; exit 1; }
  progress_message 33 "◇ Extracting ${name}…"
  tar -xzf "${destination}.tgz" -C "${destination}"
  [ -f "${destination}/package/package.json" ] || { echo "Invalid package archive: ${name}" >&2; exit 1; }
  progress_message 32 "✓ ${name} ready"
}

# Match runtime-dependency-progress.cts: cyan 18-cell download bars, yellow
# verification/retry, green readiness, and bounded plain-text logs without ANSI.
# The bootstrap cannot import that renderer until its private Node is installed.
progress_clear() {
  if [ "${progress_rows:-0}" -gt 0 ]; then
    printf '\033[%sA\r\033[J' "${progress_rows}" >&2
    progress_rows=0
  fi
}

progress_end() {
  progress_clear
  if [ "${progress_tty:-0}" = 1 ]; then printf '\033[?25h' >&2; fi
}

progress_message() {
  progress_end
  if [ "${progress_tty:-0}" = 1 ] && [ -z "${NO_COLOR+x}" ]; then
    printf '\033[%sm%s\033[0m\n' "$1" "$2" >&2
  else
    printf '%s\n' "$2" >&2
  fi
}

progress_line() {
  local text="$1" width="${COLUMNS:-80}"
  [[ "${width}" =~ ^[0-9]+$ ]] && [ "${width}" -gt 1 ] || width=80
  # Leave the last terminal column unused to avoid wrapping cursor-owned rows.
  text="${text:0:$((width - 1))}"
  if [ -z "${NO_COLOR+x}" ]; then printf '\033[36m%s\033[0m\n' "${text}" >&2
  else printf '%s\n' "${text}" >&2; fi
  progress_rows=$((progress_rows + 1))
}

render_downloads() {
  local i line overall total percent received up uploaded average upload_average duration spent remaining speed
  local detail bar filled cell bucket source label spinner
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  spinner="${frames[$((tick % 10))]}"
  if [ "${progress_tty}" = 1 ]; then
    progress_clear
    printf '\033[?25l' >&2
  fi
  for i in "${!names[@]}"; do
    [ -n "${download_pids[i]}" ] || continue
    line="$(tail -c 2048 "${destinations[i]}.progress" | tr '\r' '\n' | tail -n 1)"
    read -r overall total percent received up uploaded average upload_average duration spent remaining speed <<< "${line}"
    detail='Connecting…'
    bucket=-1
    if [[ "${overall}" =~ ^[0-9]+$ && "${percent}" =~ ^[0-9]+$ ]] && [ -n "${speed}" ]; then
      if [ "${total}" = 0 ] || { [ "${overall}" = 100 ] && [ "${percent}" = 0 ]; }; then
        detail="${received} downloaded · ${speed}/s · total unknown"
        bucket=0
        [ "${received}" = 0 ] || bucket=1
      else
        filled=$((percent * 18 / 100)); bar=''
        for ((cell=0; cell<18; cell++)); do
          if [ "${cell}" -lt "${filled}" ]; then bar="${bar}━"; else bar="${bar}─"; fi
        done
        detail="${bar} ${percent}%  ${received} / ${total} · ${speed}/s · ETA ${remaining}"
        bucket=$((percent / 10))
      fi
    fi
    case "${urls[i]}" in
      https://registry.npmmirror.com/*) source=npmmirror ;;
      https://registry.npmjs.org/*) source='official npm' ;;
      *) source='configured registry' ;;
    esac
    label="${names[i]}"
    case "${label}" in farming-code) label=Farming ;; node-*) label=Node.js ;; esac
    if [ "${progress_tty}" = 1 ]; then
      progress_line "${spinner} ${label} ${versions[i]} · ${source}"
      progress_line "  ${detail}"
    elif [ "${log_buckets[i]}" != "${bucket}" ] || [ $((tick % 50)) = 0 ]; then
      # At most once per 10% or ten seconds; unknown totals remain byte counts.
      printf 'Downloading %s: %s\n' "${names[i]}" "${detail}" >&2
      log_buckets[i]="${bucket}"
    fi
  done
}

fetch_package() {
  local names=("$1") versions=("$2") destinations=("$3")
  fetch_packages
}

fetch_runtime_packages() {
  local names=("${carrier}" npm) versions=("${node_version}" "${npm_version}")
  local destinations=("${stage}/node" "${stage}/npm")
  if [ -n "${runtime_version}" ]; then
    names+=(farming-code)
    versions+=("${runtime_version}")
    destinations+=("${stage}/runtime")
  fi
  progress_message 36 'Downloading platform runtimes in parallel…'
  fetch_packages
}

fetch_packages() {
  local urls=() integrities=() fallback_urls=() log_buckets=()
  local i url expected fallback_url pending pid tick=0 error resolved_version
  # Resolve every descriptor before creating concurrent writers. Downloads move
  # from mirror to the same official artifact at most once; verification is terminal.
  for i in "${!names[@]}"; do
    resolve_package "${names[i]}" "${versions[i]}" "${destinations[i]}"
    resolved_version="$(json_string version "${destinations[i]}/metadata.json")"
    if [[ "${resolved_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$ ]]; then versions[i]="${resolved_version}"; fi
    urls[i]="${url}"
    integrities[i]="${expected}"
    fallback_urls[i]="${fallback_url}"
    log_buckets[i]=-1
  done
  for i in "${!names[@]}"; do
    progress_message 36 "↓ Downloading ${names[i]}@${versions[i]}…"
    start_package_download
  done
  while :; do
    pending=0
    for i in "${!names[@]}"; do
      pid="${download_pids[i]}"
      [ -n "${pid}" ] || continue
      if download_is_running "${pid}"; then
        pending=1
      else
        if ! wait "${pid}"; then
          download_pids[i]=''
          error="$(tr '\r' '\n' < "${destinations[i]}.progress" | sed -n 's/^curl: //p' | tail -n 1)"
          if [ -n "${fallback_urls[i]}" ]; then
            progress_message 33 "! ${names[i]}: mirror unavailable${error:+ — ${error}}"
            progress_message 33 '  Downloading the same version from official npm…'
            urls[i]="${fallback_urls[i]}"
            fallback_urls[i]=''
            log_buckets[i]=-1
            start_package_download
            pending=1
            continue
          fi
          progress_message 31 "✗ Download failed: ${names[i]}@${versions[i]}${error:+ — ${error}}"
          return 1
        fi
        download_pids[i]=''
        progress_message 32 "✓ Downloaded ${names[i]}@${versions[i]}"
      fi
    done
    [ "${pending}" = 1 ] || break
    render_downloads
    sleep 0.2
    tick=$((tick + 1))
  done
  progress_end
  download_pids=()
  for i in "${!names[@]}"; do
    extract_package "${names[i]}" "${destinations[i]}" "${integrities[i]}"
  done
}

start_package_download() {
  local curl_options
  download_options "${urls[i]}" "${destinations[i]}.tgz"
  # Direct children only: the owner can stop and reap every curl process.
  : > "${destinations[i]}.progress"
  curl "${curl_options[@]}" "${urls[i]}" -o "${destinations[i]}.tgz" 2>"${destinations[i]}.progress" &
  download_pids[i]=$!
}

run_install_step() {
  local label="$1" result diagnostic
  shift
  progress_message 33 "◇ ${label}…"
  # CLI commands may print machine JSON and private staging paths. Those are
  # diagnostic data, not the installer's user-facing status or final locations.
  if "$@" > "${stage}/step.log" 2>&1; then
    progress_message 32 "✓ ${label}"
  else
    result=$?
    diagnostic="$(mktemp "${root}.install-error.XXXXXX")"
    cat "${stage}/step.log" > "${diagnostic}"
    progress_message 31 "✗ ${label} failed. Installation was not published."
    printf 'Diagnostic log: %s\n' "${diagnostic}" >&2
    return "${result}"
  fi
}

main "$@"
