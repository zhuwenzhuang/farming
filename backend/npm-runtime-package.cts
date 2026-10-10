import fs from 'node:fs';
import path from 'node:path';

/** Source/standalone images embed runtimes; npm images declare an exact carrier. */
export function npmRuntimePackageRoot(packageRoot: string, platformKey: string): string {
  const platform = platformKey.replace(/-musl$/, '');
  if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(platform)) {
    throw new Error(`Unsupported Farming runtime platform: ${platform}`);
  }
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return packageRoot;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    farmingRuntimePackages?: number;
    optionalDependencies?: Record<string, string>;
  };
  if (manifest.farmingRuntimePackages === undefined) return packageRoot;
  if (manifest.farmingRuntimePackages !== 1) throw new Error('Unsupported Farming runtime package layout');
  const name = `farming-code-runtime-${platform}`;
  const pin = manifest.optionalDependencies?.[name];
  if (!pin?.startsWith('npm:farming-code@')) throw new Error(`Missing runtime package pin: ${name}`);
  const directory = path.join(packageRoot, 'node_modules', name);
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      name?: string; version?: string; farmingRuntimePlatform?: string;
    };
    if (installed.name !== 'farming-code' || installed.version !== pin.slice('npm:farming-code@'.length)
      || installed.farmingRuntimePlatform !== platform
      || !fs.realpathSync(directory).startsWith(`${fs.realpathSync(packageRoot)}${path.sep}`)) {
      throw new Error('Runtime package identity mismatch');
    }
  } catch (cause) {
    throw new Error(`Farming runtime package ${name} is missing or invalid; reinstall with optional dependencies enabled.`, { cause });
  }
  return directory;
}
