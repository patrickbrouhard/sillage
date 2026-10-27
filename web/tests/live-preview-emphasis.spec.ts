import { test, expect } from './fixtures'
import { openEditor, selection, copy, wordPoint } from './editorTestHelpers'
import { selectTheme } from './navigationHelpers'

test('révélation par expression, bornes inclusives et navigation/suppression natives', async ({ page }) => {
  const text = 'before\n**Alpha** puis _Beta_ et __Gamma__\nafter'
  const { editor, writes } = await openEditor(page, text)
  const line = editor.locator('.cm-line').nth(1)
  await expect(line).toHaveText('Alpha puis Beta et Gamma')
  await editor.focus()
  const start = text.indexOf('**')
  const end = start + '**Alpha**'.length
  for (const pos of [start, start + 1, start + 4, end - 1, end]) {
    await page.evaluate(value => window.editorProbe.select(value), pos)
    await expect(line).toHaveText('**Alpha** puis Beta et Gamma')
    expect(await selection(editor)).toMatchObject({ anchor: pos, head: pos })
  }
  await page.evaluate(pos => window.editorProbe.select(pos), start - 1)
  await page.keyboard.press('ArrowRight')
  await expect(line).toHaveText('**Alpha** puis Beta et Gamma')
  expect((await selection(editor)).head).toBe(start)
  await page.keyboard.press('Delete')
  expect((await selection(editor)).doc).toBe(text.slice(0, start) + text.slice(start + 1))
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  await page.evaluate(pos => window.editorProbe.select(pos), end)
  await page.keyboard.press('Backspace')
  expect((await selection(editor)).doc).toBe(text.slice(0, end - 1) + text.slice(end))
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  expect(writes).toEqual([])
})

for (const reversed of [false, true]) {
  test('adjacence, copie source et sélection traversante, inversée=' + reversed, async ({ page }) => {
    const text = 'before\n**Alpha** et _Beta_\n__Gamma__\nafter'
    const { editor, writes } = await openEditor(page, text)
    await editor.focus()
    const from = text.indexOf('**')
    const to = text.indexOf('_Beta')
    await page.evaluate(({ from, to, reversed }) =>
      window.editorProbe.select(reversed ? to : from, reversed ? from : to), { from, to, reversed })
    await expect(editor.locator('.cm-line').nth(1)).toHaveText('**Alpha** et Beta')
    expect(await copy(editor)).toBe(text.slice(from, to))
    expect(await selection(editor)).toMatchObject({
      anchor: reversed ? to : from, head: reversed ? from : to,
    })
    await editor.focus()
    await page.keyboard.press('Control+a')
    expect(await copy(editor)).toBe(text)
    await page.keyboard.press('Control+Home')
    await expect(editor.locator('.cm-line').nth(1)).toHaveText('Alpha et Beta')
    expect(writes).toEqual([])
  })
}

for (const sample of [
  { body: '**Alpha** et _Beta_', command: 'Gras', after: 'Alpha et _Beta_' },
  { body: '__Alpha__ et **Beta**', command: 'Gras', after: 'Alpha et **Beta**' },
  { body: '###### **Alpha** et _Beta_', command: 'Gras', after: '###### Alpha et _Beta_' },
  { body: '***Alpha*** et __Beta__', command: 'Gras', after: '*Alpha* et __Beta__' },
  { body: '**_Alpha_** et *Beta*', command: 'Italique', after: '**Alpha** et *Beta*' },
]) {
  test('double clic humain, menu et Undo : ' + sample.body, async ({ page }) => {
    const text = 'before\n' + sample.body + '\nafter'
    const { editor, writes } = await openEditor(page, text)
    const line = editor.locator('.cm-line').nth(1)
    const point = await wordPoint(line, 'Alpha')
    await page.mouse.dblclick(point.x, point.y, { delay: 120 })
    expect(await copy(editor)).toBe('Alpha')
    const from = text.indexOf('Alpha')
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + 5 })
    const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
    await expect(toolbar).toBeVisible()
    expect(writes).toEqual([])
    await toolbar.getByRole('button', { name: sample.command, exact: true }).click()
    expect((await selection(editor)).doc).toBe('before\n' + sample.after + '\nafter')
    expect((await selection(editor)).text).toBe('Alpha')
    await page.keyboard.press('Control+z')
    expect((await selection(editor)).doc).toBe(text)
    await page.keyboard.press('Control+Shift+z')
    expect((await selection(editor)).doc).toBe('before\n' + sample.after + '\nafter')
    await expect(toolbar).toHaveCount(0)
  })
}

