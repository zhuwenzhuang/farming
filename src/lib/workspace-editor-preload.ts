export const WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'shell',
  'java',
  'cpp',
  'csharp',
  'go',
  'rust',
  'sql',
  'yaml',
] as const

export function createWorkspaceEditorLanguagePreloader(
  warmLanguage: (languageId: string) => Promise<unknown>,
  languageIds: readonly string[] = WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS,
) {
  let preloadPromise: Promise<void> | null = null

  return function preloadWorkspaceEditorLanguages() {
    if (!preloadPromise) {
      preloadPromise = Promise.allSettled(languageIds.map(warmLanguage)).then(() => undefined)
    }
    return preloadPromise
  }
}
