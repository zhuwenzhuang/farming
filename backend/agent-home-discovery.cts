import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listProviderAdapters } from './provider-adapters.cjs';

export interface DiscoveredAgentHome {
  provider: string;
  path: string;
}

interface DiscoveryOptions {
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** One shallow, bounded scan; never execute shell profiles or read credentials. */
export async function discoverAgentHomes(options: DiscoveryOptions = {}): Promise<DiscoveredAgentHome[]> {
  const userHome = options.userHome || os.homedir();
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs ?? 3000;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error('Agent Home discovery timed out. Check that your Home directories are accessible.');
  function checkDeadline(): void {
    if (Date.now() >= deadline) throw timeoutError();
  }
  const listings = new Map<string, Promise<string[]>>();
  function names(directory: string): Promise<string[]> {
    let listing = listings.get(directory);
    if (!listing) {
      listing = (async () => {
        const result: string[] = [];
        try {
          const handle = await fs.opendir(directory);
          for await (const entry of handle) {
            checkDeadline();
            if (result.length >= 4096) throw new Error('Agent Home discovery exceeded 4096 directory entries.');
            result.push(entry.name);
          }
        } catch (error) {
          if (!absent(error)) throw error;
        }
        return result.sort();
      })();
      listings.set(directory, listing);
    }
    return listing;
  }
  async function scan(): Promise<DiscoveredAgentHome[]> {
    const homes: DiscoveredAgentHome[] = [];
    for (const provider of listProviderAdapters()) {
      const relative = provider.usage.defaultHomeDirectory;
      const parent = path.join(userHome, path.dirname(relative));
      const basename = path.basename(relative);
      const candidates = new Set([path.join(userHome, relative)]);
      if (provider.homeDiscoveryXdgDirectory) {
        const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(userHome, '.config');
        if (path.isAbsolute(configRoot)) candidates.add(path.join(configRoot, provider.homeDiscoveryXdgDirectory));
      }
      // Nested native layouts, such as ~/.pi/agent, may also have ~/.pi-work/agent.
      const [rootName, ...segments] = relative.split('/');
      if (segments.length > 0) {
        for (const name of await names(userHome)) {
          if (['.', '-', '_'].some(separator => name.startsWith(rootName + separator))) {
            candidates.add(path.join(userHome, name, ...segments));
          }
        }
      }
      const environmentHome = env[provider.homeEnvKey]?.trim();
      if (environmentHome) {
        const expanded = environmentHome.startsWith('~/')
          ? path.join(userHome, environmentHome.slice(2)) : environmentHome;
        if (path.isAbsolute(expanded)) candidates.add(expanded);
      }
      for (const name of await names(parent)) {
        if (['.', '-', '_'].some(separator => name.startsWith(basename + separator))) {
          candidates.add(path.join(parent, name));
        }
      }
      if (candidates.size > 256) throw new Error(`Too many ${provider.displayName} Home candidates (maximum 256).`);
      const seen = new Set<string>();
      for (const candidate of [...candidates].sort()) {
        checkDeadline();
        try {
          if (!(await fs.stat(candidate)).isDirectory()) continue;
          let recognized = false;
          for (const marker of provider.homeDiscoveryMarkers) {
            checkDeadline();
            try {
              const stat = await fs.stat(path.join(candidate, marker));
              if (stat.isFile() || stat.isDirectory()) { recognized = true; break; }
            } catch (error) { if (!absent(error)) throw error; }
          }
          if (!recognized) continue;
          const canonical = await fs.realpath(candidate);
          const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          if (seen.has(key)) continue;
          seen.add(key);
          homes.push({ provider: provider.id, path: canonical });
        } catch (error) { if (!absent(error)) throw error; }
      }
    }
    checkDeadline();
    return homes;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      scan(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
