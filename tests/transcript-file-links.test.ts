/// <reference path="../src/types/monaco-link-computer.d.ts" />
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TRANSCRIPT_FILE_EXTENSIONS,
  TRANSCRIPT_SPECIAL_FILENAMES,
  fileReferenceDisplayText,
  hasQualifiedTranscriptFileReference,
  isBareDomainTranscriptHref,
  isExternalTranscriptHref,
  isTranscriptFileLineHref,
  normalizeTranscriptHref,
  stripCandidateLocationSuffix,
  transcriptFileTargetFromText,
  transcriptImageFilePath,
} from '../src/lib/transcript-file-links'

const WORKSPACE_ROOT = '/repo'

test('transcript file-link vocabulary keeps the pinned extension and filename sets', () => {
  for (const extension of ['ts', 'tsx', 'md', 'py', 'jsonl', 'sql', 'webp']) {
    assert.equal(TRANSCRIPT_FILE_EXTENSIONS.has(extension), true)
  }
  assert.equal(TRANSCRIPT_FILE_EXTENSIONS.has('exe'), false)
  for (const name of ['BUILD', 'BUCK', 'Dockerfile', 'Makefile', 'WORKSPACE']) {
    assert.equal(TRANSCRIPT_SPECIAL_FILENAMES.has(name), true)
  }
  assert.equal(TRANSCRIPT_SPECIAL_FILENAMES.has('makefile'), false)
})

