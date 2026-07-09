import bashColor from './color/bash.svg'
import bashMonochrome from './monochrome/bash.svg'
import claudeColor from './color/claude.svg'
import claudeCodeColor from './color/claude-code.svg'
import qoderColor from './color/qoder.svg'
import zshColor from './color/zsh.svg'
import opencodeDark from './dark/opencode.svg'
import qoderDark from './dark/qoder.svg'
import zshDark from './dark/zsh.svg'
import claudeCodeMonochrome from './monochrome/claude-code.svg'
import claudeMonochrome from './monochrome/claude.svg'
import opencodeMonochrome from './monochrome/opencode.svg'
import qoderMonochrome from './monochrome/qoder.svg'
import zshMonochrome from './monochrome/zsh.svg'

export type AgentIconVariant = 'color' | 'monochrome'

export const agentIconAssets = {
  bash: { color: bashColor, monochrome: bashMonochrome },
  claude: { color: claudeColor, monochrome: claudeMonochrome },
  'claude-code': { color: claudeCodeColor, monochrome: claudeCodeMonochrome },
  opencode: { dark: opencodeDark, monochrome: opencodeMonochrome },
  qoder: { color: qoderColor, dark: qoderDark, monochrome: qoderMonochrome },
  zsh: { color: zshColor, dark: zshDark, monochrome: zshMonochrome },
} as const
