import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const uri = 'sillage://videos/42/sources/17?start_ms=40360'
const link = '[Passage](' + uri + ')'
const callout = '> [!quote:tr](' + uri + ') Mon titre\n> Corps'

/** Prépare un lecteur simulé et observe les écritures de la vraie session. */
async function open(page: Page, text: string, state = 2) {
  const writes: string[] = []
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, tags: [], person_ids: [], sources: [{ id: 17, provider: 'youtube',
      external_id: 'abcdefghijk', title: 'Test', canonical_url: 'https://youtu.be/abcdefghijk' }],
  } }))
  await page.route('**/note', route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON().content_md)
    return route.fulfill({ json: { video_id: 42, content_md: writes.at(-1) ?? text,
      revision: writes.length + 1, updated_at: '2026-10-15' } })
  })
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-15', items: [],
  } }))
  await page.goto('/videos/42')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(state => window.youtubeTest.players.at(-1)!.emitState(state), state)
  return { editor, compact: editor.locator('.cm-temporal-reference'), writes }
}

for (const text of [link, callout]) {
  for (const state of [-1, 0, 1, 2, 3, 5]) {
    test('activation compacte, état ' + state + ', callout ' + (text === callout), async ({ page }) => {
      const { editor, compact, writes } = await open(page, text, state)
      await editor.focus()
      await page.keyboard.press('Control+End')
      const node = await editor.elementHandle()
      const selection = await page.evaluate(() => {
        const s = getSelection()!
        return [s.anchorOffset, s.focusOffset, s.anchorNode?.textContent]
      })
      await compact.click({ modifiers: ['Control'] })
      await expect(compact).toHaveCount(1)
      await expect(editor).toBeFocused()
      expect(await page.evaluate(() => {
        const s = getSelection()!
        return [s.anchorOffset, s.focusOffset, s.anchorNode?.textContent]
      })).toEqual(selection)
      expect(await node!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
      expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([
        { command: 'seek', seconds: 40.36, allowSeekAhead: true },
      ])
      expect(writes).toEqual([])
      if (text === callout) {
        await expect(editor).toHaveText('> [!quote:tr](◷0:40) Mon titre> Corps')
        await expect(editor.locator('.cm-callout-marker')).toHaveText('[!quote:tr]')
        await expect(editor.locator('.cm-callout-label')).toHaveText('Mon titre')
      }
    })
  }

  test('source révélée : Ctrl+clic, raccourci et copie, callout ' + (text === callout), async ({ page }) => {
    const { editor, compact, writes } = await open(page, text)
    await compact.click()
    await expect(compact).toHaveCount(0)
    await page.keyboard.press('Control+Enter')
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.length)).toBe(1)
    const target = text === callout ? editor.locator('.cm-callout-uri') : editor.locator('.cm-line').first()
    await target.click({ modifiers: ['Control'], position: { x: 15, y: 8 } })
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.length)).toBe(2)
    await expect(compact).toHaveCount(0)
    await page.keyboard.press('Control+a')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(text)
    expect(writes).toEqual([])
  })
}

for (const other of [uri.replace('/42/', '/43/'), uri.replace('/17?', '/18?')]) {
  test('refus identité ' + other, async ({ page }) => {
    const { compact, writes } = await open(page, '[Autre](' + other + ')')
    await compact.click({ modifiers: ['Control'] })
    await expect(page.getByRole('status', { name: 'Navigation temporelle' })).toContainText('autre')
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
    expect(writes).toEqual([])
  })
}

test('indisponible : refus accessible sans commande', async ({ page }) => {
  const { compact, writes } = await open(page, link)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.options.events.onError({ data: 100 }))
  await compact.click({ modifiers: ['Control'] })
  await expect(page.getByRole('status', { name: 'Navigation temporelle' })).toContainText('indisponible')
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  expect(writes).toEqual([])
})

for (const text of [
  '> [!quote] ' + link,
  '> > [!quote:tr](' + uri + ')',
  '> [!quote:tr](' + uri + '&end_ms=5)',
  '> [!quote:tr](' + uri + ')sans espace',
  '\x60' + link + '\x60',
  '![Image](' + uri + ')',
]) {
  test('contexte inerte : ' + text, async ({ page }) => {
    const { editor, compact, writes } = await open(page, text)
    await expect(compact).toHaveCount(0)
    await editor.focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowRight')
    await editor.locator('.cm-line').first().click({ modifiers: ['Control'], position: { x: 40, y: 8 } })
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
    expect(writes).toEqual([])
  })
}

test('Cmd sur Mac : compaction, source révélée et clavier', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
  const { compact, writes } = await open(page, link)
  await compact.click({ modifiers: ['Meta'] })
  await expect(compact).toHaveCount(1)
  await compact.click()
  await page.keyboard.press('Meta+Enter')
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.length)).toBe(2)
  expect(writes).toEqual([])
})

test('callout dans une liste : suppression protégée, copie, Undo et titre inerte', async ({ page }) => {
  const text = '- ' + callout.replace('\n', '\n  ') + '\n'
  const { editor, compact, writes } = await open(page, text)
  await expect(compact).toHaveText('◷0:40')
  await compact.click()
  await page.keyboard.press('ArrowLeft')
  await expect(compact).toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(compact).toHaveCount(0)
  expect(writes).toEqual([])
  await page.keyboard.press('Delete')
  await expect(editor).toContainText('illage://')
  await page.keyboard.press('Control+z')
  await expect(compact).toHaveCount(1)
  await editor.locator('.cm-callout-label').click({ modifiers: ['Control'] })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await page.keyboard.press('Control+a')
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(text)
})

