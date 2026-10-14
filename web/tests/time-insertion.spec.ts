import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** Prépare une note réelle ; seules les opérations YouTube restent simulées. */
async function openNote(page: Page, request: APIRequestContext, content = 'Avant\r\n\nAprès\r\n') {
  const externalID = `tr62${test.info().testId.slice(-7)}`
  const response = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })
  const video = await response.json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  await page.goto(`/videos/${video.id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  return { editor, noteURL, video, content: content.replace(/\r\n?/g, '\n') }
}

for (const state of [0, 1, 2]) {
  test(`insertion à l’état ${state}, focus, millisecondes et autosauvegarde sans commande au lecteur`, async ({ page, request }) => {
    const { editor, noteURL, video, content } = await openNote(page, request)
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    await page.evaluate(state => {
      const player = window.youtubeTest.players.at(-1)!
      player.position = 762.3454
      player.emitState(state)
    }, state)
    const node = await editor.elementHandle()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.getByRole('button', { name: '+ Temps', exact: true }).click()
    await expect(editor).toBeFocused()
    await page.keyboard.type('Suite')
    const reference = `[12:42](sillage://videos/${video.id}/sources/${video.sources[0].id}?start_ms=762345)`
    await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(content + reference + ' Suite')
    expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
    expect(await page.evaluate(() => {
      const player = window.youtubeTest.players.at(-1)!
      return { state: player.state, position: player.position, pauses: player.pauseCalls, calls: player.navigationCalls }
    })).toEqual({ state, position: 762.3454, pauses: 0, calls: [] })
    await page.getByRole('button', { name: 'Lecture', exact: true }).click()
    await expect(page.getByRole('button', { name: '+ Temps', exact: true })).toBeDisabled()
    await expect(page.getByLabel('Lecture de la note')).toContainText('12:42')
    await expect(page.getByLabel('Lecture de la note').locator('a')).toHaveCount(0)
    await expect(page.getByLabel('Lecture de la note').getByRole('button', { name: '12:42', exact: true })).toBeVisible()
    await expect(page.getByLabel('Lecture de la note')).not.toContainText('sillage://')
  })
}

for (const backwards of [false, true]) {
  test(`sélection ${backwards ? 'inversée' : 'directe'} préservée, insertion isolée dans Undo/Redo`, async ({ page, request }) => {
    const { editor, noteURL, video } = await openNote(page, request, 'alpha omega')
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    await page.evaluate(() => {
      const player = window.youtubeTest.players.at(-1)!
      player.position = 3661.7896
      player.emitState(1)
    })
    await editor.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('X')
    if (backwards) {
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    } else {
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    }
    const button = page.getByRole('button', { name: '+ Temps', exact: true })
    await button.focus()
    await button.press('Enter')
    const reference = `[1:01:01](sillage://videos/${video.id}/sources/${video.sources[0].id}?start_ms=3661790)`
    await expect(editor).toHaveText(`Xalpha${reference}  omega`)
    await page.keyboard.type('suite')
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText(`Xalpha${reference}  omega`)
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText('Xalpha omega')
    await page.keyboard.press('Control+Shift+Z')
    await expect(editor).toHaveText(`Xalpha${reference}  omega`)
    await page.keyboard.press('Control+Shift+Z')
    await expect(editor).toHaveText(`Xalpha${reference} suite omega`)
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(`Xalpha${reference} suite omega`)
  })
}

test('lecteur masqué, zéro valide et clics répétés sans réafficher ni reprendre', async ({ page, request }) => {
  const { editor, video } = await openNote(page, request, '')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  const reference = `[0:00](sillage://videos/${video.id}/sources/${video.sources[0].id}?start_ms=0) `
  await expect(editor).toHaveText(reference.repeat(2))
  await expect(page.locator('.youtube-frame iframe')).toBeHidden()
  expect(await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    return { state: player.state, pauses: player.pauseCalls, calls: player.navigationCalls }
  })).toEqual({ state: 2, pauses: 1, calls: [] })
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(reference)
})

test('états refusés, valeurs invalides et exception sans insertion ni commande différée', async ({ page, request }) => {
  const { editor, noteURL } = await openNote(page, request, 'Intact')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  for (const state of [-1, 5, 3, 99]) {
    await page.evaluate(state => {
      const player = window.youtubeTest.players.at(-1)!
      player.position = 762.345
      player.emitState(state)
    }, state)
    await page.getByRole('button', { name: '+ Temps', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Temps indisponible')
    await expect(editor).toHaveText('Intact')
  }
  for (const position of [NaN, Infinity, -0.1, Number.MAX_SAFE_INTEGER]) {
    await page.evaluate(position => {
      const player = window.youtubeTest.players.at(-1)!
      player.position = position
      player.emitState(2)
    }, position)
    await page.getByRole('button', { name: '+ Temps', exact: true }).click()
    await expect(editor).toHaveText('Intact')
  }
  await page.evaluate(() => {
    window.youtubeTest.players.at(-1)!.getCurrentTime = () => { throw new Error('Unavailable') }
  })
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect(editor).toHaveText('Intact')
  expect((await (await request.get(noteURL)).json()).revision).toBe(1)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

test('avant onReady puis erreur : aucun temps fictif ni insertion tardive après réessai', async ({ page, request }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  const { editor } = await openNote(page, request, 'Intact')
  const button = page.getByRole('button', { name: '+ Temps', exact: true })
  await button.click()
  await expect(page.getByRole('alert')).toContainText('Temps indisponible')
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.options.events.onReady({ target: player })
    player.emitState(1)
  })
  await expect(editor).toHaveText('Intact')
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.options.events.onError({ data: 100 }))
  await button.click()
  await expect(editor).toHaveText('Intact')
  await page.evaluate(() => { window.youtubeTest.autoReady = true })
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect(editor).toHaveText('Intact')
})

test('masquage non confirmé puis destruction refusent l’insertion', async ({ page, request }) => {
  await page.clock.install()
  const { editor } = await openNote(page, request, 'Intact')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    window.youtubeTest.confirmPause = false
    window.youtubeTest.players.at(-1)!.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect(editor).toHaveText('Intact')
  await page.clock.runFor(1100)
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect(editor).toHaveText('Intact')
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0)
})
