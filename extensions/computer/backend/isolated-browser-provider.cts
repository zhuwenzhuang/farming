const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const http = require('http');

const execFileAsync = promisify(execFile);
const ISOLATED_BROWSER_IMAGE_DIGEST = 'sha256:27764b6a7867b1d7ed07975b4678e20c3005e469b0fb8178d8ee6986c14cc97b';
const ISOLATED_BROWSER_IMAGE = `trycua/cuabot:1.0.5@${ISOLATED_BROWSER_IMAGE_DIGEST}`;
const ISOLATED_BROWSER_IMAGE_MIRROR = `docker.1ms.run/trycua/cuabot:1.0.5@${ISOLATED_BROWSER_IMAGE_DIGEST}`;
const ISOLATED_BROWSER_IMAGE_SOURCES = [
  ISOLATED_BROWSER_IMAGE,
  ISOLATED_BROWSER_IMAGE_MIRROR,
];
const ISOLATED_BROWSER_PORT = '9223/tcp';
const ISOLATED_BROWSER_TIMEOUT_MS = 90_000;
const ISOLATED_BROWSER_RELAY_SCRIPT = `
import select
import socket
import socketserver

class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.create_connection(("127.0.0.1", 9222))
        sockets = [self.request, upstream]
        try:
            while True:
                for source in select.select(sockets, [], [])[0]:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.request else self.request).sendall(chunk)
        finally:
            upstream.close()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

Server(("0.0.0.0", 9223), Relay).serve_forever()
`.trim();

interface DockerResult {
  stdout: string;
  stderr: string;
}

interface DockerRunner {
  (args: string[], options?: { timeoutMs?: number; maxBuffer?: number }): Promise<DockerResult>;
}

interface IsolatedBrowserProviderOptions {
  configDir: string;
  dockerRunner?: DockerRunner;
  getSettings?: () => Record<string, unknown>;
}

interface IsolatedBrowserOwner {
  ownerKey: string;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isolatedBrowserError(message: string, code: string, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function dockerObjectNotFound(error: unknown): boolean {
  const value = error as Error & { stderr?: string };
  return /no such (?:container|object)|not found/i.test(
    `${value?.message || String(error)}\n${value?.stderr || ''}`,
  );
}

function safeNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
}

function publishedPort(inspect: Record<string, unknown>): number {
  const ports = recordValue(recordValue(inspect.NetworkSettings).Ports);
  const mappings = ports[ISOLATED_BROWSER_PORT];
  if (!Array.isArray(mappings) || mappings.length !== 1) return 0;
  const mapping = recordValue(mappings[0]);
  if (mapping.HostIp !== '127.0.0.1') return 0;
  const port = Number(mapping.HostPort);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function waitForCdp(port: number, timeoutMs = ISOLATED_BROWSER_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(isolatedBrowserError(
          'The isolated Browser did not expose a DevTools endpoint in time',
          'ISOLATED_BROWSER_CDP_TIMEOUT',
          504,
        ));
        return;
      }
      const request = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/json/version',
        timeout: 2_000,
      }, (response: { statusCode?: number; resume(): void }) => {
        response.resume();
        if (Number(response.statusCode) === 200) {
          resolve();
          return;
        }
        setTimeout(attempt, 250);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => setTimeout(attempt, 250));
    };
    attempt();
  });
}

class IsolatedBrowserProvider {
  readonly docker: DockerRunner;
  readonly configFingerprint: string;
  readonly getSettings: () => Record<string, unknown>;
  readonly operations = new Map<string, Promise<unknown>>();
  readonly leases = new Map<string, number>();
  capabilityCache: Record<string, unknown> | null = null;
  selectedImage = '';
  preparePromise: Promise<unknown> | null = null;

