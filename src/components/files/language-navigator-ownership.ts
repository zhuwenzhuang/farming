export interface LanguageNavigatorSource {
  rootId: string
  filePath: string
  generation: number
}

export interface LanguageNavigatorFileScope {
  rootId: string
  filePath: string
}

export function sameLanguageNavigatorSource(
  left: LanguageNavigatorSource | null,
  right: LanguageNavigatorSource,
) {
  return Boolean(
    left
    && left.rootId === right.rootId
    && left.filePath === right.filePath
    && left.generation === right.generation,
  )
}

export function sameLanguageNavigatorFile(
  left: LanguageNavigatorSource | null,
  right: LanguageNavigatorSource,
) {
  return Boolean(left && left.rootId === right.rootId && left.filePath === right.filePath)
}

export function languageNavigatorSourceIsActive(
  activeFile: LanguageNavigatorFileScope,
  source: LanguageNavigatorSource,
) {
  return activeFile.rootId === source.rootId && activeFile.filePath === source.filePath
}

export function languageNavigatorRequestIsCurrent(
  activeFile: LanguageNavigatorFileScope,
  navigatorSource: LanguageNavigatorSource | null,
  requestSource: LanguageNavigatorSource,
) {
  return languageNavigatorSourceIsActive(activeFile, requestSource)
    && sameLanguageNavigatorSource(navigatorSource, requestSource)
}

export function languageNavigatorNodeRoot(
  activeFile: LanguageNavigatorFileScope,
  source: LanguageNavigatorSource,
) {
  return languageNavigatorSourceIsActive(activeFile, source) ? source.rootId : null
}

export function nextLanguageNavigatorDirectionSource(
  activeFile: LanguageNavigatorFileScope,
  currentSource: LanguageNavigatorSource | null,
  generation: number,
): LanguageNavigatorSource | null {
  if (!currentSource || !languageNavigatorSourceIsActive(activeFile, currentSource)) return null
  return { rootId: currentSource.rootId, filePath: currentSource.filePath, generation }
}