for (const body of [
  '###### **Alpha** et _Beta_ puis **Gamma**',
  '###### __Alpha__ et *Beta* puis **_Gamma_**',
  '###### **Alpha** et _Beta_ puis __Gamma__',
  '###### Alpha et *Beta* puis __Gamma__',
]) {
  for (const reversed of [false, true]) {
    test('double clic puis glisser : instantané commun au titre et aux emphases, inversé=' + reversed + ', ' + body, async ({ page }) => {
      const text = 'before\n' + body + '\nafter'
      const { editor, writes } = await openEditor(page, text)
      const line = editor.locator('.cm-line').nth(1)
      const alpha = await wordPoint(line, 'Alpha')
      const gamma = await wordPoint(line, 'Gamma')
      const first = reversed ? gamma : alpha
      const last = reversed ? alpha : gamma
      await page.mouse.click(first.x, first.y)
      await page.waitForTimeout(120)
      await page.mouse.move(first.x, first.y)
      await page.mouse.down({ clickCount: 2 })
      await page.mouse.move(last.x, last.y, { steps: 10 })
      await expect(line).toHaveText('Alpha et Beta puis Gamma')
      await expect(page.getByRole('toolbar', { name: 'Mise en forme Markdown' })).toHaveCount(0)
      await page.mouse.up()
      const from = text.indexOf('Alpha')
      const to = text.indexOf('Gamma') + 5
      expect(await copy(editor)).toBe(text.slice(from, to))
      expect(await selection(editor)).toMatchObject({
        anchor: reversed ? to : from, head: reversed ? from : to,
      })
      await expect(line).toHaveText(body)
      expect(writes).toEqual([])
    })
  }
}

test('sens conservé par le menu, variantes produites et formulaire de lien', async ({ page }) => {
  const text = 'before\n**Alpha** et _Beta_\nafter'
  const { editor, writes } = await openEditor(page, text)
  const from = text.indexOf('Alpha')
  await editor.focus()
  await page.evaluate(pos => window.editorProbe.select(pos), from + 5)
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Italique', exact: true }).click()
  const changed = text.replace('**Alpha**', '**_Alpha_**')
  expect((await selection(editor)).doc).toBe(changed)
  expect((await selection(editor)).anchor).toBeGreaterThan((await selection(editor)).head)
  expect((await selection(editor)).text).toBe('Alpha')
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  // Une sélection neutre donne accès au formulaire sans modifier les protections de cible.
  await page.evaluate(pos => window.editorProbe.select(pos), text.indexOf('Beta') + 4)
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  const address = page.getByRole('textbox', { name: 'Adresse du lien' })
  await expect(address).toBeFocused()
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('Alpha et _Beta_')
  await address.fill('/videos/42')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('button', { name: 'Insérer le lien', exact: true })).toBeEnabled()
  expect(writes).toEqual([])
  await page.getByRole('button', { name: 'Insérer le lien', exact: true }).click()
  expect((await selection(editor)).doc).toBe(text.replace('Beta', '[Beta](</videos/42>)'))
})