test('sélection préservée lors du clic modifié et Undo inchangé', async ({ page }) => {
  const { editor, compact, writes } = await open(page, 'Avant ' + link + ' après')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('X')
  await page.keyboard.press('Shift+ArrowLeft')
  const before = writes.length
  await compact.click({ modifiers: ['Control'] })
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('X')
  expect(writes.length).toBe(before)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+a')
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Avant ' + link + ' après')
})

test('lecteur masqué réaffiché sans perte du focus', async ({ page }) => {
  const { editor, compact, writes } = await open(page, link)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await editor.focus()
  await page.keyboard.press('Control+End')
  await compact.click({ modifiers: ['Control'] })
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(editor).toBeFocused()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  expect(writes).toEqual([])
})

test('modificateurs supplémentaires et lien externe : aucune activation temporelle', async ({ page }) => {
  const { editor, compact, writes } = await open(page, link + '\n[Web](https://example.org)')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await compact.click({ modifiers: ['Control', 'Shift'] })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await editor.locator('.cm-line').last().click({ modifiers: ['Control'], position: { x: 20, y: 8 } })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  expect(writes).toEqual([])
})

test('un refus ne remonte pas le widget et une correction utilise la référence courante', async ({ page }) => {
  const { editor, compact, writes } = await open(page, link.replace('/42/', '/43/'))
  const node = await compact.elementHandle()
  await compact.click({ modifiers: ['Control'] })
  await expect(page.getByRole('status', { name: 'Navigation temporelle' })).toContainText('autre vidéo')
  expect(await node!.evaluate(el => el === document.querySelector('.cm-temporal-reference'))).toBe(true)
  expect(writes).toEqual([])
  await editor.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(link)
  await compact.click({ modifiers: ['Control'] })
  await expect(page.getByRole('status', { name: 'Navigation temporelle' })).toBeEmpty()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.length)).toBe(1)
})

for (const mac of [false, true]) {
  for (const revealed of [false, true]) {
    for (const text of [link, callout]) {
      test('curseur : Mac=' + mac + ', source=' + revealed + ', callout=' + (text === callout), async ({ page }) => {
        if (mac) await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
        const { editor, compact, writes } = await open(page, text)
        await editor.focus()
        if (revealed) await compact.click()
        const target = revealed ? editor.locator('.cm-temporal-source').first() : compact
        await target.hover()
        const normalCursor = await target.evaluate(el => getComputedStyle(el).cursor)
        expect(normalCursor).not.toBe('pointer')
        const selection = await page.evaluate(() => {
          const s = getSelection()!
          return [s.anchorOffset, s.focusOffset, s.anchorNode?.textContent]
        })
        const modifier = mac ? 'Meta' : 'Control'
        await page.keyboard.down(modifier)
        await expect(target).toHaveCSS('cursor', 'pointer')
        await page.keyboard.down('Shift')
        await expect(target).toHaveCSS('cursor', normalCursor)
        await page.keyboard.up('Shift')
        await expect(target).toHaveCSS('cursor', 'pointer')
        await page.keyboard.up(modifier)
        await expect(target).toHaveCSS('cursor', normalCursor)

        // Entrée avec le modificateur déjà maintenu, sans nouveau keydown dans l'éditeur.
        await page.getByRole('tab', { name: 'Note', exact: true }).hover()
        await page.keyboard.down(modifier)
        await expect(target).toHaveCSS('cursor', normalCursor)
        await target.hover()
        await expect(target).toHaveCSS('cursor', 'pointer')
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await expect(target).toHaveCSS('cursor', normalCursor)
        await page.keyboard.up(modifier)
        await page.keyboard.down(modifier)
        await expect(target).toHaveCSS('cursor', 'pointer')
        await page.keyboard.up(modifier)
        await expect(editor).toBeFocused()
        expect(await page.evaluate(() => {
          const s = getSelection()!
          return [s.anchorOffset, s.focusOffset, s.anchorNode?.textContent]
        })).toEqual(selection)
        expect(writes).toEqual([])
        expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
      })
    }
  }
}

test('curseur normal sur titre littéral, en-tête invalide et lien Web', async ({ page }) => {
  const text = callout + '\n\n> [!quote:tr](' + uri + '&end_ms=5)\n\n[Web](https://example.org)'
  const { editor, compact, writes } = await open(page, text)
  await editor.focus()
  await compact.hover()
  await page.keyboard.down('Control')
  await expect(compact).toHaveCSS('cursor', 'pointer')
  await editor.locator('.cm-callout-label').hover()
  await expect(editor.locator('.cm-callout-label')).not.toHaveCSS('cursor', 'pointer')
  const invalid = editor.locator('.cm-line').filter({ hasText: '&end_ms=5' })
  await invalid.hover()
  await expect(invalid).not.toHaveCSS('cursor', 'pointer')
  await expect(invalid.locator('.cm-temporal-source')).toHaveCount(0)
  await editor.locator('.cm-line').last().hover()
  await expect(editor.locator('.cm-line').last()).not.toHaveCSS('cursor', 'pointer')
  await page.keyboard.up('Control')
  expect(writes).toEqual([])
})
