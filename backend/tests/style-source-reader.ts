import fs from 'node:fs'
import path from 'node:path'
import { CODE_STYLE_SOURCES, type CodeStyleSourcePath } from '../../src/styles/code-style-sources'

export type { CodeStyleSourcePath } from '../../src/styles/code-style-sources'

const projectRoot = path.join(__dirname, '..', '..')

export function readCodeStyleSource(sourcePath: CodeStyleSourcePath) {
  return fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8')
}

export function readCodeStyleSources() {
  return CODE_STYLE_SOURCES.map(sourcePath => ({
    path: sourcePath,
    source: readCodeStyleSource(sourcePath),
  }))
}

export function readCodeBaseStyles() {
  return readCodeStyles()
}

export function readCodeDarkStyles() {
  return readCodeStyleSource('src/styles/tokens.css')
}

export function readCodeStyles() {
  return readCodeStyleSources().map(source => source.source).join('\n')
}
