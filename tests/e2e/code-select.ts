import { expect, type Locator } from '@playwright/test'

export async function codeSelectOptions(trigger: Locator) {
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const options = trigger.locator('xpath=..').getByRole('option')
  await expect(options.first()).toBeVisible()
  return options.evaluateAll(items => items.map(item => ({
    disabled: (item as HTMLButtonElement).disabled,
    label: item.textContent?.trim() || '',
    value: item.getAttribute('data-value') || '',
  })))
}

export async function selectCodeOption(trigger: Locator, value: string) {
  if (await trigger.getAttribute('data-value') === value) return
  const options = await codeSelectOptions(trigger)
  const index = options.findIndex(option => option.value === value)
  expect(index, `CodeSelect option ${value} should exist`).toBeGreaterThanOrEqual(0)
  await trigger.locator('xpath=..').getByRole('option').nth(index).click()
  await expect(trigger).toHaveAttribute('data-value', value)
}
