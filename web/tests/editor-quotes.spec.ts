import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const uri = 'sillage://videos/42/sources/17?start_ms=40360'

/** Observe les écritures sans données personnelles et laisse la vraie session CodeMirror fonctionner. */
async function openEditor(page: Page, initial: string) {
  let content = initial
  let revision = 1
  const writes: string[] = []
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-15', tags: [], person_ids: [], sources: [],
  } }))
  await page.route('**/note', route => {
    if (route.request().method() === 'PUT') {
      content = route.request().postDataJSON().content_md
      writes.push(content)
      revision++
    }
    return route.fulfill({ json: { video_id: 42, content_md: content, revision, updated_at: '2026-10-15' } })
  })
  await page.goto('/videos/42')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  return { editor, writes }
}

for (const sample of [
  { name: 'citations séparées', text: '> première\n\n> seconde', quoted: 2, markers: 0 },
  { name: 'chevron dans un paragraphe', text: 'Texte > ordinaire', quoted: 0, markers: 0 },
  { name: 'callout imbriqué seul', text: '> > [!quote] imbriqué', quoted: 1, markers: 0 },
  { name: 'continuations et ligne citée vide', text: '> début\nsuite\n>\n> fin', quoted: 4, markers: 0 },
  { name: 'liste et imbrication', text: '- > [!quote] Auteur\n  > corps\n  >\n  > > [!quote] Intérieur\n  > > suite', quoted: 5, markers: 1 },
  { name: 'code clôturé extérieur', text: '\x60\x60\x60md\n> [!quote] Auteur\n\x60\x60\x60', quoted: 0, markers: 0 },
  { name: 'code indenté extérieur', text: '    > [!quote] Auteur', quoted: 0, markers: 0 },
  { name: 'code intérieur cité', text: '> \x60\x60\x60md\n> [!quote] Exemple\n> \x60\x60\x60', quoted: 3, markers: 0 },
  { name: 'code indenté dans citation', text: '>     [!quote] Exemple', quoted: 1, markers: 0 },
  { name: 'en-tête non initial', text: '>\n> [!quote] tardif', quoted: 2, markers: 0 },
  { name: 'marqueur échappé', text: '> \\[!quote] Auteur', quoted: 1, markers: 0 },
  { name: 'variante inconnue', text: '> [!quote:autre] Auteur', quoted: 1, markers: 0 },
  { name: 'URI invalide', text: '> [!quote:tr](' + uri + '&end_ms=5) Titre', quoted: 1, markers: 0 },
  { name: 'URI externe', text: '> [!quote:tr](https://example.org) Titre', quoted: 1, markers: 0 },
  { name: 'callout sans titre', text: '> [!quote:tr](' + uri + ')\n> corps', quoted: 2, markers: 1 },
]) {
  test('structure : ' + sample.name, async ({ page }) => {
    const { editor, writes } = await openEditor(page, sample.text)
    await expect(editor.locator('.cm-markdown-quote')).toHaveCount(sample.quoted)
    await expect(editor.locator('.cm-callout-marker')).toHaveCount(sample.markers)
    expect((await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(sample.text)
    await expect(editor.locator('button, a, [contenteditable="false"]')).toHaveCount(0)
    expect(writes).toEqual([])
  })
}

test('reconnaissance réactive, sélection et Undo/Redo sans remontage', async ({ page }) => {
  const initial = '> [!quote:tr](' + uri + '&end_ms=5) Titre'
  const valid = '> [!quote:tr](' + uri + ') Titre'
  const { editor, writes } = await openEditor(page, initial)
  const node = await editor.elementHandle()
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(valid)
  await expect(editor.locator('.cm-callout-uri')).toHaveText(uri)
  await expect(editor.locator('.cm-callout-label')).toHaveText('Titre')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('.cm-callout-marker')).toHaveCount(0)
  expect((await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(initial)
  await page.keyboard.press('Control+Shift+z')
  await expect(editor.locator('.cm-callout-marker')).toHaveCount(1)
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(valid)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await node!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(valid)
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes.at(-1)).toBe(valid)
})

test('contexte hors écran : grand bloc et analyse incrémentale', async ({ page }) => {
  const text = '> [!quote] Auteur\n' + '> continuation\n'.repeat(600) + '> fin'
  const { editor, writes } = await openEditor(page, text)
  await editor.click()
  await page.keyboard.press('Control+End')
  await expect(editor.locator('.cm-line').filter({ hasText: /^> fin$/ })).toHaveClass(/cm-markdown-callout/)
  await page.keyboard.press('Control+Home')
  await expect(editor.locator('.cm-callout-label')).toHaveText('Auteur')
  expect(writes).toEqual([])
})

for (const width of [375, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test('rendu sans écriture : ' + width + ' ' + theme, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      const text = '> Citation ordinaire\ncontinuation sans marqueur\n>\n> > citation imbriquée\n\n' +
        '> [!quote] Aristote\n> Une réflexion citée.\n\n' +
        '> [!quote:tr](' + uri + ') Les limites des modèles de raisonnement\n> ' + 'Texte cité long. '.repeat(8)
      const { editor, writes } = await openEditor(page, text)
      await expect(editor.locator('.cm-callout-marker')).toHaveCount(2)
      await expect(editor.locator('.cm-callout-uri')).toHaveText(uri)
      await expect(editor.locator('.cm-callout-label').last()).toHaveText('Les limites des modèles de raisonnement')
      expect((await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(text)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const quoted = editor.locator('.cm-markdown-quote')
      const first = await quoted.nth(0).boundingBox()
      const second = await quoted.nth(1).boundingBox()
      expect(Math.abs(first!.y + first!.height - second!.y)).toBeLessThan(1)
      await editor.screenshot({ path: info.outputPath('editor-quotes.png') })
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' })
      expect((await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(text)
      expect(writes).toEqual([])
    })
  }
}
