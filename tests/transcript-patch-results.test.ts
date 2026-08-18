import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPatchResultLine,
  mergePatchRows,
  normalizeTranscriptPath,
  parsePatchResultLine,
  patchDiffLineClass,
  patchResultLines,
  patchResultSummary,
  patchResultTitle,
  patchRowsHaveUncommittedChanges,
  patchRowsForChanges,
  patchRowsForItems,
  workspaceRelativeTranscriptPath,
} from '../src/components/code/transcript-patch-results'
import type { AgentTranscriptProcessItem } from '../src/components/code/acp/acp-entry-projection'

function patchItem(detail: string, changes?: AgentTranscriptProcessItem['changes']) {
  return { type: 'patch', detail, changes } as AgentTranscriptProcessItem
}

test('patch result lines accept git status and verb forms only', () => {
  assert.ok(isPatchResultLine('M src/app.ts'))
  assert.ok(isPatchResultLine('A docs/readme.md'))
  assert.ok(isPatchResultLine('updated src/app.ts +3 -1'))
  assert.ok(isPatchResultLine('Renamed old.ts'))
  assert.ok(!isPatchResultLine('Success. All files were edited.'))
  assert.ok(!isPatchResultLine('some prose about the change'))
})

test('parse extracts git status kind and path', () => {
  assert.deepEqual(parsePatchResultLine('M src/app.ts'), {
    kind: 'M',
    path: 'src/app.ts',
    added: '',
    removed: '',
  })
})

test('parse extracts verb, path, and trailing stats', () => {
  assert.deepEqual(parsePatchResultLine('updated src/app.ts +3 -1'), {
    kind: 'updated',
    path: 'src/app.ts',
    added: '+3',
    removed: '-1',
  })
  assert.deepEqual(parsePatchResultLine('add docs/new.md +12'), {
    kind: 'add',
    path: 'docs/new.md',
    added: '+12',
    removed: '',
  })
})

test('patch result lines drop success banners, blanks, and cap at 16 rows', () => {
  const detail = ['Success. Updated files.', '', ...Array.from({ length: 20 }, (_, i) => `M file-${i}.ts`)].join('\n')
  const lines = patchResultLines(patchItem(detail))
  assert.equal(lines.length, 16)
  assert.equal(lines[0], 'M file-0.ts')
})

test('transcript paths normalize separators and duplicate slashes', () => {
  assert.equal(normalizeTranscriptPath('a\\b\\\\c'), 'a/b/c')
  assert.equal(normalizeTranscriptPath('  /a//b/c '), '/a/b/c')
})

test('workspace-relative paths strip the root and its /private aliases', () => {
  assert.equal(workspaceRelativeTranscriptPath('/repo/src/app.ts', '/repo'), 'src/app.ts')
  assert.equal(workspaceRelativeTranscriptPath('/repo', '/repo'), '')
  assert.equal(workspaceRelativeTranscriptPath('/tmp/ws/a.ts', '/private/tmp/ws'), 'a.ts')
  assert.equal(workspaceRelativeTranscriptPath('/private/tmp/ws/a.ts', '/tmp/ws'), 'a.ts')
  assert.equal(workspaceRelativeTranscriptPath('/elsewhere/a.ts', '/repo'), '/elsewhere/a.ts')
})

test('merged rows dedupe by display path and prefer rows with stats', () => {
  const rows = mergePatchRows([
    { kind: 'update', path: '/repo/src/app.ts', added: '', removed: '' },
    { kind: 'update', path: 'src/app.ts', added: '+3', removed: '-1' },
    { kind: 'update', path: 'src/app.ts', added: '', removed: '' },
  ], '/repo')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { kind: 'update', path: 'src/app.ts', added: '+3', removed: '-1' })
})

test('structured changes format stats and suppress zero counters', () => {
  assert.deepEqual(patchRowsForChanges([
    { kind: 'update', path: '/repo/a.ts', added: 3, removed: 0 },
  ], '/repo'), [{ kind: 'update', path: 'a.ts', added: '+3', removed: '' }])
})

test('item rows prefer structured changes over parsed detail lines', () => {
  const rows = patchRowsForItems([
    patchItem('updated ignored.ts +9', [{ kind: 'add', path: '/repo/real.ts', added: 1, removed: 0 }]),
    patchItem('updated parsed.ts +2 -2'),
  ], '/repo')
  assert.deepEqual(rows.map(row => row.path), ['real.ts', 'parsed.ts'])
})

test('patch rows overlap only their current uncommitted workspace paths', () => {
  const rows = [{ kind: 'updated', path: '/repo/src/app.ts', added: '+1', removed: '-1' }]
  assert.equal(patchRowsHaveUncommittedChanges(
    rows,
    new Set(['src/app.ts', 'unrelated.ts']),
    '/repo',
  ), true)
  assert.equal(patchRowsHaveUncommittedChanges(rows, new Set(['unrelated.ts']), '/repo'), false)
  assert.equal(patchRowsHaveUncommittedChanges(rows, new Set(), '/repo'), false)
  assert.equal(patchRowsHaveUncommittedChanges(rows, null, '/repo'), false)
})

test('patch titles and summaries stay singular, plural, and failure aware', () => {
  assert.equal(patchResultTitle(1, false), 'Edited 1 file')
  assert.equal(patchResultTitle(2, false), 'Edited 2 files')
  assert.equal(patchResultTitle(1, true), 'Failed editing 1 file')
  assert.equal(patchResultSummary(1, false), '1 file changed')
  assert.equal(patchResultSummary(3, false), '3 files changed')
  assert.equal(patchResultSummary(2, true), 'Failed editing 2 files')
})

test('diff line classes exclude file headers from added and removed', () => {
  assert.equal(patchDiffLineClass('+new line'), 'added')
  assert.equal(patchDiffLineClass('+++ b/file'), '')
  assert.equal(patchDiffLineClass('-old line'), 'removed')
  assert.equal(patchDiffLineClass('--- a/file'), '')
  assert.equal(patchDiffLineClass('@@ -1,4 +1,6 @@'), 'hunk')
  assert.equal(patchDiffLineClass('Index: file'), 'meta')
  assert.equal(patchDiffLineClass('context'), '')
})
