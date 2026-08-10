export const CODE_STYLE_SOURCES = [
  'src/styles/tokens.css',
  'src/styles/main.css',
  'src/styles/file-editor.css',
  'src/styles/pet.css',
  'src/styles/git-history.css',
  'src/styles/composer.css',
  'src/styles/plugin.css',
  'src/styles/settings.css',
  'src/styles/share.css',
  'src/styles/sidebar-resources.css',
  'src/styles/code-dark.css',
  'src/styles/file-editor-dark.css',
  'src/styles/pet-dark.css',
  'src/styles/git-history-dark.css',
  'src/styles/composer-dark.css',
  'src/styles/plugin-dark.css',
  'src/styles/settings-dark.css',
  'src/styles/share-dark.css',
] as const

export type CodeStyleSourcePath = typeof CODE_STYLE_SOURCES[number]
