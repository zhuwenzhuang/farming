import assert from 'node:assert/strict'
import {
  transcriptGitDiffSearchParams,
  transcriptGitDiffTargetForRepository,
  transcriptUncommittedPathsForRepository,
} from '../../src/components/code/transcript-git-diff'

type ComparisonSources = Parameters<typeof transcriptGitDiffTargetForRepository>[0]

function comparisonSources(overrides: Partial<ComparisonSources> = {}): ComparisonSources {
  return {
    commits: [{
      base: '1'.repeat(40),
      head: '2'.repeat(40),
    }],
    staged: {
      available: false,
      base: '2'.repeat(40),
      head: '3'.repeat(40),
    },
    uncommittedPaths: [],
    unstaged: {
      available: false,
      base: '3'.repeat(40),
      head: 'now',
    },
    ...overrides,
  }
}

const committedTarget = transcriptGitDiffTargetForRepository(comparisonSources())
assert.deepEqual(committedTarget, {
  base: '1'.repeat(40),
  head: '2'.repeat(40),
  kind: 'last-commit',
})
assert.equal(
  transcriptGitDiffSearchParams('/workspace with space', committedTarget).toString(),
  `root=%2Fworkspace+with+space&base=${'1'.repeat(40)}&head=${'2'.repeat(40)}`,
)

assert.deepEqual(
  transcriptGitDiffTargetForRepository(comparisonSources({
    unstaged: {
      available: true,
      base: '3'.repeat(40),
      head: 'now',
    },
  })),
  { kind: 'working-copy' },
)
assert.deepEqual(
  transcriptGitDiffTargetForRepository(comparisonSources({
    staged: {
      available: true,
      base: '2'.repeat(40),
      head: '3'.repeat(40),
    },
  })),
  { kind: 'working-copy' },
)
assert.deepEqual(
  transcriptGitDiffTargetForRepository(comparisonSources({ commits: [] })),
  { kind: 'working-copy' },
)
assert.deepEqual(
  transcriptUncommittedPathsForRepository(comparisonSources({
    uncommittedPaths: ['src/app.ts', 'docs/readme.md', 'src/app.ts'],
  })),
  new Set(['src/app.ts', 'docs/readme.md']),
)

console.log('Transcript Git diff tests passed')
