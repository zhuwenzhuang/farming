import { expect, openFarming, test } from './fixtures'

test('keeps editor and rich-preview runtimes out of the initial Web load', async ({ page }) => {
  const initialScripts = new Set<string>()
  page.on('request', request => {
    if (request.resourceType() !== 'script') return
    initialScripts.add(new URL(request.url()).pathname.split('/').pop() || '')
  })

  await openFarming(page)
  await expect(page.getByTestId('code-new-agent')).toBeEnabled()

  expect(Array.from(initialScripts).filter(fileName => (
    /^FileEditorPane-/u.test(fileName)
    || /^workspace-editor-monaco-/u.test(fileName)
    || /^editor\.api2-/u.test(fileName)
    || /^FileEditorMarkdownPreview-/u.test(fileName)
  ))).toEqual([])
})
