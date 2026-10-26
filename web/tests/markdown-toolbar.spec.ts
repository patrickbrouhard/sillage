import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Monte une vraie session avec des réponses contrôlées et observe chaque sauvegarde. */
async function openEditor(page: Page, initial = 'Un passage utile') {
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
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  return { editor, toolbar, writes }
}

/** Effectue un vrai geste clavier, y compris la resélection du même passage. */
async function selectAll(page: Page) {
  await page.getByRole('textbox', { name: 'Note Markdown' }).focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('toolbar', { name: 'Mise en forme Markdown' })).toBeInViewport()
}

test('sélection, fermeture, resélection, sauvegarde et Undo/Redo atomiques', async ({ page }) => {
  const { editor, toolbar, writes } = await openEditor(page)
  const original = await editor.elementHandle()
  await expect(toolbar).toHaveCount(0)
  await selectAll(page)
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toolbar).toHaveCount(0)
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Gras', exact: true }).click()
  await expect(editor).toHaveText('**Un passage utile**')
  await expect(toolbar).toHaveCount(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Un passage utile')
  await page.waitForTimeout(300)
  await expect(toolbar).toHaveCount(0)
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.at(-1)).toBe('**Un passage utile**')
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('Un passage utile')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toHaveText('**Un passage utile**')
  expect(await original!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
})

