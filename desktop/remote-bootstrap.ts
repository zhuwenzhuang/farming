import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface RemoteServerHandshake {
  protocolVersion: 1
  version: string
  platform: string
  arch: string
  farmingHome: string
  host: '127.0.0.1'
  port: number
  basePath: string
  token: string
  runtime: string
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const HANDSHAKE_BEGIN = 'FARMING_DESKTOP_HANDSHAKE_BEGIN'
const HANDSHAKE_END = 'FARMING_DESKTOP_HANDSHAKE_END'
const NEED_UPLOAD = 'FARMING_DESKTOP_NEEDS_UPLOAD:'
const DEFAULT_RELEASE_ROOT = 'https://github.com/zhuwenzhuang/farming/releases/download'
const OUTPUT_LIMIT = 64 * 1024
const RELEASE_DOWNLOAD_ATTEMPTS = 3
const RELEASE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const RELEASE_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const RELEASE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const RELEASE_CHECKSUM_MAX_BYTES = 256 * 1024

class DesktopReleaseSizeLimitError extends Error {
  readonly code = 'FARMING_DESKTOP_RELEASE_SIZE_LIMIT'
}

export class DesktopRemoteOperationCancelledError extends Error {
  readonly code = 'FARMING_DESKTOP_REMOTE_CANCELLED'

  constructor(message = 'Remote connection was cancelled.') {
    super(message)
    this.name = 'DesktopRemoteOperationCancelledError'
  }
}

export function normalizeDesktopServerVersion(value: unknown) {
  const text = String(value || '').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(text)) {
    throw new Error('Desktop Server version is invalid.')
  }
  return text
}

export function normalizeDesktopReleaseRoot(value: unknown) {
  const text = String(value || DEFAULT_RELEASE_ROOT).trim().replace(/\/+$/, '')
  const url = new URL(text)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Desktop release root must be an HTTP(S) URL without credentials, query parameters, or a fragment.')
  }
  return url.toString().replace(/\/$/, '')
}

const RELEASE_ROOT = normalizeDesktopReleaseRoot(process.env.FARMING_DESKTOP_RELEASE_ROOT)

export function desktopSshArgs(sshHost: string, remoteCommand?: string) {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    sshHost,
    ...(remoteCommand ? [remoteCommand] : []),
  ]
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function boundedOutput(current: string, chunk: Buffer | string) {
  return `${current}${String(chunk)}`.slice(-OUTPUT_LIMIT)
}

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (!signal) return delay(milliseconds)
  if (signal.aborted) return Promise.reject(new DesktopRemoteOperationCancelledError())
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      reject(new DesktopRemoteOperationCancelledError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function sha256File(file: string) {
  const descriptor = fs.openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Uint8Array) {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (result.bytesWritten <= 0) throw new Error('Desktop release download made no write progress.')
    offset += result.bytesWritten
  }
}

