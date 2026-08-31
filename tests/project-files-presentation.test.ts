import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { codeCopyForLanguage } from '../src/components/code/copy'
import { FileSearchResults } from '../src/components/files/FileSearchResults'
import { FileSectionHeader } from '../src/components/files/FileSectionHeader'
import { OpenEditorsSection } from '../src/components/files/OpenEditorsSection'
import { workspaceFileOpenTargetForChange } from '../src/lib/workspace-open-files'

const copy = codeCopyForLanguage('en')
const emptyRef = { current: null }

function renderHeader(overrides: Partial<Parameters<typeof FileSectionHeader>[0]> = {}) {
  return renderToStaticMarkup(createElement(FileSectionHeader, {
    copy,
    filesCollapsed: false,
    refreshStatus: 'idle',
    search: {
      active: false,
      inputRef: emptyRef,
      listboxId: 'project-files-search',
      query: '',
    },
    onCancelPendingFileFocus: () => {},
    onFileSearchKeyDown: () => {},
    onRefreshFiles: () => {},
    onSearchQueryChange: () => {},
    onToggleFilesCollapsed: () => {},
    ...overrides,
  }))
}

function renderSearchResults(overrides: Partial<Parameters<typeof FileSearchResults>[0]> = {}) {
  return renderToStaticMarkup(createElement(FileSearchResults, {
    activeMatchIndex: 0,
    anchorRef: emptyRef,
    copy,
    error: null,
    jumpTarget: null,
    listboxId: 'project-files-search',
    loading: false,
    matches: [],
    openFileError: null,
    query: 'app',
    showIgnoredSearch: false,
    timeoutMs: 1_000,
    truncated: false,
    onOpenJumpQuery: () => {},
    onOpenMatch: () => {},
    onSearchIgnored: () => {},
    onSelectMatchIndex: () => {},
    ...overrides,
  }))
}

test('Files header exposes search and refresh states through native accessibility semantics', () => {
  const collapsed = renderHeader({ filesCollapsed: true })
  assert.match(collapsed, /aria-expanded="false"/)
  assert.doesNotMatch(collapsed, /role="combobox"/)

  const refreshing = renderHeader({
    refreshStatus: 'refreshing',
    search: {
      active: true,
      activeOptionId: 'project-files-search-1',
      inputRef: emptyRef,
      listboxId: 'project-files-search',
      query: 'app',
    },
  })
  assert.match(refreshing, /role="combobox"/)
  assert.match(refreshing, /aria-controls="project-files-search"/)
  assert.match(refreshing, /aria-activedescendant="project-files-search-1"/)
  assert.match(refreshing, /aria-busy="true"/)
  assert.match(refreshing, /disabled=""/)
  assert.match(refreshing, new RegExp(copy.refreshingFiles))
  assert.match(refreshing, /role="status"/)
})

test('Files search renders selectable path and content results with the active option', () => {
  const markup = renderSearchResults({
    activeMatchIndex: 1,
    matches: [
      {
        entryType: 'directory',
        kind: 'path',
        lineNumber: 0,
        lines: '',
        path: 'src/components',
        ranges: [],
      },
      {
        entryType: 'file',
        kind: 'content',
        lineNumber: 12,
        lines: 'const app = createApp()',
        path: 'src/App.tsx',
        ranges: [{ start: 6, end: 9 }],
      },
    ],
  })

  assert.match(markup, /id="project-files-search"/)
  assert.match(markup, /role="listbox"/)
  assert.match(markup, /id="project-files-search-0"/)
  assert.match(markup, /id="project-files-search-1"/)
  assert.match(markup, /aria-selected="false"/)
  assert.match(markup, /aria-selected="true"/)
  assert.match(markup, /src\/components/)
  assert.match(markup, /src\/App\.tsx/)
  assert.match(markup, /code-file-search-highlight/)
})

test('Files search keeps no-result recovery and direct path-line navigation distinct', () => {
  const noMatches = renderSearchResults({
    showIgnoredSearch: true,
    timeoutMs: 750,
    truncated: true,
  })
  assert.match(noMatches, new RegExp(copy.noMatches))
  assert.match(noMatches, new RegExp(copy.searchIgnoredFolders))
  assert.match(noMatches, new RegExp(copy.searchIncomplete(750)))

  const jump = renderSearchResults({
    jumpTarget: { path: 'src/App.tsx', lineNumber: 42, column: 3 },
  })
  assert.match(jump, /id="project-files-search-jump"/)
  assert.match(jump, /role="option"/)
  assert.match(jump, /aria-selected="true"/)
  assert.match(jump, /code-file-search-name/)
  assert.match(jump, /code-file-search-directory">src<\/span>/)
  assert.match(jump, />42<\/span>/)
})

test('Open Editors bounds the visible list and presents local versus external changes', () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    agentId: 'agent-1',
    dirty: index === 0,
    externalChanged: index === 1,
    key: `file-${index}`,
    path: `src/File${index}.ts`,
  }))
  const markup = renderToStaticMarkup(createElement(OpenEditorsSection, {
    activeFilePath: 'src/File1.ts',
    collapsed: false,
    copy,
    files,
    projectId: 'project-1',
    onCloseOpenFile: () => {},
    onToggleCollapsed: () => {},
  }))

  assert.match(markup, /data-open-editor-count="8"/)
  assert.match(markup, /data-visible-editor-count="7"/)
  assert.match(markup, /--code-open-editors-visible-rows:7/)
  assert.doesNotMatch(markup, /--code-open-editors-list-max-height/)
  assert.match(markup, /code-open-editor-row active/)
  assert.match(markup, /code-open-editor-state dirty/)
  assert.match(markup, /code-open-editor-state external/)
  assert.match(markup, new RegExp(copy.closeFile('src/File0.ts')))
})

test('Changes preserve the correct editor target for modified, untracked, and deleted files', () => {
  const common = { name: 'App.tsx', path: 'src/App.tsx', type: 'file' as const }

  assert.deepEqual(workspaceFileOpenTargetForChange({
    ...common,
    gitStatus: 'modified',
    gitStatusLabel: 'M',
  }), {
    diffOnly: false,
    gitStatus: 'modified',
    gitStatusLabel: 'M',
    revealInTree: false,
    view: 'diff',
  })
  assert.deepEqual(workspaceFileOpenTargetForChange({
    ...common,
    gitStatus: 'untracked',
    gitStatusLabel: 'U',
  }), {
    diffOnly: false,
    gitStatus: 'untracked',
    gitStatusLabel: 'U',
    revealInTree: false,
    view: 'editor',
  })
  assert.deepEqual(workspaceFileOpenTargetForChange({
    ...common,
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
  }), {
    diffOnly: true,
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
    revealInTree: false,
    view: 'diff',
  })
})