test('transcript file targets resolve workspace-relative paths with locations', () => {
  assert.deepEqual(transcriptFileTargetFromText('src/lib/foo.ts:12:3', WORKSPACE_ROOT), {
    filePath: 'src/lib/foo.ts',
    target: { lineNumber: 12, column: 3, endColumn: undefined },
  })
  assert.deepEqual(transcriptFileTargetFromText('src/lib/foo.ts:12', WORKSPACE_ROOT), {
    filePath: 'src/lib/foo.ts',
    target: { lineNumber: 12, column: undefined, endColumn: undefined },
  })
  assert.deepEqual(transcriptFileTargetFromText('src/lib/foo.ts', WORKSPACE_ROOT), {
    filePath: 'src/lib/foo.ts',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('src/lib/foo.ts:5:1-8', WORKSPACE_ROOT), {
    filePath: 'src/lib/foo.ts',
    target: { lineNumber: 5, column: 1, endColumn: 8 },
  })
  assert.deepEqual(transcriptFileTargetFromText('notes.txt:41:7-9', WORKSPACE_ROOT), {
    filePath: 'notes.txt',
    target: { lineNumber: 41, column: 7, endColumn: 9 },
  })
  assert.deepEqual(transcriptFileTargetFromText('src\\win\\foo.ts', WORKSPACE_ROOT), {
    filePath: 'src/win/foo.ts',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('./rel/file.py', WORKSPACE_ROOT), {
    filePath: 'rel/file.py',
    target: {},
  })
})

test('transcript file targets resolve absolute paths inside the workspace', () => {
  assert.deepEqual(transcriptFileTargetFromText('/repo/src/app.ts', WORKSPACE_ROOT), {
    filePath: 'src/app.ts',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('/repo/io%20proxy%E5%8F%91%E5%B8%83/ue_projects_export.txt', WORKSPACE_ROOT), {
    filePath: 'io proxy发布/ue_projects_export.txt',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('/repo/io proxy发布/ue_projects_export.txt', WORKSPACE_ROOT), {
    filePath: 'io proxy发布/ue_projects_export.txt',
    target: {},
  })
})

test('transcript file targets fall back to global workspace files outside the workspace', () => {
  assert.deepEqual(transcriptFileTargetFromText('/opt/external/app.ts:7', WORKSPACE_ROOT), {
    filePath: 'opt/external/app.ts',
    target: { lineNumber: 7, column: undefined, endColumn: undefined, globalRoot: true },
  })
  assert.deepEqual(transcriptFileTargetFromText('/opt/external/app.ts', WORKSPACE_ROOT), {
    filePath: 'opt/external/app.ts',
    target: { globalRoot: true },
  })
})

test('transcript file targets accept bare names and special filenames', () => {
  assert.deepEqual(transcriptFileTargetFromText('foo.ts', WORKSPACE_ROOT), {
    filePath: 'foo.ts',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('README.md', WORKSPACE_ROOT), {
    filePath: 'README.md',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('Makefile', WORKSPACE_ROOT), {
    filePath: 'Makefile',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('src/Makefile', WORKSPACE_ROOT), {
    filePath: 'src/Makefile',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('./Makefile', WORKSPACE_ROOT), {
    filePath: 'Makefile',
    target: {},
  })
  assert.deepEqual(transcriptFileTargetFromText('path/to/BUILD:5', WORKSPACE_ROOT), {
    filePath: 'path/to/BUILD',
    target: { lineNumber: 5, column: undefined, endColumn: undefined },
  })
})

test('transcript file targets reject external, unknown, and unqualified references', () => {
  assert.equal(transcriptFileTargetFromText('https://example.com/x.ts', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('example.com/x.ts', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('sub.example.com:8080/page?q=1', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('/etc/hosts', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('../outside/x.ts', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('~/notes.md', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('foo.unknownext', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('#anchor', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('', WORKSPACE_ROOT), null)
  assert.equal(transcriptFileTargetFromText('   ', WORKSPACE_ROOT), null)
})

test('stripCandidateLocationSuffix removes only recognized location suffixes', () => {
  assert.equal(stripCandidateLocationSuffix('src/foo.ts:12:3'), 'src/foo.ts')
  assert.equal(stripCandidateLocationSuffix('notes.txt:41:7-9'), 'notes.txt')
  assert.equal(stripCandidateLocationSuffix('a/b/c.rs:7'), 'a/b/c.rs')
  assert.equal(stripCandidateLocationSuffix('hello:12'), 'hello')
  assert.equal(stripCandidateLocationSuffix('plain'), 'plain')
})

test('fileReferenceDisplayText shows the basename with a location only after line 1', () => {
  assert.equal(fileReferenceDisplayText('src/lib/foo.ts', 12), 'foo.ts:12')
  assert.equal(fileReferenceDisplayText('src/lib/foo.ts', 1), 'foo.ts')
  assert.equal(fileReferenceDisplayText('src/lib/foo.ts'), 'foo.ts')
  assert.equal(fileReferenceDisplayText('src/lib/foo.ts:12:3'), 'foo.ts')
  assert.equal(fileReferenceDisplayText('src\\win\\foo.ts', 4), 'foo.ts:4')
})

test('qualified transcript file references require a path qualifier or location', () => {
  assert.equal(hasQualifiedTranscriptFileReference('src/foo.ts'), true)
  assert.equal(hasQualifiedTranscriptFileReference('foo.ts:12'), true)
  assert.equal(hasQualifiedTranscriptFileReference('/abs/foo.ts'), true)
  assert.equal(hasQualifiedTranscriptFileReference('~/foo.ts'), true)
  assert.equal(hasQualifiedTranscriptFileReference('../foo.ts'), true)
  assert.equal(hasQualifiedTranscriptFileReference('src/Makefile'), true)
  assert.equal(hasQualifiedTranscriptFileReference('foo.ts'), false)
  assert.equal(hasQualifiedTranscriptFileReference('./foo.ts'), false)
  assert.equal(hasQualifiedTranscriptFileReference('Makefile'), false)
  assert.equal(hasQualifiedTranscriptFileReference('foo.unknownext'), false)
  assert.equal(hasQualifiedTranscriptFileReference(''), false)
  assert.equal(hasQualifiedTranscriptFileReference('  '), false)
})

test('bare domain transcript hrefs require a host, tld, and location', () => {
  assert.equal(isBareDomainTranscriptHref('example.com/x'), true)
  assert.equal(isBareDomainTranscriptHref('example.com:8080/x?q'), true)
  assert.equal(isBareDomainTranscriptHref('sub.example.com/'), true)
  assert.equal(isBareDomainTranscriptHref('examplecom'), false)
  assert.equal(isBareDomainTranscriptHref('/path/file'), false)
  assert.equal(isBareDomainTranscriptHref('localhost:3000/x'), false)
  assert.equal(isBareDomainTranscriptHref('a.b'), false)
  assert.equal(isBareDomainTranscriptHref('example.com'), false)
})

test('normalizeTranscriptHref upgrades bare domain hrefs only', () => {
  assert.equal(normalizeTranscriptHref('example.com/page'), 'https://example.com/page')
  assert.equal(normalizeTranscriptHref('  example.com/x  '), 'https://example.com/x')
  assert.equal(normalizeTranscriptHref('https://example.com'), 'https://example.com')
  assert.equal(normalizeTranscriptHref('src/foo.ts'), 'src/foo.ts')
})

test('external transcript hrefs keep file-line references internal', () => {
  assert.equal(isExternalTranscriptHref('https://example.com'), true)
  assert.equal(isExternalTranscriptHref('example.com/page'), true)
  assert.equal(isExternalTranscriptHref('mailto:a@b.c'), true)
  assert.equal(isExternalTranscriptHref('ftp://x/y'), true)
  assert.equal(isExternalTranscriptHref('src/foo.ts:12'), false)
  assert.equal(isExternalTranscriptHref('src/foo.ts'), false)
  assert.equal(isExternalTranscriptHref('example.com/x.ts:12'), false)
})

test('file-line transcript hrefs require a recognized path with a line number', () => {
  assert.equal(isTranscriptFileLineHref('src/foo.ts:12'), true)
  assert.equal(isTranscriptFileLineHref('notes.txt:1'), true)
  assert.equal(isTranscriptFileLineHref('/repo/io%20proxy%E5%8F%91%E5%B8%83/notes.txt:2'), true)
  assert.equal(isTranscriptFileLineHref('path/to/BUILD:5'), true)
  assert.equal(isTranscriptFileLineHref('src/foo.ts'), false)
  assert.equal(isTranscriptFileLineHref('example.com/x:12'), false)
})

test('transcript image detection only covers rendered image formats', () => {
  assert.equal(transcriptImageFilePath('a/b.png'), true)
  assert.equal(transcriptImageFilePath('x.JPG'), true)
  assert.equal(transcriptImageFilePath('y.jpeg'), true)
  assert.equal(transcriptImageFilePath('z.gif'), true)
  assert.equal(transcriptImageFilePath('w.webp'), true)
  assert.equal(transcriptImageFilePath('v.svg'), false)
  assert.equal(transcriptImageFilePath('u.md'), false)
})