export async function downloadDesktopReleaseUrl(
  url: string,
  target: string,
  description: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    idleTimeoutMs?: number
    maxBytes?: number
    onProgress?: (message: string) => void
  } = {},
) {
  const maxBytes = options.maxBytes ?? RELEASE_DOWNLOAD_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Desktop release byte limit is invalid.')
  let lastError: unknown = null
  const deadline = Date.now() + (options.timeoutMs ?? RELEASE_DOWNLOAD_TIMEOUT_MS)
  for (let attempt = 1; attempt <= RELEASE_DOWNLOAD_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) throw new DesktopRemoteOperationCancelledError()
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const controller = new AbortController()
    let timeoutReason: 'absolute' | 'idle' | null = null
    let idleTimeout: NodeJS.Timeout | null = null
    const absoluteTimeout = setTimeout(() => {
      timeoutReason = 'absolute'
      controller.abort()
    }, remaining)
    const abort = () => controller.abort()
    const armIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => {
        timeoutReason = 'idle'
        controller.abort()
      }, options.idleTimeoutMs ?? RELEASE_DOWNLOAD_IDLE_TIMEOUT_MS)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    armIdleTimeout()
    let handle: fs.promises.FileHandle | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let completed = false
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        const error = new Error(`${description} returned HTTP ${response.status}.`)
        if (response.status < 500) throw error
        lastError = error
      } else if (!response.body) {
        throw new Error(`${description} returned an empty response.`)
      } else {
        const totalHeader = Number(response.headers.get('content-length'))
        const total = Number.isSafeInteger(totalHeader) && totalHeader > 0 ? totalHeader : null
        if (total !== null && total > maxBytes) {
          controller.abort()
          throw new DesktopReleaseSizeLimitError(`${description} exceeds the ${maxBytes} byte limit.`)
        }
        reader = response.body.getReader()
        handle = await fs.promises.open(target, 'w', 0o600)
        let received = 0
        let reported = -1
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          armIdleTimeout()
          if (received + chunk.value.byteLength > maxBytes) {
            controller.abort()
            throw new DesktopReleaseSizeLimitError(`${description} exceeds the ${maxBytes} byte limit.`)
          }
          await writeAll(handle, chunk.value)
          received += chunk.value.byteLength
          const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null
          const progressStep = percent === null ? Math.floor(received / (5 * 1024 * 1024)) : Math.floor(percent / 5)
          if (progressStep !== reported) {
            reported = progressStep
            const receivedMb = (received / (1024 * 1024)).toFixed(1)
            options.onProgress?.(total && percent !== null
              ? `${description}: ${percent}% · ${receivedMb} / ${(total / (1024 * 1024)).toFixed(1)} MB`
              : `${description}: ${receivedMb} MB`)
          }
        }
        await handle.close()
        handle = null
        options.onProgress?.(`${description}: downloaded, verifying…`)
        completed = true
        return
      }
    } catch (error) {
      controller.abort()
      await reader?.cancel().catch(() => {})
      await handle?.close().catch(() => {})
      handle = null
      fs.rmSync(target, { force: true })
      if (options.signal?.aborted) throw new DesktopRemoteOperationCancelledError()
      if (error instanceof DesktopReleaseSizeLimitError) throw error
      if (timeoutReason) {
        lastError = new Error(timeoutReason === 'idle'
          ? `${description} produced no download progress for ${Math.ceil((options.idleTimeoutMs ?? RELEASE_DOWNLOAD_IDLE_TIMEOUT_MS) / 1000)} seconds.`
          : `${description} exceeded its ${Math.ceil((options.timeoutMs ?? RELEASE_DOWNLOAD_TIMEOUT_MS) / 1000)} second deadline.`)
      } else {
        lastError = error
      }
      if (error instanceof Error && /HTTP 4\d\d/.test(error.message)) throw error
    } finally {
      if (!completed) {
        controller.abort()
        await reader?.cancel().catch(() => {})
      }
      clearTimeout(absoluteTimeout)
      if (idleTimeout) clearTimeout(idleTimeout)
      options.signal?.removeEventListener('abort', abort)
    }
    if (attempt < RELEASE_DOWNLOAD_ATTEMPTS && Date.now() < deadline) {
      await abortableDelay(attempt * 500, options.signal)
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`${description} failed after ${RELEASE_DOWNLOAD_ATTEMPTS} attempts${detail}`)
}

