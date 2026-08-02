import fs from 'node:fs'

export function resolveDesktopServerVersion(electronVersion: string, packageJsonPath: string) {
  const reported = electronVersion.trim()
  if (reported && !/^0\.0(?:\.0)?$/.test(reported)) return reported
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
    if (version) return version
  } catch {
    // Packaged applications should always get their version from Electron.
  }
  return reported || '0.0.0'
}