test('multiligne affiché mais commande monoligne inchangée', async ({ page }) => {
  const text = 'before\n**Alpha\nBeta** puis _Gamma_\nafter'
  const { editor, writes } = await openEditor(page, text)
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('Alpha')
  await expect(editor.locator('.cm-line').nth(2)).toHaveText('Beta puis Gamma')
  await editor.focus()
  await page.evaluate(pos => window.editorProbe.select(pos), text.indexOf('Alpha'))
  for (let i = 0; i < 'Alpha\nBeta'.length; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('**Alpha')
  await expect(editor.locator('.cm-line').nth(2)).toHaveText('Beta** puis Gamma')
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Gras', exact: true })).toHaveAttribute('aria-disabled', 'true')
  expect(await copy(editor)).toBe('Alpha\nBeta')
  expect((await selection(editor)).doc).toBe(text)
  expect(writes).toEqual([])
})

test('liens, images, code, en-têtes littéraux et enveloppe autour d’un widget temporel', async ({ page }) => {
  const link = '[temps](sillage://videos/42/sources/17?start_ms=1234)'
  const text = 'before\n**' + link + '** et [__libellé__](/a) et ![*alt*](/a)\n' +
    '> [!quote] **Auteur**\n> *corps*\n\n\x60**code**\x60\nafter'
  const { editor, writes } = await openEditor(page, text)
  const compact = editor.locator('.cm-temporal-reference')
  await expect(compact).toHaveCount(1)
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('◷temps et [__libellé__](/a) et ![*alt*](/a)')
  await expect(editor.locator('.cm-line').nth(2)).toHaveText('> [!quote] **Auteur**')
  await expect(editor.locator('.cm-line').nth(3)).toHaveText('> corps')
  await compact.click()
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('**' + link + '** et [__libellé__](/a) et ![*alt*](/a)')
  await page.keyboard.press('Control+Enter')
  expect((await selection(editor)).doc).toBe(text)
  await page.evaluate(pos => window.editorProbe.select(pos), text.indexOf(link))
  await page.keyboard.press('Delete')
  expect((await selection(editor)).doc).toBe(text)
  await expect(compact).toHaveCount(0)
  await page.keyboard.press('Delete')
  expect((await selection(editor)).doc).toBe(text.replace(link, link.slice(1)))
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  expect(writes).toEqual([])
})

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark'] as const) {
    test('retours visuels, longue note, typographie et session ' + width + ' ' + theme, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 800 })
      const title = '###### **Alpha** et _Beta_ puis **_Gamma_**'
      const long = '**Une expression longue avec un retour visuel prévisible ' + 'et plusieurs mots. '.repeat(8).trimEnd() + '**'
      const text = 'before\n' + title + '\n' + long + '\n' + 'Prose\n'.repeat(800) + '**Dernier** puis *fin* \nafter'
      const { editor, writes } = await openEditor(page, text)
      await selectTheme(page, theme)
      const original = await editor.elementHandle()
      await expect(editor.locator('.cm-line').nth(2)).toHaveText(long.slice(2, -2))
      await expect(editor.locator('.cm-note-h6')).toHaveText('Alpha et Beta puis Gamma')
      expect(await editor.locator('.cm-note-h6').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      await editor.focus()
      await page.evaluate(pos => window.editorProbe.select(pos), text.indexOf('Gamma') + 2)
      const styles = await editor.locator('.cm-note-h6').evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes('Gamma')) {
            const css = getComputedStyle(node.parentElement!)
            return { weight: css.fontWeight, style: css.fontStyle, size: css.fontSize }
          }
        }
      })
      expect(styles).toEqual({ weight: '700', style: 'italic', size: '16px' })
      await page.keyboard.press('Escape')
      await page.screenshot({ path: info.outputPath('emphasis-editing.png'), fullPage: false })
      await page.keyboard.press('Control+Home')
      const first = text.indexOf('Une expression')
      await page.evaluate(pos => window.editorProbe.select(pos), first + 12)
      await expect(editor.locator('.cm-line').nth(2)).toContainText('**Une expression')
      await page.keyboard.press('Shift+End')
      expect((await selection(editor)).text.length).toBeGreaterThan(0)
      await page.keyboard.press('Control+End')
      const last = editor.locator('.cm-line').filter({ hasText: 'Dernier' })
      await expect(last).toHaveText('Dernier puis fin ')
      await last.dblclick({ position: { x: 20, y: 12 }, delay: 120 })
      expect((await selection(editor)).text).toBe('Dernier')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Lecture', exact: true }).click()
      const reading = page.getByLabel('Lecture de la note')
      await expect(reading).toBeVisible()
      await expect(reading.locator('h6 strong').first()).toHaveText('Alpha')
      await expect(reading.locator('h6 em').last()).toHaveText('Gamma')
      await reading.locator('h6').scrollIntoViewIfNeeded()
      await page.screenshot({ path: info.outputPath('emphasis-reading.png'), fullPage: false })
      await page.getByRole('button', { name: 'Édition', exact: true }).click()
      await page.getByRole('tab', { name: 'Informations', exact: true }).click()
      await page.getByRole('tab', { name: 'Note', exact: true }).click()
      expect(await original!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
      expect((await selection(editor)).doc).toBe(text)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.waitForTimeout(2100)
      expect(writes).toEqual([])
    })
  }
}

