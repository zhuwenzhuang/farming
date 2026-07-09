import materialIcons from 'material-icon-theme/dist/material-icons.json'
import { appPath } from '@/lib/base-path'

type IconManifest = {
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  file: string
}

const iconManifest = materialIcons as IconManifest

const fileIconUrl = iconUrlForId('file')
const folderIconUrl = iconUrlForId('folder')
const folderOpenIconUrl = iconUrlForId('folder-open')
const maxComputeOsqlIconUrl = `data:image/svg+xml,${encodeURIComponent('<svg class="svg-icon" style="width: 1.0048828125em; height: 1em;vertical-align: middle;fill: currentColor;overflow: hidden;" viewBox="0 0 1029 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M235.92448 443.27424l144.384 256.6144a152.11008 152.11008 0 0 1 42.496-5.46816l116.1216-445.02528a121.58976 121.58976 0 1 1 158.43328-23.28064l147.4304 229.376a121.71264 121.71264 0 0 1 153.63072 117.34016 121.58976 121.58976 0 1 1-214.97344-77.824l-147.97824-230.0416a121.52832 121.52832 0 0 1-26.2656 3.82464l-115.87072 444.05248a151.9872 151.9872 0 1 1-176.67072 22.85568L172.3904 479.0272c-58.7264 12.39552-117.71904-19.9168-138.89024-76.0832-21.1712-56.1664 1.8176-119.38304 54.1184-148.8384 52.30592-29.45024 118.272-16.32768 155.32544 30.8992 37.04832 47.22688 34.09408 114.42176-6.9632 158.21312l-0.05632 0.06144z" fill="#FF6A00" /></svg>')}`

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

export function iconForFilePath(filePath: string) {
  const name = basename(filePath)
  const lowerName = name.toLowerCase()
  if (lowerName.endsWith('.osql')) return maxComputeOsqlIconUrl

  const fileNameIcon = iconManifest.fileNames[lowerName] ?? iconManifest.fileNames[name]
  if (fileNameIcon) return urlForIconId(fileNameIcon, fileIconUrl)

  for (const extension of extensionCandidates(name)) {
    const iconId = iconManifest.fileExtensions[extension]
    if (iconId) return urlForIconId(iconId, fileIconUrl)
  }

  return urlForIconId(iconManifest.file, fileIconUrl)
}

export function iconForDirectoryPath(_directoryPath: string, expanded: boolean) {
  return expanded ? folderOpenIconUrl : folderIconUrl
}