  constructor(options: IsolatedBrowserProviderOptions) {
    this.configFingerprint = crypto.createHash('sha256')
      .update(options.configDir)
      .digest('hex')
      .slice(0, 12);
    this.docker = options.dockerRunner || (async (args, runOptions = {}) => {
      const result = await execFileAsync('docker', args, {
        encoding: 'utf8',
        timeout: runOptions.timeoutMs || 90_000,
        maxBuffer: runOptions.maxBuffer || 20 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    });
    this.getSettings = typeof options.getSettings === 'function'
      ? options.getSettings
      : () => ({});
  }

  compatibilityMode(): boolean {
    return this.getSettings().computerCompatibilityMode === true;
  }

  async capability(refresh = false) {
    if (this.capabilityCache && !refresh) return this.capabilityCache;
    let dockerAvailable = false;
    let imageReady = false;
    let error = '';
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
      dockerAvailable = true;
    } catch (caught) {
      error = (caught as Error).message || String(caught);
    }
    if (dockerAvailable) {
      for (const image of ISOLATED_BROWSER_IMAGE_SOURCES) {
        try {
          await this.docker(['image', 'inspect', image, '--format', '{{.Id}}'], {
            timeoutMs: 8_000,
          });
          imageReady = true;
          this.selectedImage = image;
          break;
        } catch {
          imageReady = false;
        }
      }
    }
    this.capabilityCache = {
      available: dockerAvailable && imageReady,
      dockerAvailable,
      imageReady,
      image: this.selectedImage || ISOLATED_BROWSER_IMAGE,
      imageDigest: ISOLATED_BROWSER_IMAGE_DIGEST,
      compatibilityMode: this.compatibilityMode(),
      error,
    };
    return this.capabilityCache;
  }

  prepare(): Promise<unknown> {
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      await this.docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
      const failures: string[] = [];
      for (const image of await this.rankedImageSources()) {
        try {
          await this.docker(['pull', image], {
            timeoutMs: 20 * 60_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          await this.docker([
            'run',
            '--rm',
            '--label', 'farming.dev/kind=isolated-browser-probe',
            '--label', `farming.dev/config=${this.configFingerprint}`,
            ...(this.compatibilityMode() ? ['--security-opt', 'seccomp=unconfined'] : []),
            '--entrypoint', '/bin/sh',
            image,
            '-lc',
            [
              'HOME=/home/user /usr/bin/chromium',
              '--headless=new',
              '--remote-debugging-port=9222',
              '--user-data-dir=/tmp/farming-browser-probe',
              '--no-first-run',
              '--no-default-browser-check',
              'about:blank >/tmp/farming-browser-probe.log 2>&1 &',
              'pid=$!;',
              'for attempt in 1 2 3 4 5 6 7 8 9 10; do',
              'python3 -c \'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)\' >/dev/null 2>&1 && { kill "$pid"; wait "$pid" 2>/dev/null || true; exit 0; };',
              'sleep 1;',
              'done;',
              'cat /tmp/farming-browser-probe.log >&2;',
              'kill "$pid" 2>/dev/null || true;',
              'wait "$pid" 2>/dev/null || true;',
              'exit 1',
            ].join(' '),
          ], { timeoutMs: 30_000 });
          this.selectedImage = image;
          this.capabilityCache = null;
          return this.capability(true);
        } catch (caught) {
          const failure = caught as Error & { stderr?: string };
          const detail = `${failure.message || String(caught)}\n${failure.stderr || ''}`;
          const compatibilityRequired = /operation not permitted|pthread_create|clone3/i.test(detail);
          if (compatibilityRequired && !this.compatibilityMode()) {
            throw Object.assign(isolatedBrowserError(
              'This Docker Engine requires explicit legacy Docker compatibility mode for the isolated Browser',
              'ISOLATED_BROWSER_COMPATIBILITY_REQUIRED',
            ), { compatibilityRequired: true });
          }
          failures.push(`${image.split('@')[0]}: ${failure.message || String(caught)}`);
        }
      }
      throw isolatedBrowserError(
        `Isolated Browser preparation failed from every reviewed source: ${failures.join('; ')}`,
        'ISOLATED_BROWSER_PREPARE_FAILED',
        503,
      );
    })().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  async recover(): Promise<void> {
    let result;
    try {
      result = await this.docker([
        'ps', '-aq',
        '--filter', 'label=farming.dev/kind=isolated-browser',
        '--filter', `label=farming.dev/config=${this.configFingerprint}`,
      ], { timeoutMs: 10_000 });
    } catch {
      return;
    }
    for (const id of result.stdout.split(/\s+/).filter(Boolean)) {
      let inspect;
      try {
        inspect = await this.inspectOwnedContainer(id);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (dockerObjectNotFound(error) || code === 'ISOLATED_BROWSER_CONTAINER_OWNER_MISMATCH') {
          continue;
        }
        throw error;
      }
      if (recordValue(inspect.State).Running === true) {
        await this.docker(['stop', '--time', '10', id], { timeoutMs: 30_000 });
      }
    }
  }

  acquire(owner: IsolatedBrowserOwner): Promise<{ cdpUrl: string; leaseKey: string }> {
    const leaseKey = String(owner.ownerKey || '').trim();
    if (!leaseKey) {
      return Promise.reject(isolatedBrowserError(
        'An isolated Browser owner is required',
        'ISOLATED_BROWSER_OWNER_REQUIRED',
        400,
      ));
    }
    return this.enqueue(leaseKey, async () => {
      const capability = await this.capability();
      if (capability.available !== true) {
        throw isolatedBrowserError(
          capability.dockerAvailable
            ? 'Prepare the isolated Browser runtime before starting this Browser'
            : 'Docker is required for the isolated Browser',
          capability.dockerAvailable
            ? 'ISOLATED_BROWSER_IMAGE_NOT_READY'
            : 'ISOLATED_BROWSER_DOCKER_NOT_AVAILABLE',
          503,
        );
      }
      const currentLeases = this.leases.get(leaseKey) || 0;
      if (currentLeases > 0) {
        const inspect = await this.inspectOwnedContainer(this.containerName(leaseKey), leaseKey);
        const port = publishedPort(inspect);
        if (!port) throw isolatedBrowserError(
          'The isolated Browser container has no loopback DevTools port',
          'ISOLATED_BROWSER_PORT_MISSING',
        );
        await waitForCdp(port, 2_000);
        this.leases.set(leaseKey, currentLeases + 1);
        return { cdpUrl: `http://127.0.0.1:${port}`, leaseKey };
      }

      const containerName = this.containerName(leaseKey);
      let inspect = await this.findOwnedContainer(containerName, leaseKey);
      if (inspect && !this.hasCurrentCompatibilityMode(inspect)) {
        if (recordValue(inspect.State).Running === true) {
          await this.docker(['stop', '--time', '10', String(inspect.Id)], { timeoutMs: 30_000 });
        }
        await this.docker(['rm', String(inspect.Id)], { timeoutMs: 30_000 });
        inspect = null;
      }
      if (!inspect) {
        const create = await this.docker([
          'create',
          '--name', containerName,
          ...this.labels(leaseKey).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--cpus', '2',
          '--memory', '4g',
          '--shm-size', '1g',
          '--pids-limit', '1024',
          ...(this.compatibilityMode() ? ['--security-opt', 'seccomp=unconfined'] : []),
          '--user', 'root',
          '--entrypoint', '/bin/sh',
          '-p', '127.0.0.1::9223',
          '-e', 'DISPLAY=:100',
          String(capability.image || this.selectedImage || ISOLATED_BROWSER_IMAGE),
          '-lc',
          [
            'mkdir -p /tmp/.X11-unix;',
            'chmod 1777 /tmp/.X11-unix;',
            'su -s /bin/sh -c \'Xvfb :100 -screen 0 1280x800x24 -nolisten tcp\' user >/tmp/farming-xvfb.log 2>&1 &',
            'exec sleep 2147483647',
          ].join(' '),
        ]);
        const containerId = create.stdout.trim();
        if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
          throw isolatedBrowserError(
            'Docker did not return an exact isolated Browser container identity',
            'ISOLATED_BROWSER_CONTAINER_IDENTITY_MISSING',
          );
        }
        inspect = await this.inspectOwnedContainer(containerId, leaseKey);
      }
      const containerId = String(inspect.Id || '');
      await this.docker(['start', containerId]);
      inspect = await this.inspectOwnedContainer(containerId, leaseKey);
      const port = publishedPort(inspect);
      if (!port) throw isolatedBrowserError(
        'Docker did not publish the isolated Browser DevTools endpoint on loopback',
        'ISOLATED_BROWSER_PORT_MISSING',
      );
      try {
        await this.startChromium(containerId, port);
      } catch (caught) {
        try {
          await this.docker(['stop', '--time', '10', containerId], { timeoutMs: 30_000 });
        } catch {
          // Preserve the original startup error. Recovery will stop the exact labeled container.
        }
        throw caught;
      }
      this.leases.set(leaseKey, 1);
      return { cdpUrl: `http://127.0.0.1:${port}`, leaseKey };
    });
  }

  release(leaseKey: string): Promise<void> {
    return this.enqueue(leaseKey, async () => {
      const current = this.leases.get(leaseKey) || 0;
      if (current > 1) {
        this.leases.set(leaseKey, current - 1);
        return;
      }
      const inspect = await this.findOwnedContainer(this.containerName(leaseKey), leaseKey);
      if (inspect && recordValue(inspect.State).Running === true) {
        await this.docker(['stop', '--time', '10', String(inspect.Id)], { timeoutMs: 30_000 });
      }
      this.leases.delete(leaseKey);
    });
  }

  async deleteOwner(ownerKey: string): Promise<void> {
    await this.enqueue(ownerKey, async () => {
      const inspect = await this.findOwnedContainer(this.containerName(ownerKey), ownerKey);
      if (inspect) {
        if (recordValue(inspect.State).Running === true) {
          await this.docker(['stop', '--time', '10', String(inspect.Id)], { timeoutMs: 30_000 });
        }
        await this.docker(['rm', String(inspect.Id)], { timeoutMs: 30_000 });
      }
      this.leases.delete(ownerKey);
    });
  }

  private async startChromium(containerId: string, port: number): Promise<void> {
    try {
      await waitForCdp(port, 500);
      return;
    } catch {
      // The container is ready but Chromium has not been launched yet.
    }
    const displayReady = await this.waitForContainer(containerId, [
      'test', '-S', '/tmp/.X11-unix/X100',
    ]);
    if (!displayReady) {
      throw isolatedBrowserError(
        'The isolated Browser display did not become ready in time',
        'ISOLATED_BROWSER_DISPLAY_TIMEOUT',
        504,
      );
    }
    const chromiumReady = await this.containerCdpReady(containerId);
    if (!chromiumReady) {
      await this.docker([
        'exec', '-d', '-u', 'user',
        '-e', 'HOME=/home/user',
        '-e', 'DISPLAY=:100',
        containerId,
        '/usr/bin/chromium',
        '--remote-debugging-port=9222',
        '--user-data-dir=/home/user/.farming-browser',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ], { timeoutMs: 10_000 });
      const ready = await this.waitForContainer(containerId, [
        'python3', '-c',
        'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)',
      ]);
      if (!ready) {
        throw isolatedBrowserError(
          'Chromium did not expose its internal DevTools endpoint in time',
          'ISOLATED_BROWSER_CHROMIUM_TIMEOUT',
          504,
        );
      }
    }
    await this.docker([
      'exec', '-d', '-u', 'user',
      containerId,
      'python3', '-c', ISOLATED_BROWSER_RELAY_SCRIPT,
    ], { timeoutMs: 10_000 });
    await waitForCdp(port);
  }

  private async rankedImageSources(): Promise<string[]> {
    const probes = await Promise.all(ISOLATED_BROWSER_IMAGE_SOURCES.map(async (image, index) => {
      const startedAt = Date.now();
      try {
        await this.docker(['manifest', 'inspect', image], {
          timeoutMs: 8_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { image, index, reachable: true, latencyMs: Date.now() - startedAt };
      } catch {
        return { image, index, reachable: false, latencyMs: Number.MAX_SAFE_INTEGER };
      }
    }));
    return probes.sort((left, right) =>
      Number(right.reachable) - Number(left.reachable)
      || left.latencyMs - right.latencyMs
      || left.index - right.index
    ).map(probe => probe.image);
  }

  private async containerCdpReady(containerId: string): Promise<boolean> {
    try {
      await this.docker([
        'exec', containerId,
        'python3', '-c',
        'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)',
      ], { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async waitForContainer(containerId: string, command: string[]): Promise<boolean> {
    const deadline = Date.now() + ISOLATED_BROWSER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.docker(['exec', containerId, ...command], { timeoutMs: 3_000 });
        return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    return false;
  }

  private containerName(ownerKey: string): string {
    const owner = crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 12);
    return safeNamePart(`farming-browser-${this.configFingerprint}-${owner}`);
  }

  private labels(ownerKey: string): Array<[string, string]> {
    return [
      ['farming.dev/kind', 'isolated-browser'],
      ['farming.dev/config', this.configFingerprint],
      ['farming.dev/owner', ownerKey],
      ['farming.dev/image-digest', ISOLATED_BROWSER_IMAGE_DIGEST],
      ['farming.dev/compatibility', this.compatibilityMode() ? 'legacy-seccomp' : 'default'],
    ];
  }

  private hasCurrentCompatibilityMode(inspect: Record<string, unknown>): boolean {
    const labels = recordValue(recordValue(inspect.Config).Labels);
    return labels['farming.dev/compatibility']
      === (this.compatibilityMode() ? 'legacy-seccomp' : 'default');
  }

  private async inspectOwnedContainer(
    identity: string,
    expectedOwnerKey = '',
  ): Promise<Record<string, unknown>> {
    const inspect = await this.readContainer(identity);
    if (!inspect.Id) {
      throw isolatedBrowserError(
        'Docker returned no isolated Browser container identity',
        'ISOLATED_BROWSER_CONTAINER_IDENTITY_MISSING',
      );
    }
    const labels = recordValue(recordValue(inspect.Config).Labels);
    if (
      labels['farming.dev/kind'] !== 'isolated-browser'
      || labels['farming.dev/config'] !== this.configFingerprint
      || labels['farming.dev/image-digest'] !== ISOLATED_BROWSER_IMAGE_DIGEST
      || (expectedOwnerKey && labels['farming.dev/owner'] !== expectedOwnerKey)
      || (expectedOwnerKey && !this.hasCurrentCompatibilityMode(inspect))
    ) {
      throw isolatedBrowserError(
        'The isolated Browser container ownership labels do not match this Farming instance',
        'ISOLATED_BROWSER_CONTAINER_OWNER_MISMATCH',
      );
    }
    return inspect;
  }

  private async findOwnedContainer(
    identity: string,
    expectedOwnerKey: string,
  ): Promise<Record<string, unknown> | null> {
    let inspect;
    try {
      inspect = await this.readContainer(identity);
    } catch (error) {
      if (dockerObjectNotFound(error)) return null;
      throw error;
    }
    const labels = recordValue(recordValue(inspect.Config).Labels);
    if (
      labels['farming.dev/kind'] !== 'isolated-browser'
      || labels['farming.dev/config'] !== this.configFingerprint
      || labels['farming.dev/image-digest'] !== ISOLATED_BROWSER_IMAGE_DIGEST
      || labels['farming.dev/owner'] !== expectedOwnerKey
    ) {
      throw isolatedBrowserError(
        'The isolated Browser container ownership labels do not match this Farming instance',
        'ISOLATED_BROWSER_CONTAINER_OWNER_MISMATCH',
      );
    }
    return inspect;
  }

  private async readContainer(identity: string): Promise<Record<string, unknown>> {
    const result = await this.docker(['inspect', identity], { timeoutMs: 10_000 });
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? recordValue(parsed[0]) : {};
  }

  private enqueue<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.operations.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.finally(() => {
      if (this.operations.get(key) === tracked) this.operations.delete(key);
    });
    this.operations.set(key, tracked);
    return tracked;
  }
}

export {
  ISOLATED_BROWSER_IMAGE,
  ISOLATED_BROWSER_IMAGE_DIGEST,
  IsolatedBrowserProvider,
};
