export const CODE_STYLE_SOURCES = [
  'src/styles/tokens.css',
  'src/styles/main.css',
  'src/styles/settings.css',
  'src/styles/share.css',
  'src/styles/sidebar-resources.css',
  'src/styles/code-dark.css',
  'src/styles/settings-dark.css',
  'src/styles/share-dark.css',
] as const

export type CodeStyleSourcePath = typeof CODE_STYLE_SOURCES[number]