function runCommand(command: string, args: string[], options: {
  input?: Buffer | string
  inputFile?: string
  timeoutMs?: number
  signal?: AbortSignal
} = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    if (options.input !== undefined && options.inputFile) {
      reject(new Error('A command cannot use both buffered and streamed input.'))
      return
    }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminationReason: 'cancelled' | 'timeout' | null = null
    let killTimeout: NodeJS.Timeout | null = null
    const cleanup = () => {
      clearTimeout(timeout)
      if (killTimeout) clearTimeout(killTimeout)
      options.signal?.removeEventListener('abort', abort)
    }
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      operation()
    }
    const terminate = (reason: 'cancelled' | 'timeout') => {
      if (settled || terminationReason) return
      terminationReason = reason
      child.kill('SIGTERM')
      killTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000)
    }
    const abort = () => terminate('cancelled')
    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs ?? 120_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on('data', chunk => { stdout = boundedOutput(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = boundedOutput(stderr, chunk) })
    child.once('error', error => {
      finish(() => reject(error))
    })
    child.once('exit', code => {
      finish(() => {
        if (terminationReason === 'cancelled') reject(new DesktopRemoteOperationCancelledError())
        else if (terminationReason === 'timeout') reject(new Error(`Remote command exceeded its ${Math.ceil((options.timeoutMs ?? 120_000) / 1000)} second deadline.`))
        else resolve({ code: code ?? 1, stdout, stderr })
      })
    })
    child.stdin.once('error', error => {
      stderr = boundedOutput(stderr, `stdin: ${error.message}`)
      child.kill()
    })
    if (options.inputFile) {
      const input = fs.createReadStream(options.inputFile)
      input.once('error', error => {
        stderr = boundedOutput(stderr, `input: ${error.message}`)
        child.kill()
      })
      input.pipe(child.stdin)
    } else if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

export function parseRemoteServerHandshake(output: string): RemoteServerHandshake {
  const start = output.lastIndexOf(HANDSHAKE_BEGIN)
  const end = output.indexOf(HANDSHAKE_END, start)
  if (start < 0 || end < 0) throw new Error('Remote Farming Server did not return a valid handshake.')
  const fields = new Map<string, string>()
  output.slice(start + HANDSHAKE_BEGIN.length, end).trim().split(/\r?\n/).forEach(line => {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1))
  })
  const port = Number(fields.get('port'))
  const decodeHex = (name: string) => Buffer.from(fields.get(name) || '', 'hex').toString('utf8')
  if (fields.get('protocolVersion') !== '1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Remote Farming Server returned an incompatible handshake.')
  }
  return {
    protocolVersion: 1,
    version: fields.get('version') || '',
    platform: fields.get('platform') || '',
    arch: fields.get('arch') || '',
    farmingHome: decodeHex('farmingHomeHex'),
    host: '127.0.0.1',
    port,
    basePath: decodeHex('basePathHex'),
    token: decodeHex('tokenHex'),
    runtime: decodeHex('runtimeHex') || 'system',
  }
}

