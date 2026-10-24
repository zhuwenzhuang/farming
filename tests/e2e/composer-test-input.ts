import type { ComposerInputElement } from '../../src/components/code/composer-input-element'
import type { Locator } from '@playwright/test'
import { expect } from './fixtures'

export async function expectValue(input: Locator, value: string) {
  await expect.poll(() => input.evaluate(element => {
    const owner = element instanceof HTMLTextAreaElement ? element : element.parentElement as ComposerInputElement
    return owner.value
  })).toBe(value)
}
export async function selectText(input: Locator, start?: number, end?: number) {
  await input.evaluate((element, range) => {
    const owner = element instanceof HTMLTextAreaElement ? element : element.parentElement as ComposerInputElement
    owner.setSelectionRange(range[0] ?? owner.value.length, range[1] ?? owner.value.length)
  }, [start, end])
}
export async function selection(input: Locator) {
  return input.evaluate(element => {
    const owner = element instanceof HTMLTextAreaElement ? element : element.parentElement as ComposerInputElement
    return [owner.selectionStart, owner.selectionEnd]
  })
}
