import { selectTheme } from './navigationHelpers'
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
  await selectTheme(page, 'dark')
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

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark'] as const) {
    test('six niveaux harmonisés, styles inline et source intacte ' + width + ' ' + theme, async ({ page, request }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/headingtypo' } })).json()
      const noteURL = '/api/v1/videos/' + video.id + '/note'
      const content = 'Prose de référence.\n\n' + [1, 2, 3, 4, 5, 6].map(level =>
        '#'.repeat(level) + ' Titre ' + level + ' [lien](https://example.org) et \x60code\x60 ###',
      ).join('\n\n') + '\n\nFin.'
      await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
      let writes = 0
      page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith('/note')) writes++ })
      await page.goto('/videos/' + video.id)
      await selectTheme(page, theme)
      const editor = page.getByRole('textbox', { name: 'Note Markdown' })
      await expect(editor).toBeVisible()
      const original = await editor.elementHandle()
      const sizes = [1.618, 1.462, 1.318, 1.188, 1.076, 1]
      const weights = [700, 680, 660, 640, 620, 600]
      const heights = [1.2, 1.2, 1.3, 1.4, 1.5, 1.5]
      for (let level = 1; level <= 6; level++) {
        const heading = editor.locator('.cm-note-h' + level)
        await expect(heading).toHaveText('Titre ' + level + ' [lien](https://example.org) et \x60code\x60')
        const style = await heading.evaluate(el => {
          const css = getComputedStyle(el)
          return { size: parseFloat(css.fontSize), weight: css.fontWeight, height: parseFloat(css.lineHeight), style: css.fontStyle }
        })
        expect(style.size).toBeCloseTo(16 * sizes[level - 1], 2)
        expect(style.weight).toBe(String(weights[level - 1]))
        expect(style.height).toBeCloseTo(style.size * heights[level - 1], 2)
        expect(style.style).toBe('normal')
        for (const fragment of await heading.locator('span').all()) {
          const css = await fragment.evaluate(el => {
            const css = getComputedStyle(el)
            return { size: parseFloat(css.fontSize), decoration: css.textDecorationLine, text: el.textContent }
          })
          expect(css.size).toBeCloseTo(style.size, 2)
          if (css.text === 'Titre ' + level + ' ') expect(css.decoration).toBe('none')
        }
        expect(await heading.locator('.cm-markdown-code').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
      }
      await page.screenshot({ path: info.outputPath('headings-editing.png'), fullPage: true })
      await editor.locator('.cm-note-h1').click()
      await expect(editor.locator('.cm-note-h1')).toContainText('# ')
      expect(await editor.locator('.cm-note-h1').evaluate(el => parseFloat(getComputedStyle(el).fontSize)))
        .toBeCloseTo(16 * sizes[0], 2)
      await page.screenshot({ path: info.outputPath('headings-source.png'), fullPage: true })
      await page.getByRole('button', { name: 'Lecture', exact: true }).click()
      const reading = page.getByLabel('Lecture de la note')
      for (let level = 1; level <= 6; level++) {
        const heading = reading.locator('h' + level)
        const css = await heading.evaluate(el => {
          const css = getComputedStyle(el)
          return { size: parseFloat(css.fontSize), weight: css.fontWeight, decoration: css.textDecorationLine, style: css.fontStyle }
        })
        expect(css.size).toBeCloseTo(16 * sizes[level - 1], 2)
        expect(css.weight).toBe(String(weights[level - 1]))
        expect(css.decoration).toBe('none')
        expect(css.style).toBe('normal')
        await expect(heading.locator('a')).toHaveCSS('text-decoration-line', 'underline')
        expect(await heading.locator('code').evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
      }
      await page.screenshot({ path: info.outputPath('headings-reading.png'), fullPage: true })
      await page.getByRole('button', { name: 'Édition', exact: true }).click()
      await page.getByRole('tab', { name: 'Informations', exact: true }).click()
      await page.getByRole('tab', { name: 'Note', exact: true }).click()
      expect(await original!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
      await page.waitForTimeout(2100)
      expect(writes).toBe(0)
      expect((await (await request.get(noteURL)).json()).content_md).toBe(content)
    })
  }
}