export function buildRemoteBootstrapScript() {
  return `set -eu
case "$FARMING_HOME" in
  '~') FARMING_HOME="$HOME" ;;
  '~/'*) FARMING_HOME="$HOME/\${FARMING_HOME#"~/"}" ;;
esac
case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo "Unsupported remote platform: $(uname -s)" >&2; exit 2 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported remote architecture: $(uname -m)" >&2; exit 2 ;; esac
runtime=system
needs_compat=0
if [ "$platform" = linux ] && command -v getconf >/dev/null 2>&1; then
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)
  major=$(printf %s "$glibc" | awk -F. '{print $1}')
  minor=$(printf %s "$glibc" | awk -F. '{print $2}')
  if [ -n "$major" ] && { [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "\${minor:-0}" -lt 28 ]; }; }; then
    needs_compat=1
  fi
fi
if [ "$needs_compat" = 1 ]; then
  if [ -n "\${FARMING_SERVER_CUSTOM_GLIBC_LINKER:-}" ]; then
    compat_linker=$FARMING_SERVER_CUSTOM_GLIBC_LINKER
    compat_path=\${FARMING_SERVER_CUSTOM_GLIBC_PATH:-}
    compat_patchelf=\${FARMING_SERVER_PATCHELF_PATH:-}
    runtime=farming-custom-glibc
  else
    compat_linker=\${VSCODE_SERVER_CUSTOM_GLIBC_LINKER:-}
    compat_path=\${VSCODE_SERVER_CUSTOM_GLIBC_PATH:-}
    compat_patchelf=\${VSCODE_SERVER_PATCHELF_PATH:-}
    runtime=vscode-custom-glibc
  fi
  if [ ! -x "\${compat_linker:-}" ] || [ -z "\${compat_path:-}" ] || [ ! -x "\${compat_patchelf:-}" ]; then
    echo "Remote glibc $glibc requires a compatibility runtime. Configure FARMING_SERVER_CUSTOM_GLIBC_LINKER, FARMING_SERVER_CUSTOM_GLIBC_PATH, and FARMING_SERVER_PATCHELF_PATH, or provide the equivalent VS Code variables." >&2
    exit 2
  fi
fi
asset="farming_\${FARMING_VERSION}_\${platform}_\${arch}"
install_dir="$FARMING_HOME/server/$FARMING_VERSION"
binary="$install_dir/farming"
mkdir -p "$install_dir" "$FARMING_HOME/data"
if [ ! -x "$binary" ]; then
  tmp="$binary.download.$$"
  sums="$binary.checksums.$$"
  asset_url="$FARMING_RELEASE_ROOT/v$FARMING_VERSION/$asset"
  sums_url="$FARMING_RELEASE_ROOT/v$FARMING_VERSION/farming_\${FARMING_VERSION}_checksums.txt"
  checksum_limit=262144
  asset_limit=536870912
  wget_pid=
  download_fifo=
  cleanup_download() {
    if [ -n "\${wget_pid:-}" ]; then
      kill "$wget_pid" 2>/dev/null || true
      wait "$wget_pid" 2>/dev/null || true
      wget_pid=
    fi
    rm -f "$tmp" "$sums"
    if [ -n "\${download_fifo:-}" ]; then
      rm -f "$download_fifo"
      download_fifo=
    fi
  }
  abort_download() {
    trap - EXIT HUP INT TERM
    cleanup_download
    exit 143
  }
  trap cleanup_download EXIT
  trap abort_download HUP INT TERM
  download() {
    url=$1; target=$2; limit=$3; label=$4
    rm -f "$target"
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsSL --connect-timeout 10 --max-time 45 --max-filesize "$limit" "$url" -o "$target"; then
        rm -f "$target"
        return 1
      fi
    elif command -v wget >/dev/null 2>&1 \
      && command -v mkfifo >/dev/null 2>&1 \
      && head -c 1 </dev/null >/dev/null 2>&1; then
      download_fifo="$target.pipe.$$"
      rm -f "$download_fifo"
      if ! mkfifo "$download_fifo"; then return 1; fi
      wget -q --timeout=15 --tries=1 -O - "$url" > "$download_fifo" &
      wget_pid=$!
      head_status=0
      head -c "$((limit + 1))" < "$download_fifo" > "$target" || head_status=$?
      wget_status=0
      wait "$wget_pid" || wget_status=$?
      wget_pid=
      rm -f "$download_fifo"
      download_fifo=
      actual_size=$(wc -c < "$target" | tr -d '[:space:]')
      if [ -z "$actual_size" ] || [ "$actual_size" -gt "$limit" ]; then
        rm -f "$target"
        echo "$label exceeds its $limit byte limit" >&2
        return 1
      fi
      if [ "$head_status" -ne 0 ] || [ "$wget_status" -ne 0 ]; then
        rm -f "$target"
        return 1
      fi
    else
      rm -f "$target"
      return 1
    fi
    actual_size=$(wc -c < "$target" | tr -d '[:space:]')
    if [ -z "$actual_size" ] || [ "$actual_size" -gt "$limit" ]; then
      rm -f "$target"
      echo "$label exceeds its $limit byte limit" >&2
      return 1
    fi
  }
  if download "$sums_url" "$sums" "$checksum_limit" "Release checksum" \
    && download "$asset_url" "$tmp" "$asset_limit" "Farming Server"; then
    expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$sums")
    if [ -z "$expected" ]; then rm -f "$tmp" "$sums"; echo "Release checksum does not list $asset" >&2; exit 3; fi
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp" | awk '{print $1}'); else actual=$(shasum -a 256 "$tmp" | awk '{print $1}'); fi
    if [ "$actual" != "$expected" ]; then rm -f "$tmp" "$sums"; echo "Remote Farming Server checksum mismatch" >&2; exit 3; fi
    chmod 700 "$tmp" && mv "$tmp" "$binary"
    rm -f "$sums"
  else
    rm -f "$tmp" "$sums"
    echo "${NEED_UPLOAD}$asset"
    exit 42
  fi
fi
if [ "$needs_compat" = 1 ]; then
  current_interpreter=$("$compat_patchelf" --print-interpreter "$binary" 2>/dev/null || true)
  runtime_dir="/tmp/fm-$(id -u)"
  old_umask=$(umask)
  umask 077
  if ! mkdir -p "$runtime_dir" \
    || [ "$(stat -c %u "$runtime_dir" 2>/dev/null || true)" != "$(id -u)" ] \
    || [ "$(stat -c %a "$runtime_dir" 2>/dev/null || true)" != 700 ]; then
    umask "$old_umask"
    echo "Farming could not create a private compatibility-runtime directory." >&2
    exit 3
  fi
  compat_alias="$runtime_dir/ld"
  compat_alias_tmp="$runtime_dir/ld.$$"
  ln -s "$compat_linker" "$compat_alias_tmp"
  mv -f "$compat_alias_tmp" "$compat_alias"
  umask "$old_umask"
  if [ "\${#compat_alias}" -gt "\${#current_interpreter}" ]; then
    echo "Farming's compatibility-runtime linker alias is longer than the Server ELF interpreter." >&2
    exit 3
  fi
  if [ "$current_interpreter" != "$compat_alias" ]; then
    patched="$binary.compat.$$"
    cp "$binary" "$patched"
    chmod 700 "$patched"
    if ! "$compat_patchelf" --set-interpreter "$compat_alias" "$patched" \
      || [ "$("$compat_patchelf" --print-interpreter "$patched" 2>/dev/null || true)" != "$compat_alias" ] \
      || ! FARMING_DESKTOP_COMPAT_GLIBC_PATH="$compat_path" \
        FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH="\${LD_LIBRARY_PATH:-}" \
        LD_LIBRARY_PATH="$compat_path\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$patched" --help >/dev/null 2>&1; then
      rm -f "$patched"
      echo "Farming could not patch or validate its Server with the discovered compatibility runtime." >&2
      exit 3
    fi
    mv "$patched" "$binary"
  fi
  if ! FARMING_DESKTOP_COMPAT_GLIBC_PATH="$compat_path" \
    FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH="\${LD_LIBRARY_PATH:-}" \
    LD_LIBRARY_PATH="$compat_path\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$binary" --help >/dev/null 2>&1; then
    echo "Farming Server failed validation with the discovered compatibility runtime." >&2
    exit 3
  fi
fi
bootstrap_log="$FARMING_HOME/bootstrap.log"
if [ "$needs_compat" = 1 ]; then
  FARMING_NODE_LD="$compat_linker" \
    FARMING_NODE_LIBRARY_PATH="$compat_path" \
    FARMING_DESKTOP_COMPAT_GLIBC_PATH="$compat_path" \
    FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH="\${LD_LIBRARY_PATH:-}" \
    LD_LIBRARY_PATH="$compat_path\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$binary" daemon --base-path /farming --config-dir "$FARMING_HOME/data" >"$bootstrap_log" 2>&1 || daemon_status=$?
else
  "$binary" daemon --base-path /farming --config-dir "$FARMING_HOME/data" >"$bootstrap_log" 2>&1 || daemon_status=$?
fi
if [ "\${daemon_status:-0}" -ne 0 ]; then
  echo "Remote Farming Server failed to start. See $bootstrap_log on the remote host." >&2
  if [ -s "$bootstrap_log" ]; then
    echo "Remote Server output (last 30 lines):" >&2
    tail -n 30 "$bootstrap_log" 2>/dev/null | tail -c 4096 >&2 || true
  fi
  exit 4
fi
state="$FARMING_HOME/data/farming-server.json"
token_file="$FARMING_HOME/data/.session-token"
port=$(sed -n 's/^[[:space:]]*"port":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$state" | head -1)
base_path=$(sed -n 's/^[[:space:]]*"basePath":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$state" | head -1)
token=$(cat "$token_file" 2>/dev/null || true)
hex() { printf %s "$1" | od -An -tx1 | tr -d '[:space:]'; }
echo "${HANDSHAKE_BEGIN}"
echo "protocolVersion=1"
echo "version=$FARMING_VERSION"
echo "platform=$platform"
echo "arch=$arch"
echo "farmingHomeHex=$(hex "$FARMING_HOME")"
echo "port=$port"
echo "basePathHex=$(hex "$base_path")"
echo "tokenHex=$(hex "$token")"
echo "runtimeHex=$(hex "$runtime")"
echo "${HANDSHAKE_END}"
`
}

