const assert = require('node:assert/strict')

const {
  claimProjectListScroll,
  invalidateProjectListScroll,
} = require('../../src/lib/project-list-scroll-owner.ts')

const firstList = {}
const secondList = {}
const firstLease = claimProjectListScroll(firstList)
assert.equal(firstLease.isCurrent(), true)

const replacementLease = claimProjectListScroll(firstList)
assert.equal(firstLease.isCurrent(), false)
assert.equal(replacementLease.isCurrent(), true)

const independentLease = claimProjectListScroll(secondList)
assert.equal(replacementLease.isCurrent(), true)
assert.equal(independentLease.isCurrent(), true)

invalidateProjectListScroll(firstList)
assert.equal(replacementLease.isCurrent(), false)
assert.equal(independentLease.isCurrent(), true)

console.log('test-project-list-scroll-owner passed')
