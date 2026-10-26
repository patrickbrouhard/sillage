import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Monte la vraie session de note et observe toutes les écritures. */
async function openEditor(page: Page, initial: string) {
  const writes: string[] = []
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-15', tags: [], person_ids: [], sources: [],
  } }))
  await page.route('**/note', route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON().content_md)
    return route.fulfill({ json: {
      video_id: 42, content_md: writes.at(-1) ?? initial, revision: 1 + writes.length, updated_at: '2026-10-15',
    } })
  })
  await page.goto('/videos/42')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  return { editor, writes }
}

/** Lit les positions DOM après révélation ; les lignes testées tiennent dans le viewport. */
async function selection(editor: Locator) {
  return editor.evaluate(element => {
    const selected = getSelection()!
    const position = (node: Node | null, offset: number) => {
      const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line')
      if (!line || !node) throw new Error('Sélection hors de la note')
      const range = document.createRange()
      range.setStart(line, 0)
      range.setEnd(node, offset)
      const lines = [...element.querySelectorAll('.cm-line')]
      const before = lines.slice(0, lines.indexOf(line)).reduce((size, current) => size + current.textContent!.length + 1, 0)
      return before + range.toString().length
    }
    return {
      anchor: position(selected.anchorNode, selected.anchorOffset),
      head: position(selected.focusNode, selected.focusOffset),
      text: selected.toString(),
    }
  })
}

/** Copie par le gestionnaire natif CodeMirror pour vérifier le Markdown documentaire. */
async function copy(editor: Locator) {
  return editor.evaluate(element => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }))
    return clipboardData.getData('text/plain')
  })
}

test('clic natif, édition des marqueurs, niveau, suppression et Undo/Redo', async ({ page }) => {
  const text = 'avant\n## Titre utile ###\naprès'
  const { editor, writes } = await openEditor(page, text)
  const heading = editor.locator('.cm-note-heading')
  await expect(heading).toHaveText('Titre utile')
  await heading.click({ position: { x: 30, y: 12 } })
  await expect(heading).toHaveText('## Titre utile ###')
  const clicked = await selection(editor)
  expect(clicked.anchor).toBe(clicked.head)
  // Un caractère réellement inséré reste au point choisi, sans second calcul de clic.
  await page.keyboard.insertText('X')
  await page.keyboard.press('Control+a')
  expect(await copy(editor)).toBe(text.slice(0, clicked.head) + 'X' + text.slice(clicked.head))
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Delete')
  await expect(heading).toHaveClass(/cm-note-h1/)
  await page.keyboard.press('Control+z')
  await expect(heading).toHaveClass(/cm-note-h2/)
  await page.keyboard.press('Control+Shift+z')
  await expect(heading).toHaveClass(/cm-note-h1/)
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.at(-1)).toBe('avant\n# Titre utile ###\naprès')
})

for (const reversed of [false, true]) {
  test('glisser traversant gelé et sélection documentaire conservée, inversé=' + reversed, async ({ page }) => {
    const text = 'Début\n# Premier ###\n## Deuxième\nFin'
    const { editor, writes } = await openEditor(page, text)
    const lines = editor.locator('.cm-line')
    const first = (await lines.first().boundingBox())!
    const last = (await lines.last().boundingBox())!
    const start = { x: first.x + 1, y: first.y + first.height / 2 }
    const end = { x: last.x + 100, y: last.y + last.height / 2 }
    await page.mouse.move(reversed ? end.x : start.x, reversed ? end.y : start.y)
    await page.mouse.down()
    await page.mouse.move(reversed ? start.x : end.x, reversed ? start.y : end.y, { steps: 12 })
    await expect(editor.locator('.cm-note-h1')).toHaveText('Premier')
    await expect(editor.locator('.cm-note-h2')).toHaveText('Deuxième')
    await expect(page.getByRole('toolbar', { name: 'Mise en forme Markdown' })).toHaveCount(0)
    await page.mouse.up()
    await expect(editor.locator('.cm-note-h1')).toHaveText('# Premier ###')
    expect(await copy(editor)).toBe(text)
    const current = await selection(editor)
    expect(current.anchor).toBe(reversed ? text.length : 0)
    expect(current.head).toBe(reversed ? 0 : text.length)
    expect(writes).toEqual([])
  })
}