async function downloadReleaseAsset(
  version: string,
  asset: string,
  cacheDir: string,
  signal?: AbortSignal,
  onPhase?: (message: string) => void,
) {
  const targetDir = path.join(cacheDir, version)
  const target = path.join(targetDir, asset)
  const sumsUrl = `${RELEASE_ROOT}/v${version}/farming_${version}_checksums.txt`
  const assetUrl = `${RELEASE_ROOT}/v${version}/${asset}`
  fs.mkdirSync(targetDir, { recursive: true })
  const nonce = `${process.pid}.${Date.now()}`
  const sumsFile = path.join(targetDir, `.checksums.${nonce}.tmp`)
  const temporary = `${target}.${nonce}.tmp`
  try {
    await downloadDesktopReleaseUrl(sumsUrl, sumsFile, 'Downloading Farming Server checksums', {
      signal,
      maxBytes: RELEASE_CHECKSUM_MAX_BYTES,
      onProgress: onPhase,
    })
    const line = fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).find(value => {
      const [, name = ''] = value.trim().split(/\s+/, 2)
      return name.replace(/^\*/, '') === asset
    })
    const expected = line?.trim().split(/\s+/, 1)[0]
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`Release checksum does not list ${asset}.`)
    if (fs.existsSync(target)) {
      const actual = sha256File(target)
      if (actual === expected) return target
    }
    await downloadDesktopReleaseUrl(assetUrl, temporary, `Downloading Farming Server ${version}`, {
      signal,
      maxBytes: RELEASE_DOWNLOAD_MAX_BYTES,
      onProgress: onPhase,
    })
    const actual = sha256File(temporary)
    if (actual !== expected) throw new Error('Downloaded Farming Server checksum does not match its release manifest.')
    fs.chmodSync(temporary, 0o700)
    fs.renameSync(temporary, target)
    return target
  } finally {
    fs.rmSync(sumsFile, { force: true })
    fs.rmSync(temporary, { force: true })
  }
}

