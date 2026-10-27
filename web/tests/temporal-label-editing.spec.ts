import { test, expect } from './fixtures'
import { openEditor, selection, copy, wordPoint } from './editorTestHelpers'

const uri = 'sillage://videos/42/sources/17?start_ms=78546'

for (const label of ['1:18', 'Un passage intéressant']) {
  test('clic : sélection exacte et remplacement du libellé ' + label, async ({ page }) => {
    const link = '[' + label + '](' + uri + ')'
    const text = 'Avant ' + link + ' après'
    const { editor, writes } = await openEditor(page, text)
    const original = await editor.elementHandle()
    const compact = editor.locator('.cm-temporal-reference')
    await compact.click()
    const from = text.indexOf(label)
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + label.length, text: label, doc: text })
    expect(await copy(editor)).toBe(label)
    await expect(editor).toBeFocused()
    await expect(compact).toHaveCount(0)
    await page.waitForTimeout(2100)
    expect(writes).toEqual([])
    await page.keyboard.insertText('Nouveau libellé')
    const updated = text.replace(label, 'Nouveau libellé')
    expect((await selection(editor)).doc).toBe(updated)
    expect((await selection(editor)).doc.split('](')[1].split(')')[0]).toBe(uri)
    await expect.poll(() => writes).toEqual([updated])
    await page.keyboard.press('Control+z')
    expect((await selection(editor)).doc).toBe(text)
    await page.keyboard.press('Control+Shift+z')
    expect((await selection(editor)).doc).toBe(updated)
    expect(await original!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  })
}

test('source révélée : un clic place un curseur, le double clic reste natif', async ({ page }) => {
  const label = 'Premier passage'
  const text = '[' + label + '](' + uri + ')'
  const { editor, writes } = await openEditor(page, text)
  await editor.locator('.cm-temporal-reference').click()
  const point = await wordPoint(editor.locator('.cm-line'), 'passage')
  await page.mouse.click(point.x, point.y)
  const clicked = await selection(editor)
  expect(clicked.anchor).toBe(clicked.head)
  expect(clicked.head).toBeGreaterThan(1)
  expect(clicked.head).toBeLessThan(1 + label.length)
  await page.mouse.dblclick(point.x, point.y, { delay: 120 })
  expect((await selection(editor)).text).toBe('passage')
  expect(writes).toEqual([])
})

for (const prefix of ['', '###### **']) {
  for (const delay of [0, 120]) {
    test('double clic commencé sur le widget : cible conservée, délai=' + delay + ', titre=' + Boolean(prefix), async ({ page }) => {
      const link = '[1:18](' + uri + ')'
      const text = 'Avant\n' + prefix + link + (prefix ? '**' : '') + ' [voisin](' + uri + ')\naprès'
      const { editor, writes } = await openEditor(page, text)
      await editor.locator('.cm-temporal-reference').first().dblclick({ delay })
      const from = text.indexOf('1:18')
      expect(await selection(editor)).toMatchObject({ anchor: from, head: from + 4, text: '1:18', doc: text })
      expect(writes).toEqual([])
    })
  }
}

test('horloge de callout : révélation avec curseur dans l’URI, sans sélectionner un faux libellé', async ({ page }) => {
  const text = '> [!quote:tr](' + uri + ') Titre\n> Corps'
  const { editor, writes } = await openEditor(page, text)
  await editor.locator('.cm-temporal-reference').click()
  const selected = await selection(editor)
  expect(selected.anchor).toBe(selected.head)
  expect(selected.head).toBe(text.indexOf(uri) + 1)
  expect(selected.doc).toBe(text)
  expect(writes).toEqual([])
})

for (const reversed of [false, true]) {
  test('glisser commencé sur le widget : sélection source conservée, inversé=' + reversed, async ({ page }) => {
    const label = 'Passage'
    const text = 'Début [' + label + '](' + uri + ') Fin'
    const { editor, writes } = await openEditor(page, text)
    const compact = editor.locator('.cm-temporal-reference')
    const box = (await compact.boundingBox())!
    const line = (await editor.locator('.cm-line').boundingBox())!
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(reversed ? line.x : line.x + line.width - 1, start.y, { steps: 10 })
    await expect(compact).toHaveCount(1)
    await page.mouse.up()
    const from = text.indexOf(label)
    const to = from + label.length
    expect(await selection(editor)).toMatchObject({
      anchor: reversed ? to : from,
      head: reversed ? 0 : text.length,
      text: reversed ? text.slice(0, to) : text.slice(from),
      doc: text,
    })
    expect(await copy(editor)).toBe(reversed ? text.slice(0, to) : text.slice(from))
    expect(writes).toEqual([])
  })
}

