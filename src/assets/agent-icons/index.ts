import bashColor from './color/bash.svg'
import bashMonochrome from './monochrome/bash.svg'
import claudeColor from './color/claude.svg'
import claudeCodeColor from './color/claude-code.svg'
import qoderColorMarkup from './color/qoder.svg?raw'
import zshColorMarkup from './color/zsh.svg?raw'
import opencodeDark from './dark/opencode.svg'
import qoderDarkMarkup from './dark/qoder.svg?raw'
import zshDarkMarkup from './dark/zsh.svg?raw'
import claudeCodeMonochrome from './monochrome/claude-code.svg'
import claudeMonochrome from './monochrome/claude.svg'
import opencodeMonochrome from './monochrome/opencode.svg'
import qoderMonochromeMarkup from './monochrome/qoder.svg?raw'
import zshMonochromeMarkup from './monochrome/zsh.svg?raw'

export type AgentIconVariant = 'color' | 'monochrome'

function svgContents(markup: string) {
  const match = markup.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/)
  if (!match?.[1]) throw new Error('Agent icon asset must contain a non-empty SVG root')
  return match[1]
}

export const agentIconAssets = {
  bash: { color: bashColor, monochrome: bashMonochrome },
  claude: { color: claudeColor, monochrome: claudeMonochrome },
  'claude-code': { color: claudeCodeColor, monochrome: claudeCodeMonochrome },
  opencode: { dark: opencodeDark, monochrome: opencodeMonochrome },
} as const

export const inlineAgentIconMarkup = {
  qoder: {
    color: svgContents(qoderColorMarkup),
    dark: svgContents(qoderDarkMarkup),
    monochrome: svgContents(qoderMonochromeMarkup),
  },
  zsh: {
    color: svgContents(zshColorMarkup),
    dark: svgContents(zshDarkMarkup),
    monochrome: svgContents(zshMonochromeMarkup),
  },
} as const
