import { test, expect } from './fixtures'

test('typographie commune, largeur utile et code monospace sans écriture ni remontage', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trtypo00001' } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  const content = [
    'Un paragraphe de prose avec des mots de largeurs différentes. '.repeat(8),
    '',
    'Du **gras**, de l’italique et du `code_inline` dans la prose.',
    '',
    '```javascript',
    '  const answer = 42;',
    '```',
    '',
    '    code_indente()',
    '',
    `> [!quote:tr](sillage://videos/${video.id}/sources/${video.sources[0].id}?start_ms=1234)`,
    '> Une citation conservée.',
  ].join('\n')
  await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  let writes = 0
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith('/note')) writes++ })
  await page.setViewportSize({ width: 1920, height: 1200 })
  await page.goto(`/videos/${video.id}`)
  await page.getByLabel('Thème', { exact: true }).selectOption('dark')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 1200 })
    await expect(editor).toHaveCSS('font-size', '16px')
    await expect(editor).toHaveCSS('line-height', '24px')
    const font = await editor.evaluate(el => getComputedStyle(el).fontFamily)
    expect(font).toContain('system-ui')
    for (const code of ['code_inline', 'const answer', 'code_indente']) {
      const mark = editor.locator('.cm-markdown-code').filter({ hasText: code }).first()
      await expect(mark).toBeVisible()
      expect(await mark.evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
    }
    const editing = await editor.locator('.cm-line').first().boundingBox()
    expect(editing!.width).toBeLessThanOrEqual(700.1)
    if (width === 1920) expect(editing!.width).toBeCloseTo(700, 0)
    await page.screenshot({ path: info.outputPath(`note-editing-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Lecture', exact: true }).click()
    const reading = page.getByLabel('Lecture de la note')
    await expect(reading).toHaveCSS('font-size', '16px')
    await expect(reading).toHaveCSS('line-height', '24px')
    await expect(reading).toHaveCSS('font-family', font)
    const paragraph = await reading.locator(':scope > p').first().boundingBox()
    expect(paragraph!.width).toBeCloseTo(editing!.width, 0)
    expect(paragraph!.x).toBeCloseTo(editing!.x, 0)
    for (const code of await reading.locator('code').all()) {
      expect(await code.evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`note-reading-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Édition', exact: true }).click()
    expect(await node!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
  }
  expect(writes).toBe(0)
  expect((await (await request.get(noteURL)).json()).content_md).toBe(content)
})
