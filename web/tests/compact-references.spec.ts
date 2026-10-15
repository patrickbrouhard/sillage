import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const uri = 'sillage://videos/42/sources/17?start_ms=40360'
const link = '[Passage intéressant](' + uri + ')'

/** Utilise la vraie session de note, avec un serveur contrôlé pour observer chaque écriture. */
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
  return { editor, writes, compact: editor.locator('.cm-temporal-reference') }
}

for (const sample of [
  { name: 'paragraphe', text: 'Avant ' + link + ' après', count: 1 },
  { name: 'liste', text: '- ' + link, count: 1 },
  { name: 'citation', text: '> texte ' + link, count: 1 },
  { name: 'corps de callout', text: '> [!quote] Auteur\n> ' + link, count: 1 },
  { name: 'adjacentes', text: link + link, count: 2 },
  { name: 'code inline', text: '\x60' + link + '\x60', count: 0 },
  { name: 'code clôturé', text: '\x60\x60\x60\n' + link + '\n\x60\x60\x60', count: 0 },
  { name: 'image', text: '!' + link, count: 0 },
  { name: 'libellé enrichi', text: '[**gras**](' + uri + ')', count: 0 },
  { name: 'libellé échappé', text: '[un \\*](' + uri + ')', count: 0 },
  { name: 'entité', text: '[un &amp; autre](' + uri + ')', count: 0 },
  { name: 'URI isolée', text: uri, count: 0 },
  { name: 'URI invalide', text: '[temps](' + uri + '&end_ms=50)', count: 0 },
  { name: 'multiligne', text: '[temps\nsuite](' + uri + ')', count: 0 },
  { name: 'définition', text: '[temps][ref]\n\n[ref]: ' + uri, count: 0 },
  { name: 'titre de lien', text: '[temps](' + uri + ' "titre")', count: 0 },
  { name: 'en-tête transcription', text: '> [!quote:tr](' + uri + ') Titre', count: 0 },
  { name: 'attribution littérale', text: '> [!quote] ' + link, count: 0 },
  { name: 'titre littéral', text: '> [!quote:tr](' + uri + ') ' + link, count: 0 },
  { name: 'en-tête invalide', text: '> [!quote:tr](' + uri + ')sans espace ' + link, count: 0 },
  { name: 'en-tête imbriqué', text: '> > [!quote:tr](' + uri + ') ' + link, count: 0 },
  { name: 'construction traversante', text: '> [!quote] [titre\n> suite](' + uri + ')', count: 0 },
  { name: 'source étrangère valide', text: '[ailleurs](sillage://videos/8/sources/9?start_ms=0)', count: 1 },
]) {
  test('reconnaissance : ' + sample.name, async ({ page }) => {
    const { compact, writes } = await openEditor(page, sample.text)
    await expect(compact).toHaveCount(sample.count)
    expect(writes).toEqual([])
  })
}

test('clic, retour compact, copie Markdown et absence de sauvegarde', async ({ page }) => {
  const text = 'Avant ' + link + ' après'
  const { editor, compact, writes } = await openEditor(page, text)
  const node = await editor.elementHandle()
  await expect(compact).toContainText('Passage intéressant')
  await expect(compact).not.toHaveAttribute('tabindex', '0')
  await compact.click()
  await expect(compact).toHaveCount(0)
  await expect(editor).toHaveText(text)
  await expect(editor).toBeFocused()
  await page.keyboard.press('Control+End')
  await expect(compact).toHaveCount(1)
  await page.keyboard.press('Control+a')
  await expect(compact).toHaveCount(0)
  const copied = await editor.evaluate(element => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }))
    return clipboardData.getData('text/plain')
  })
  expect(copied).toBe(text)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await expect(editor).toHaveText(text)
  expect(writes).toEqual([])
})

for (const key of ['ArrowRight', 'Delete', 'ArrowLeft', 'Backspace']) {
  test('entrée sans suppression : ' + key, async ({ page }) => {
    const { editor, compact, writes } = await openEditor(page, link)
    await editor.focus()
    await page.keyboard.press(key === 'ArrowLeft' || key === 'Backspace' ? 'Control+End' : 'Control+Home')
    await expect(compact).toHaveCount(1)
    await page.keyboard.press(key)
    await expect(compact).toHaveCount(0)
    await expect(editor).toHaveText(link)
    expect(writes).toEqual([])
    await page.keyboard.insertText('X')
    await expect.poll(() => writes.at(-1)).toContain('X')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+a')
    await expect(editor).toHaveText(link)
    await page.keyboard.press('Control+End')
    await expect(compact).toHaveCount(1)
  })
}

