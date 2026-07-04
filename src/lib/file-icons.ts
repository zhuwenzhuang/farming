import materialIcons from 'material-icon-theme/dist/material-icons.json'
import { appPath } from '@/lib/base-path'

type IconManifest = {
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  file: string
  folder: string
  folderExpanded: string
}

const iconManifest = materialIcons as IconManifest

const fileIconUrl = iconUrlForId('file')
const folderIconUrl = iconUrlForId('folder')
const folderOpenIconUrl = iconUrlForId('folder-open')

function iconUrlForId(iconId: string) {
  return appPath(`/vendor/material-icons/${encodeURIComponent(iconId)}.svg`)
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function extensionCandidates(fileName: string) {
  const parts = fileName.toLowerCase().split('.').filter(Boolean)
  const candidates: string[] = []

  for (let index = 1; index < parts.length; index += 1) {
    candidates.push(parts.slice(index).join('.'))
  }

  return candidates
}

function urlForIconId(iconId: string | undefined, fallback: string) {
  return iconId ? iconUrlForId(iconId) : fallback
}

function folderIconForSignal(signal: string, map: Record<string, string>) {
  const normalized = signal.toLowerCase()
  const extensionIconId = iconManifest.fileExtensions[normalized]
  return map[normalized] ?? (extensionIconId ? map[extensionIconId] : undefined)
}

export function iconForFilePath(filePath: string) {
  const name = basename(filePath)
  const lowerName = name.toLowerCase()
  const fileNameIcon = iconManifest.fileNames[lowerName] ?? iconManifest.fileNames[name]
  if (fileNameIcon) return urlForIconId(fileNameIcon, fileIconUrl)

  for (const extension of extensionCandidates(name)) {
    const iconId = iconManifest.fileExtensions[extension]
    if (iconId) return urlForIconId(iconId, fileIconUrl)
  }

  return urlForIconId(iconManifest.file, fileIconUrl)
}

export function iconForDirectoryPath(directoryPath: string, expanded: boolean, contentSignals: string[] = []) {
  const name = basename(directoryPath).toLowerCase()
  const map = expanded ? iconManifest.folderNamesExpanded : iconManifest.folderNames
  const fallback = expanded ? folderOpenIconUrl : folderIconUrl
  const defaultIconId = expanded ? iconManifest.folderExpanded : iconManifest.folder

  for (const signal of contentSignals) {
    const iconId = folderIconForSignal(signal, map)
    if (iconId) return urlForIconId(iconId, fallback)
  }

  return urlForIconId(map[name] ?? defaultIconId, fallback)
}
