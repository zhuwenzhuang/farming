import assert from 'node:assert/strict'
import test from 'node:test'
import { requestCodexModelCatalog } from '../src/components/code/useCodexModelCatalog'

test('Codex model catalog request encodes the home and normalizes visible options', async () => {
  const urls: string[] = []
  const catalog = await requestCodexModelCatalog('home /one', async url => {
    urls.push(url)
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          catalog: [
            { value: 'gpt-5.5', label: 'GPT 5.5' },
            { value: 42, label: 'invalid' },
          ],
        }
      },
    }
  })

  assert.deepEqual(urls, ['/api/codex/models?homeId=home+%2Fone'])
  assert.deepEqual(catalog, [{ value: 'gpt-5.5', label: 'GPT 5.5' }])
})

test('Codex model catalog propagates the backend error', async () => {
  await assert.rejects(
    requestCodexModelCatalog('default', async () => ({
      ok: false,
      status: 503,
      async json() { return { error: 'Catalog unavailable' } },
    })),
    /Catalog unavailable/,
  )
})