test('collage et formes non compactables conservées sans réparation', async ({ page }) => {
  const text = '[1:18](' + uri + ')'
  const { editor, writes } = await openEditor(page, text)
  await editor.locator('.cm-temporal-reference').click()
  const pasted = '**Nouveau**'
  await editor.evaluate((element, value) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', value)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, pasted)
  expect((await selection(editor)).doc).toBe('[' + pasted + '](' + uri + ')')
  await page.keyboard.press('Control+End')
  await expect(editor.locator('.cm-temporal-reference')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  await page.keyboard.press('Control+End')
  await editor.locator('.cm-temporal-reference').click()
  await page.keyboard.press('Backspace')
  expect((await selection(editor)).doc).toBe('[](' + uri + ')')
  await page.keyboard.press('Control+End')
  await expect(editor.locator('.cm-temporal-reference')).toHaveCount(0)
  expect(writes).toEqual([])
})

test('menu : refus inline, transformation de bloc et absence de réouverture après Échap', async ({ page }) => {
  const text = 'Avant\n[1:18](' + uri + ')\naprès'
  const { editor, writes } = await openEditor(page, text)
  await editor.locator('.cm-temporal-reference').click()
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  for (const name of ['Gras', 'Italique', 'Code inline', 'Lien']) {
    await expect(toolbar.getByRole('button', { name, exact: true })).toHaveAttribute('aria-disabled', 'true')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(toolbar).toHaveCount(0)
  expect(writes).toEqual([])
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Style du texte' }).click()
  await page.getByRole('button', { name: 'H2', exact: true }).click()
  expect((await selection(editor)).doc).toBe(text.replace('[1:18]', '## [1:18]'))
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
})

test.describe('tactile Chromium simulé', () => {
  test.use({
    hasTouch: true,
    viewport: { width: 375, height: 700 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  })

  test('tap : même sélection de libellé, puis composition EditContext', async ({ page, context }) => {
    const text = 'Avant [1:18](' + uri + ') après'
    const { editor, writes } = await openEditor(page, text)
    await editor.locator('.cm-temporal-reference').tap()
    const from = text.indexOf('1:18')
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + 4, text: '1:18', doc: text, editContext: true })
    await expect(editor).toBeFocused()
    expect(writes).toEqual([])
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '見出し', selectionStart: 3, selectionEnd: 3 })
    await cdp.send('Input.insertText', { text: '見出し' })
    const committed = await selection(editor)
    await page.waitForTimeout(300)
    expect(await selection(editor)).toEqual(committed)
    expect(committed.doc).toBe(text.replace('1:18', '見出し'))
    await expect.poll(() => writes).toEqual([text.replace('1:18', '見出し')])
    await page.keyboard.press('Control+z')
    expect((await selection(editor)).doc).toBe(text)
    await cdp.detach()
  })

  test('scroll commencé sur le widget : aucune activation de remplacement', async ({ page, context }) => {
    const text = '[Passage](' + uri + ')\n' + 'Prose ordinaire\n'.repeat(100)
    const { editor, writes } = await openEditor(page, text)
    const box = (await editor.locator('.cm-temporal-reference').boundingBox())!
    const cdp = await context.newCDPSession(page)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 15 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
    const selected = await selection(editor)
    expect(selected.anchor).toBe(selected.head)
    expect(selected.doc).toBe(text)
    expect(writes).toEqual([])
    await cdp.detach()
  })

  test('appui long sur le widget : conserver la sélection et le menu natifs', async ({ page, context }) => {
    const text = '[Premier passage utile](' + uri + ') après'
    const { editor, writes } = await openEditor(page, text)
    const box = (await editor.locator('.cm-temporal-reference').boundingBox())!
    const cdp = await context.newCDPSession(page)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(650)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    expect((await selection(editor)).text).not.toBe('Premier passage utile')
    expect((await selection(editor)).doc).toBe(text)
    expect(writes).toEqual([])
    await cdp.detach()
  })
})

test.describe('taps successifs Chromium simulés', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 700 } })

  test('un nouveau tap sur un autre widget sélectionne son propre libellé', async ({ page }) => {
    const text = '[Premier](' + uri + ') puis [Second](' + uri + ')'
    const { editor, writes } = await openEditor(page, text)
    await editor.locator('.cm-temporal-reference').first().tap()
    expect((await selection(editor)).text).toBe('Premier')
    await editor.locator('.cm-temporal-reference').tap()
    expect((await selection(editor)).text).toBe('Second')
    expect((await selection(editor)).doc).toBe(text)
    expect(writes).toEqual([])
  })

  test('double tap commencé sur le widget ne sélectionne pas l’URI voisine', async ({ page }) => {
    const text = '###### **[1:18](' + uri + ')** [voisin](' + uri + ')'
    const { editor, writes } = await openEditor(page, text)
    const box = (await editor.locator('.cm-temporal-reference').first().boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.touchscreen.tap(x, y)
    await page.waitForTimeout(120)
    await page.touchscreen.tap(x, y)
    const current = await selection(editor)
    expect(current.doc).toBe(text)
    expect(current.anchor).toBeGreaterThanOrEqual(text.indexOf('1:18'))
    expect(current.head).toBeGreaterThanOrEqual(text.indexOf('1:18'))
    expect(current.anchor).toBeLessThanOrEqual(text.indexOf('1:18') + 4)
    expect(current.head).toBeLessThanOrEqual(text.indexOf('1:18') + 4)
    expect(writes).toEqual([])
  })
})

test('composition DOM après sélection automatique : remplacement et reprise sans altérer l’URI', async ({ page }) => {
  const text = 'Avant [1:18](' + uri + ') après'
  const { editor, writes } = await openEditor(page, text)
  await editor.locator('.cm-temporal-reference').click()
  await editor.dispatchEvent('compositionstart')
  await page.keyboard.insertText('見出し')
  await editor.dispatchEvent('compositionend')
  const committed = await selection(editor)
  await page.waitForTimeout(300)
  expect(await selection(editor)).toEqual(committed)
  expect(committed.doc).toBe(text.replace('1:18', '見出し'))
  expect(writes).toEqual([])
  await expect.poll(() => writes).toEqual([text.replace('1:18', '見出し')])
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
})