export function buildRemoteUploadCommand(options: {
  farmingHome: string
  version: string
  expectedSize: number
  expectedSha256: string
}) {
  const version = normalizeDesktopServerVersion(options.version)
  if (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 1) {
    throw new Error('Desktop Server upload size is invalid.')
  }
  if (!/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
    throw new Error('Desktop Server upload checksum is invalid.')
  }
  return `set -eu; FARMING_HOME=${shellQuote(options.farmingHome)}; FARMING_VERSION=${shellQuote(version)}; case "$FARMING_HOME" in '~') FARMING_HOME="$HOME" ;; '~/'*) FARMING_HOME="$HOME/\${FARMING_HOME#"~/"}" ;; esac; install_dir="$FARMING_HOME/server/$FARMING_VERSION"; mkdir -p "$install_dir"; tmp="$install_dir/farming.upload.$$"; cleanup() { rm -f "$tmp"; }; trap cleanup EXIT HUP INT TERM; cat > "$tmp"; actual_size=$(wc -c < "$tmp" | tr -d '[:space:]'); [ "$actual_size" = "${options.expectedSize}" ] || { echo "Uploaded Farming Server size mismatch" >&2; exit 3; }; if command -v sha256sum >/dev/null 2>&1; then actual_sha=$(sha256sum "$tmp" | awk '{print $1}'); else actual_sha=$(shasum -a 256 "$tmp" | awk '{print $1}'); fi; [ "$actual_sha" = ${shellQuote(options.expectedSha256.toLowerCase())} ] || { echo "Uploaded Farming Server checksum mismatch" >&2; exit 3; }; chmod 700 "$tmp"; mv "$tmp" "$install_dir/farming"; trap - EXIT HUP INT TERM`
}