test('composition DOM synthétique : gel et reprise inline sans autre geste', async ({ page }) => {
  const text = 'before\nplain\nafter'
  const updated = text.replace('plain', '**見出し** fin')
  const { editor, writes } = await openEditor(page, text)
  await editor.focus()
  await page.evaluate(() => window.editorProbe.select(7, 12))
  await editor.dispatchEvent('compositionstart')
  await page.keyboard.insertText('**見出し** fin')
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('**見出し** fin')
  await editor.dispatchEvent('compositionend')
  const committed = await selection(editor)
  await page.waitForTimeout(300)
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('見出し fin')
  expect(await selection(editor)).toEqual(committed)
  expect(committed.doc).toBe(updated)
  expect(writes).toEqual([])
  await expect(page.getByRole('toolbar', { name: 'Mise en forme Markdown' })).toHaveCount(0)
})

test.describe('EditContext Chromium Android : reprise commune aux titres et emphases', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' })

  for (const sample of [
    { initial: 'plain', replacement: '**見出し** fin', compact: '見出し fin' },
    { initial: '###### plain', replacement: '###### **_見出し_** fin', compact: '###### 見出し fin' },
  ]) {
    test('composition validée sans interaction : ' + sample.initial, async ({ page, context }) => {
      const text = 'before\n' + sample.initial + '\nafter'
      const updated = 'before\n' + sample.replacement + '\nafter'
      const { editor, writes } = await openEditor(page, text)
      await editor.focus()
      await page.evaluate(to => window.editorProbe.select(7, to), text.indexOf('\nafter'))
      expect((await selection(editor)).editContext).toBe(true)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.imeSetComposition', {
        text: sample.replacement, selectionStart: sample.replacement.length, selectionEnd: sample.replacement.length,
      })
      await expect(editor.locator('.cm-line').nth(1)).toHaveText(sample.replacement)
      expect((await selection(editor)).compositionStarted).toBe(true)
      await cdp.send('Input.insertText', { text: sample.replacement })
      const committed = await selection(editor)
      expect(committed).toMatchObject({ doc: updated, compositionStarted: false, editContext: true })
      await page.waitForTimeout(300)
      await expect(editor.locator('.cm-line').nth(1)).toHaveText(sample.compact)
      expect(await selection(editor)).toEqual(committed)
      await expect(page.getByRole('toolbar', { name: 'Mise en forme Markdown' })).toHaveCount(0)
      expect(writes).toEqual([])
      await expect.poll(() => writes).toEqual([updated])
      await page.keyboard.press('Control+z')
      expect((await selection(editor)).doc).toBe(text)
      await page.keyboard.press('Control+Shift+z')
      expect((await selection(editor)).doc).toBe(updated)
      await cdp.detach()
    })
  }
})

test('composition DOM : les paires voisines suivent les modifications pendant le gel', async ({ page }) => {
  const text = 'before\n**Alpha** puis _Beta_ fin\nafter'
  const { editor, writes } = await openEditor(page, text)
  await editor.focus()
  await page.evaluate(() => window.editorProbe.select(9, 14))
  await editor.dispatchEvent('compositionstart')
  await page.keyboard.insertText('見出し')
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('**見出し** puis Beta fin')
  const composing = await selection(editor)
  expect(composing.doc).toBe(text.replace('Alpha', '見出し'))
  await editor.dispatchEvent('compositionend')
  await page.waitForTimeout(300)
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('**見出し** puis Beta fin')
  expect((await selection(editor)).head).toBe(composing.head)
  expect(writes).toEqual([])
})