test('menu, annulation, clic extérieur et modes sans sauvegarde ni focus repris', async ({ page }) => {
  const { editor, toolbar, writes } = await openEditor(page)
  await selectAll(page)
  await page.keyboard.press('Tab')
  await expect(toolbar.getByRole('button', { name: 'Style du texte' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(toolbar.getByRole('button', { name: 'Gras', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Paragraphe', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Adresse du lien' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toolbar).toBeVisible()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await expect(editor).toHaveText('Un passage utile')
  await expect(toolbar).toHaveCount(0)
  await page.waitForTimeout(2200)
  expect(writes).toEqual([])
})

test('lien confirmé explicitement, validation, sérialisation et lecture', async ({ page }) => {
  const { editor, toolbar, writes } = await openEditor(page, '[libellé] & *texte*')
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  const address = page.getByRole('textbox', { name: 'Adresse du lien' })
  await address.fill('javascript:alert(1)')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Adresse non admissible' })).toBeVisible()
  expect(writes).toEqual([])
  await address.fill('https://example.org/a(b) c')
  await page.getByRole('button', { name: 'Insérer le lien', exact: true }).click()
  await expect(editor).toHaveText('[\\[libellé\\] \\& \\*texte\\*](<https://example.org/a(b)%20c>)')
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.length).toBe(1)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const link = page.getByRole('link', { name: '[libellé] & *texte*', exact: true })
  await expect(link).toHaveAttribute('href', 'https://example.org/a(b)%20c')
})

test('titres multilignes, état mixte et retrait des clôtures ATX', async ({ page }) => {
  const { editor, toolbar } = await openEditor(page, '# Premier ###\n\n### Deuxième\nDernier')
  await selectAll(page)
  await expect(toolbar.getByRole('button', { name: 'Style du texte' })).toContainText('Mixte')
  await toolbar.getByRole('button', { name: 'Gras', exact: true }).press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'une seule ligne' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Style du texte' }).click()
  await page.getByRole('button', { name: 'H2', exact: true }).click()
  await expect(editor.locator('.cm-line')).toHaveText(['## Premier', '', '## Deuxième', '## Dernier'])
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Style du texte' }).click()
  await page.getByRole('button', { name: 'Paragraphe', exact: true }).click()
  await expect(editor.locator('.cm-line')).toHaveText(['Premier', '', 'Deuxième', 'Dernier'])
})

test('références temporelles protégées en inline et conservées par un titre', async ({ page }) => {
  const link = '[temps](sillage://videos/42/sources/17?start_ms=40360)'
  const { editor, toolbar, writes } = await openEditor(page, link)
  await expect(editor.locator('.cm-temporal-reference')).toBeVisible()
  await selectAll(page)
  await expect(toolbar.getByRole('button', { name: 'Gras', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await toolbar.getByRole('button', { name: 'Gras', exact: true }).press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'références temporelles' })).toBeVisible()
  expect(writes).toEqual([])
  await toolbar.getByRole('button', { name: 'Style du texte' }).click()
  await page.getByRole('button', { name: 'H3', exact: true }).click()
  await expect(editor).toHaveText('### ' + link)
})

test('composition IME, saisie et masquage de la note ferment la barre', async ({ page }) => {
  const { editor, toolbar } = await openEditor(page)
  await selectAll(page)
  await editor.dispatchEvent('compositionstart')
  await expect(toolbar).toHaveCount(0)
  await editor.dispatchEvent('compositionend')
  await expect(toolbar).toHaveCount(0)
  await selectAll(page)
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await selectAll(page)
  await page.keyboard.insertText('remplacé')
  await expect(toolbar).toHaveCount(0)
})

for (const width of [320, 375, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test('géométrie et thème ' + width + ' ' + theme, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 700 })
      await page.emulateMedia({ colorScheme: theme })
      const { editor, toolbar, writes } = await openEditor(page, 'Long passage sans saut de ligne. '.repeat(12))
      await selectAll(page)
      const box = await toolbar.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await toolbar.getByRole('button', { name: 'Style du texte' }).click()
      await expect(page.getByRole('button', { name: 'H6', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Insérer le lien', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' })
      await expect(page.getByRole('textbox', { name: 'Adresse du lien' })).toBeFocused()
      await page.screenshot({ path: info.outputPath('markdown-toolbar.png') })
      await page.keyboard.press('Escape')
      await toolbar.getByRole('button', { name: 'Italique', exact: true }).click()
      await expect(editor).toContainText('*Long passage')
      expect(writes).toEqual([])
    })
  }
}


test('confirmation d’autosauvegarde pendant le formulaire conserve une cible valide', async ({ page }) => {
  const { editor, toolbar, writes } = await openEditor(page, 'texte')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' ajouté')
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Adresse du lien' })
  await input.fill('/videos/42')
  await expect.poll(() => writes.at(-1)).toBe('texte ajouté')
  await expect(input).toBeFocused()
  await expect(page.getByRole('button', { name: 'Insérer le lien', exact: true })).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(editor).toHaveText('[texte ajouté](</videos/42>)')
})

test('sélection souris inversée, glisser stable et resélection du même passage', async ({ page }) => {
  const { editor, toolbar, writes } = await openEditor(page, 'alpha omega')
  const line = editor.locator('.cm-line')
  const box = (await line.boundingBox())!
  await page.mouse.move(box.x + 92, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + 2, box.y + 12, { steps: 8 })
  await page.waitForTimeout(250)
  await expect(toolbar).toHaveCount(0)
  await page.mouse.up()
  await expect(toolbar).toBeInViewport()
  expect(await page.evaluate(() => {
    const selection = window.getSelection()!
    return selection.anchorOffset > selection.focusOffset
  })).toBe(true)
  await page.keyboard.press('Escape')
  await page.mouse.move(box.x + 92, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + 2, box.y + 12, { steps: 8 })
  await page.mouse.up()
  await expect(toolbar).toBeInViewport()
  await toolbar.getByRole('button', { name: 'Gras', exact: true }).click()
  expect(await page.evaluate(() => {
    const selection = window.getSelection()!
    return selection.anchorOffset > selection.focusOffset
  })).toBe(true)
  expect(writes).toEqual([])
})

test('note longue : ancrage visible, défilement extérieur et fenêtre basse', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  const { editor, toolbar } = await openEditor(page, Array.from({ length: 200 }, (_, i) => 'Paragraphe ' + i).join('\n\n'))
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await expect(toolbar).toBeInViewport()
  await page.locator('.note-content').evaluate(element => { element.scrollTop = 1500 })
  await expect(toolbar).not.toBeInViewport()
  await page.locator('.note-content').evaluate(element => { element.scrollTop = 0 })
  await expect(toolbar).toBeInViewport()
  await page.setViewportSize({ width: 375, height: 400 })
  await editor.scrollIntoViewIfNeeded()
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Style du texte' }).click()
  await expect(page.getByRole('button', { name: 'H6', exact: true })).toBeInViewport()
})

test('Tab quitte la barre et le formulaire sans piéger le focus', async ({ page }) => {
  const { editor, toolbar } = await openEditor(page)
  await selectAll(page)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toBeFocused()
  await expect(toolbar).toHaveCount(0)
  await selectAll(page)
  await toolbar.getByRole('button', { name: 'Lien', exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Insérer le lien', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Annuler le lien', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Adresse du lien' })).toHaveCount(0)
})
