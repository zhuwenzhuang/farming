import assert from 'node:assert/strict'
import {
  transcriptGitDiffSearchParams,
  transcriptGitDiffTargetForRepository,
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

console.log('Transcript Git diff tests passed')