test('frontières adjacentes, sélection traversante, suppression et Undo', async ({ page }) => {
  const { editor, compact, writes } = await openEditor(page, link + link)
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  await expect(compact).toHaveCount(1)
  for (let i = 1; i < link.length; i++) await page.keyboard.press('ArrowRight')
  await expect(compact).toHaveCount(2)
  await page.keyboard.insertText(' entre ')
  await expect.poll(() => writes.at(-1)).toBe(link + ' entre ' + link)
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await expect(compact).toHaveCount(0)
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveText('')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+End')
  await expect(compact).toHaveCount(2)
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.at(-1)).toBe(link + ' entre ' + link)
})

test('composition : source visible et rétablie sans écriture synthétique', async ({ page }) => {
  const { editor, compact, writes } = await openEditor(page, 'Avant ' + link)
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await editor.dispatchEvent('compositionstart')
  await expect(compact).toHaveCount(0)
  await editor.dispatchEvent('compositionend')
  await expect(compact).toHaveCount(1)
  expect(writes).toEqual([])
})

for (const theme of ['light', 'dark'] as const) {
  test('titre long, écran étroit et thème ' + theme, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    const { compact, writes } = await openEditor(page, 'Avant [' + 'Passage intéressant '.repeat(15) + '](' + uri + ') suite')
    await expect(compact).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(writes).toEqual([])
  })
}

test('sélection partielle au clavier, puis sélection inversée traversante', async ({ page }) => {
  const { editor, compact, writes } = await openEditor(page, link + ' suite')
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(compact).toHaveCount(0)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('[')
  await page.keyboard.press('Control+End')
  await expect(compact).toHaveCount(1)
  await page.keyboard.press('Control+Shift+Home')
  await expect(compact).toHaveCount(0)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(link + ' suite')
  expect(writes).toEqual([])
})

test('DOM stable pendant saisie voisine et sauvegarde, puis rechargement fidèle', async ({ page }) => {
  const { editor, compact, writes } = await openEditor(page, link + ' suite')
  const widget = await compact.elementHandle()
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ajout')
  await expect.poll(() => writes.at(-1)).toBe(link + ' suite ajout')
  expect(await widget!.evaluate(element => element === document.querySelector('.cm-temporal-reference'))).toBe(true)
  await page.reload()
  await expect(page.locator('.cm-temporal-reference')).toHaveCount(1)
  await page.locator('.cm-temporal-reference').click()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toHaveText(link + ' suite ajout')
})

test('grand document : compaction après déplacement et analyse incrémentale', async ({ page }) => {
  const { editor, compact, writes } = await openEditor(page, 'Ligne ordinaire\n'.repeat(800) + link + ' fin')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await expect(compact).toHaveCount(1)
  await compact.click()
  await expect(compact).toHaveCount(0)
  await page.keyboard.press('Control+End')
  await expect(compact).toHaveCount(1)
  expect(writes).toEqual([])
})

for (const backwards of [true, false]) {
  test('deuxième suppression native, frontière ' + (backwards ? 'droite' : 'gauche'), async ({ page }) => {
    const { editor, compact, writes } = await openEditor(page, link)
    await editor.focus()
    await page.keyboard.press(backwards ? 'Control+End' : 'Control+Home')
    await page.keyboard.press(backwards ? 'Backspace' : 'Delete')
    await expect(compact).toHaveCount(0)
    expect(writes).toEqual([])
    await page.keyboard.press(backwards ? 'Backspace' : 'Delete')
    await expect(editor).toHaveText(backwards ? link.slice(0, -1) : link.slice(1))
    await page.keyboard.press('Control+z')
    await expect(compact).toHaveCount(1)
  })
}

test('sélection souris traversant une référence compacte', async ({ page }) => {
  const text = 'Début\n' + link + '\nFin'
  const { editor, compact, writes } = await openEditor(page, text)
  const first = await editor.locator('.cm-line').first().boundingBox()
  const bounds = await editor.boundingBox()
  await page.mouse.move(first!.x, first!.y + first!.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width - 2, bounds!.y + bounds!.height + 50, { steps: 12 })
  await page.mouse.up()
  await expect(compact).toHaveCount(0)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(text)
  expect(writes).toEqual([])
})