test('sélection partielle, menu et lien gardent la source sans transaction parasite', async ({ page }) => {
  const { editor, writes } = await openEditor(page, 'avant\n## Titre utile ###\naprès')
  const node = await editor.elementHandle()
  const heading = editor.locator('.cm-note-h2')
  await heading.dblclick({ position: { x: 20, y: 12 } })
  const selected = await selection(editor)
  expect(selected.text).toBe('Titre')
  await expect(heading).toHaveText('## Titre utile ###')
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(heading).toHaveText('## Titre utile ###')
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  await page.getByRole('textbox', { name: 'Adresse du lien' }).fill('/videos/42')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(heading).toHaveText('## Titre utile ###')
  await expect(page.getByRole('button', { name: 'Insérer le lien', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Insérer le lien', exact: true }).click()
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.at(-1)).toBe('avant\n## [Titre](</videos/42>) utile ###\naprès')
  await page.keyboard.press('Control+z')
  await expect(heading).toHaveText('## Titre utile ###')
  await page.keyboard.press('Control+Home')
  await expect(heading).toHaveText('Titre utile')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await node!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
})

test('composition synthétique : plages gelées et mappées pendant une modification réelle', async ({ page }) => {
  const { editor } = await openEditor(page, '# Actif\n## Inactif ###\nfin')
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('End')
  const inactive = editor.locator('.cm-note-h2')
  const original = await inactive.elementHandle()
  await editor.dispatchEvent('compositionstart')
  await page.keyboard.insertText(' composé')
  await expect(editor.locator('.cm-note-h1')).toHaveText('# Actif composé')
  await expect(inactive).toHaveText('Inactif')
  expect(await original!.evaluate(el => el === document.querySelector('.cm-note-h2'))).toBe(true)
  await editor.dispatchEvent('compositionend')
  await page.keyboard.press('Control+End')
  await expect(editor.locator('.cm-note-h1')).toHaveText('Actif composé')
  await inactive.click()
  await expect(inactive).toHaveText('## Inactif ###')
})

for (const width of [1440, 375]) {
  test('titre replié, navigation répétée et conteneur de scroll ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const title = 'Un titre long près du seuil de retour à la ligne avec plusieurs mots '.repeat(3)
    const text = 'avant\n# ' + title + '\naprès\n' + 'Paragraphe ordinaire\n'.repeat(100)
    const { editor, writes } = await openEditor(page, text)
    const heading = editor.locator('.cm-note-h1')
    await expect(heading).toHaveText(title.trimEnd())
    await editor.focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await expect(heading).toContainText('# ')
    const scroll = await page.evaluate(() => ({ page: scrollY, note: document.querySelector('.note-content')!.scrollTop }))
    const positions: number[] = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowDown')
      positions.push((await selection(editor)).head)
    }
    // Le premier retour peut changer de colonne avec le préfixe révélé ; aucun cumul ensuite.
    expect(new Set(positions).size).toBe(1)
    const after = await page.evaluate(() => ({ page: scrollY, note: document.querySelector('.note-content')!.scrollTop }))
    expect(Math.abs(after.page - scroll.page)).toBeLessThan(80)
    expect(Math.abs(after.note - scroll.note)).toBeLessThan(80)
    await page.keyboard.press('Shift+End')
    expect((await selection(editor)).text.length).toBeGreaterThan(0)
    await expect(heading).toContainText('# ')
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Control+Home')
    await expect(heading).not.toContainText('#')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.waitForTimeout(2100)
    expect(writes).toEqual([])
  })
}

test('analyse incrémentale au bout d’une longue note et référence temporelle dans un titre', async ({ page }) => {
  const link = '[Passage](sillage://videos/42/sources/17?start_ms=1234)'
  const { editor, writes } = await openEditor(page, 'Prose\n'.repeat(800) + '## ' + link + ' ###\nfin')
  await editor.focus()
  await page.keyboard.press('Control+End')
  const heading = editor.locator('.cm-note-h2')
  await expect(heading).toHaveText('◷Passage')
  await heading.locator('.cm-temporal-reference').click()
  await expect(heading).toHaveText('## ' + link + ' ###')
  await page.keyboard.press('Control+End')
  await expect(heading.locator('.cm-temporal-reference')).toBeVisible()
  expect(writes).toEqual([])
})

for (const width of [1440, 320]) {
  test('titre près du bord du viewport : sélection native et défilement existant ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 600 })
    const prefix = 'Prose ordinaire.\n'.repeat(100)
    const title = 'Titre à la limite du viewport avec retour à la ligne '.repeat(3)
    const text = prefix + '## ' + title + '###\nfin'
    const { editor, writes } = await openEditor(page, text)
    await editor.focus()
    await page.keyboard.press('Control+End')
    const heading = editor.locator('.cm-note-h2')
    await expect(heading).toHaveText(title.trimEnd())
    const box = (await heading.boundingBox())!
    // Le clic vise la dernière ligne visuelle encore visible, avant toute révélation.
    await heading.click({ position: { x: 30, y: box.height - 8 } })
    await expect(heading).toHaveText('## ' + title + '###')
    await page.keyboard.press('Shift+ArrowLeft')
    const selected = await copy(editor)
    expect(selected).toHaveLength(1)
    await page.keyboard.insertText('X')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+a')
    expect(await copy(editor)).toBe(text)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath('heading-viewport-source.png'), fullPage: true })
    const scroll = await page.evaluate(() => ({
      page: scrollY, note: document.querySelector('.note-content')!.scrollTop,
      editor: document.querySelector('.cm-scroller')!.scrollTop,
    }))
    expect(scroll.editor).toBe(0)
    if (width === 1440) {
      expect(scroll.note).toBeGreaterThan(0)
      // Une fenêtre basse peut aussi faire défiler la page pour les minima existants.
    } else {
      expect(scroll.page).toBeGreaterThan(0)
      expect(scroll.note).toBe(0)
    }
    // Seule la saisie temporaire est autorisée à déclencher une écriture.
    expect(writes.every(value => value.includes('X') || value === text)).toBe(true)
  })
}
