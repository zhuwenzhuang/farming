import assert from 'node:assert/strict'
import test from 'node:test'
import { tokenDisplayLines } from '../src/components/code/ShareQrButton'

test('keeps non-Chinese share passphrases on one line', () => {
  assert.deepEqual(
    tokenDisplayLines('spring-rain-softly-falls'),
    ['spring-rain-softly-falls'],
  )
})

test('keeps Chinese share passphrase segments available for multiline display', () => {
  assert.deepEqual(
    tokenDisplayLines('春风轻拂长堤岸边-轻落庭前幽静深处-一枝梅花悄然盛开'),
    ['春风轻拂长堤岸边', '轻落庭前幽静深处', '一枝梅花悄然盛开'],
  )
})