async function uploadReleaseAsset(
  sshHost: string,
  farmingHome: string,
  version: string,
  localFile: string,
  signal?: AbortSignal,
) {
  const expectedSize = fs.statSync(localFile).size
  const expectedSha256 = sha256File(localFile)
  const command = buildRemoteUploadCommand({ farmingHome, version, expectedSize, expectedSha256 })
  const result = await runCommand('ssh', desktopSshArgs(sshHost, command), {
    inputFile: localFile,
    timeoutMs: 600_000,
    signal,
  })
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not upload Farming Server through SSH.')
}

export async function bootstrapRemoteServer(options: {
  sshHost: string
  farmingHome: string
  version: string
  cacheDir: string
  onPhase?: (message: string) => void
  signal?: AbortSignal
}) {
  const version = normalizeDesktopServerVersion(options.version)
  const command = `FARMING_HOME=${shellQuote(options.farmingHome)} FARMING_VERSION=${shellQuote(version)} FARMING_RELEASE_ROOT=${shellQuote(RELEASE_ROOT)} sh -s`
  const run = () => runCommand('ssh', desktopSshArgs(options.sshHost, command), {
    input: buildRemoteBootstrapScript(),
    timeoutMs: 180_000,
    signal: options.signal,
  })
  options.onPhase?.('Detecting and starting Farming Server…')
  let result = await run()
  const uploadMarker = result.stdout.split(/\r?\n/).find(line => line.startsWith(NEED_UPLOAD))
  if (result.code === 42 && uploadMarker) {
    const asset = uploadMarker.slice(NEED_UPLOAD.length).trim()
    if (!/^farming_[0-9A-Za-z.+-]+_(linux|darwin)_(amd64|arm64)$/.test(asset)) {
      throw new Error('Remote host requested an invalid Farming Server artifact.')
    }
    options.onPhase?.('Downloading Farming Server locally…')
    let localFile = ''
    try {
      localFile = await downloadReleaseAsset(version, asset, options.cacheDir, options.signal, options.onPhase)
    } catch (error) {
      if (error instanceof Error && /checksums returned HTTP 404/.test(error.message)) {
        throw new Error(
          `Farming Server v${version} is not published. Source builds can set FARMING_DESKTOP_SERVER_VERSION to a published compatible version.`,
          { cause: error },
        )
      }
      throw error
    }
    options.onPhase?.('Uploading Farming Server through SSH…')
    await uploadReleaseAsset(options.sshHost, options.farmingHome, version, localFile, options.signal)
    options.onPhase?.('Starting Farming Server…')
    result = await run()
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Remote Farming Server bootstrap failed.')
  return parseRemoteServerHandshake(result.stdout)
}