for (const sample of [
  { body: '***!?!*** et _autre_', word: '!?!', selected: '!?!' },
  { body: '__snake_case__ et **autre**', word: 'snake_case', selected: 'snake_case' },
  { body: '**_snake_case_** et *autre*', word: 'snake_case', selected: 'snake_case' },
  { body: '__cafe\u0301_中文__ et _autre_', word: 'cafe\u0301_中文', selected: 'cafe\u0301_中文' },
  { body: 'snake_case et __autre__', word: 'snake_case', selected: 'snake_case' },
  { body: '_literal_value et __autre__', word: 'literal_value', selected: '_literal_value' },
  { body: '\x60_code_value_\x60 et __autre__', word: 'code_value', selected: '_code_value_' },
  { body: '**\x60_code_value_\x60** et __autre__', word: 'code_value', selected: '_code_value_' },
  { body: '[__label_value__](/a) et __autre__', word: 'label_value', selected: '__label_value__' },
]) {
  test('bornes syntaxiques seules et underscores ordinaires : ' + sample.body, async ({ page }) => {
    const text = 'before\n' + sample.body + '\nafter'
    const { editor, writes } = await openEditor(page, text)
    const point = await wordPoint(editor.locator('.cm-line').nth(1), sample.word)
    await page.mouse.dblclick(point.x, point.y, { delay: 120 })
    expect(await copy(editor)).toBe(sample.selected)
    expect((await selection(editor)).doc).toBe(text)
    const from = text.indexOf(sample.selected)
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + sample.selected.length })
    expect(writes).toEqual([])
  })
}

test('marqueurs déjà révélés : le double clic conserve le groupe source natif', async ({ page }) => {
  const text = 'before\n__Alpha__ et **Beta**\nafter'
  const { editor, writes } = await openEditor(page, text)
  await editor.focus()
  await page.evaluate(pos => window.editorProbe.select(pos), text.indexOf('Alpha') + 2)
  const line = editor.locator('.cm-line').nth(1)
  await expect(line).toHaveText('__Alpha__ et Beta')
  const point = await wordPoint(line, 'Alpha')
  await page.mouse.dblclick(point.x, point.y, { delay: 120 })
  expect(await copy(editor)).toBe('__Alpha__')
  expect((await selection(editor)).doc).toBe(text)
  expect(writes).toEqual([])
})

test('double clic sur underscore compact près d’un retour visuel mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 })
  const body = '## Un titre qui approche le bord puis __Alpha__ avec **_Gamma_**'
  const text = 'before\n' + body + '\nafter'
  const { editor, writes } = await openEditor(page, text)
  const line = editor.locator('.cm-note-h2')
  await line.scrollIntoViewIfNeeded()
  const point = await wordPoint(line, 'Alpha')
  await page.mouse.dblclick(point.x, point.y, { delay: 200 })
  expect(await copy(editor)).toBe('Alpha')
  const from = text.indexOf('Alpha')
  expect(await selection(editor)).toMatchObject({ anchor: from, head: from + 5 })
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Gras', exact: true }).click()
  expect((await selection(editor)).doc).toBe(text.replace('__Alpha__', 'Alpha'))
  expect(writes).toEqual([])
})

for (const fraction of [.05, .95]) {
  test('double clic près du bord visible du mot compact, fraction=' + fraction, async ({ page }) => {
    const text = 'before\n__Alpha__ et _Beta_\nafter'
    const { editor, writes } = await openEditor(page, text)
    const point = await wordPoint(editor.locator('.cm-line').nth(1), 'Alpha', fraction)
    await page.mouse.dblclick(point.x, point.y, { delay: 120 })
    expect(await copy(editor)).toBe('Alpha')
    const from = text.indexOf('Alpha')
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + 5 })
    expect(writes).toEqual([])
  })
}

test('glisser par mots depuis une emphase vers de la ponctuation ordinaire', async ({ page }) => {
  const text = 'before\n__Alpha__,;  suite\nafter'
  const { editor, writes } = await openEditor(page, text)
  const line = editor.locator('.cm-line').nth(1)
  const alpha = await wordPoint(line, 'Alpha')
  const punctuation = await wordPoint(line, ',;')
  await page.mouse.click(alpha.x, alpha.y)
  await page.waitForTimeout(120)
  await page.mouse.move(alpha.x, alpha.y)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.move(punctuation.x, punctuation.y, { steps: 8 })
  await page.mouse.up()
  expect(await copy(editor)).toBe('Alpha__,;')
  expect((await selection(editor)).doc).toBe(text)
  expect(writes).toEqual([])
})
