import type { ReviewFile } from './state'

function zeroSha() {
  return '0'.repeat(40)
}

function patchIndexLine(file: ReviewFile) {
  if (!file.oldSha && !file.newSha) return null
  const oldSha = file.kind === 'added' ? zeroSha() : file.oldSha
  const newSha = file.kind === 'deleted' ? zeroSha() : file.newSha
  if (!oldSha || !newSha) return null
  const mode = file.oldMode && file.oldMode === file.newMode ? ` ${file.oldMode}` : ''
  return `index ${oldSha}..${newSha}${mode}`
}

function fallbackDiffHeader(file: ReviewFile) {
  const oldPath = file.kind === 'added' ? '/dev/null' : `a/${file.previousPath ?? file.path}`
  const newPath = file.kind === 'deleted' ? '/dev/null' : `b/${file.path}`
  const lines = [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`]
  if (file.kind === 'added' && file.newMode) lines.push(`new file mode ${file.newMode}`)
  if (file.kind === 'deleted' && file.oldMode) lines.push(`deleted file mode ${file.oldMode}`)
  if (file.kind !== 'added' && file.kind !== 'deleted' && file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    lines.push(`old mode ${file.oldMode}`)
    lines.push(`new mode ${file.newMode}`)
  }
  const indexLine = patchIndexLine(file)
  if (indexLine) lines.push(indexLine)
  if (file.diff.hunks.length > 0) {
    lines.push(`--- ${oldPath}`)
    lines.push(`+++ ${newPath}`)
  }
  return lines
}

export function reviewFilesToPatchText(files: readonly ReviewFile[]) {
  return files.flatMap(file => {
    const lines = file.diff.diffHeader?.length
      ? [...file.diff.diffHeader]
      : fallbackDiffHeader(file)
    for (const hunk of file.diff.hunks) {
      lines.push(hunk.header)
      for (const row of hunk.rows) {
        if (row.kind === 'skipped') continue
        if (row.kind === 'context') lines.push(` ${row.right?.text ?? row.left?.text ?? ''}`)
        if (row.kind === 'deleted' || row.kind === 'changed') lines.push(`-${row.left?.text ?? ''}`)
        if (row.kind === 'changed') lines.push(`+${row.right?.text ?? ''}`)
        if (row.kind === 'added') lines.push(`+${row.right?.text ?? ''}`)
      }
    }
    return lines
  }).join('\n')
}
