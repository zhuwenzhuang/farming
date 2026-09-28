import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Chinese strong punctuation renders safely in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'markdown-reader')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'example.md'), [
      '# 中文加粗',
      '',
      '- **不会越重试越高。**判断的是 attempt 类型。',
      '- **不会跨越 stage 的顺序。**NaturalOrder 保留档位。',
      '- 这是**“重点”**然后继续。',
      '- **使用 `code` 和 [链接](https://example.com)。**继续。',
      '',
      '`**代码。**正文`',
      '',
      '\\*\\*转义。\\*\\*正文',
      '',
      '```md',
      '**围栏。**正文',
      '```',
    ].join('\n'))
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace, name: 'Markdown reader' },
    })
    expect(response.ok()).toBeTruthy()
    await openFarming(page)
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    const sidebar = page.getByTestId('code-sidebar')
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      await page.getByTestId('code-mobile-menu').click()
    }
    const files = page.getByTestId('code-project-group').filter({ hasText: 'markdown-reader' }).getByTestId('code-files-section')
    const title = files.locator('.code-files-title')
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
    await files.locator('[data-testid="code-file-row"][data-file-path="example.md"]').click()
    const preview = page.getByTestId('code-file-markdown-preview')
    await expect(preview.getByRole('heading', { name: '中文加粗' })).toBeVisible()
    await expect(preview.locator('strong')).toHaveText([
      '不会越重试越高。', '不会跨越 stage 的顺序。', '“重点”', '使用 code 和 链接。',
    ])
    await expect(preview.locator('strong').first()).toHaveCSS('font-weight', '700')
    await expect(preview.locator('pre code')).toHaveText('**围栏。**正文\n')
    await expect(preview).toContainText('**转义。**正文')
    await expect(preview.locator('code').filter({ hasText: '**代码。**正文' })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await testInfo.attach(`chinese-strong-${appearance}`, {
      body: await preview.screenshot({ animations: 'disabled' }), contentType: 'image/png',
    })
  })
}
