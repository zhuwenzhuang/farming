import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBehaviorE2ePort } from '../scripts/run-behavior-e2e'

test('critical behavior browser tests allocate an isolated port by default', async () => {
  let allocations = 0
  const port = await resolveBehaviorE2ePort({}, async () => {
    allocations += 1
    return 43123
  })
  assert.equal(port, 43123)
  assert.equal(allocations, 1)
})

test('critical behavior browser tests honor an explicit valid port', async () => {
  const port = await resolveBehaviorE2ePort({ FARMING_PLAYWRIGHT_PORT: '43124' }, async () => {
    throw new Error('an explicit port must not allocate another port')
  })
  assert.equal(port, 43124)
})

test('critical behavior browser tests reject invalid explicit ports', async () => {
  await assert.rejects(
    resolveBehaviorE2ePort({ FARMING_PLAYWRIGHT_PORT: '70000' }),
    /Invalid FARMING_PLAYWRIGHT_PORT/,
  )
})
