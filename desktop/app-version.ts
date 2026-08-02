import fs from 'node:fs'

const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function resolveDesktopServerVersion(options: {
  electronVersion: string
  packageJsonPath: string
  isPackaged: boolean
  overrideVersion?: string
}) {
  const { electronVersion, packageJsonPath, isPackaged } = options
  const override = options.overrideVersion?.trim()
  if (override) return override
  const reported = electronVersion.trim()
  if (isPackaged && reported && !/^0\.0(?:\.0)?$/.test(reported)) return reported
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
    if (PACKAGE_VERSION_PATTERN.test(version)) return version
  } catch (error) {
    if (!isPackaged) {
      throw new Error(`Could not resolve the Farming Server version from ${packageJsonPath}.`, { cause: error })
    }
  }
  if (!isPackaged) throw new Error(`Farming Server version is missing or invalid in ${packageJsonPath}.`)
  return reported || '0.0.0'
}
