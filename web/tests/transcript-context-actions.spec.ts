import { test, expect } from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'
import { selectTheme } from './navigationHelpers'

const items = [
  { start_ms: 1234, text: '  Alpha ' },
  { start_ms: 9000, text: 'Beta.\n' },
  { start_ms: 18000, text: 'Suite Alpha Beta.\n' },
  { start_ms: 28000, text: 'Fin Alpha Beta.' },
]
const sourceText = items.map(item => item.text).join('')
const toolbarName = 'Actions de la sélection de transcription'

/** Garde les services de note et le workspace réels ; seul le contenu de transcription est fixé. */
async function prepare(page: Page, request: APIRequestContext, note = '') {
  const video = await (await request.post('/api/v1/videos', {
    data: { url: 'https://youtu.be/trct' + test.info().testId.slice(-7) },
  })).json()
  const noteURL = '/api/v1/videos/' + video.id + '/note'
  if (note) await request.put(noteURL, { data: { content_md: note, expected_revision: 0 } })
  const transcriptURL = '/api/v1/videos/' + video.id + '/sources/' + video.sources[0].id + '/transcript'
  await page.route('**' + transcriptURL, route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-27T10:00:00Z', items,
  } }))
  await page.goto('/videos/' + video.id)
  const panel = page.getByLabel('Texte de la transcription', { exact: true })
  await expect(panel.locator('[data-transcript-text]')).toHaveCount(3)
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const toolbar = page.getByRole('toolbar', { name: toolbarName })
  return { panel, editor, toolbar, video, noteURL, transcriptURL }
}

/** Pose une plage native en offsets continus, sous les surlignages et dans les deux sens. */
async function selectText(page: Page, start = 2, end = 12, backwards = false) {
  const panel = page.getByLabel('Texte de la transcription', { exact: true })
  await panel.scrollIntoViewIfNeeded()
  await panel.focus()
  await page.evaluate(({ start, end, backwards }) => {
    const nodes: Text[] = []
    for (const paragraph of document.querySelectorAll('[data-transcript-text]')) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    }
    function boundary(offset: number): [Text, number] {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset]
        offset -= node.length
      }
      throw new Error('Offset hors transcription')
    }
    const from = boundary(start)
    const to = boundary(end)
    window.getSelection()!.setBaseAndExtent(...(backwards ? to : from), ...(backwards ? from : to))
  }, { start, end, backwards })
}

/** Observe les bornes natives pour détecter une perte ou une inversion pendant le transfert de focus. */
async function nativeSelection(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection()!
    return {
      anchor: selection.anchorOffset, head: selection.focusOffset,
      anchorText: selection.anchorNode?.textContent, headText: selection.focusNode?.textContent,
      text: selection.toString(),
    }
  })
}

/** Relève des coordonnées de caractères rendus sans en déduire les offsets source. */
async function dragPoints(page: Page) {
  return page.locator('[data-transcript-text]').evaluateAll(paragraphs => {
    function point(element: Element, start: number, end: number, right: boolean) {
      const node = element.firstChild!
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const box = range.getBoundingClientRect()
      return { x: right ? box.right - .1 : box.left + .1, y: box.top + box.height / 2 }
    }
    return { from: point(paragraphs[0], 2, 3, false), to: point(paragraphs[1], 15, 16, true) }
  })
}

for (const backwards of [false, true]) {
  test('glisser natif entre blocs : gel, copie et recherche, inversé=' + backwards, async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const { panel, toolbar } = await prepare(page, request)
    await panel.scrollIntoViewIfNeeded()
    const points = await dragPoints(page)
    const from = backwards ? points.to : points.from
    const to = backwards ? points.from : points.to
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.waitForTimeout(300)
    await expect(toolbar).toHaveCount(0)
    await page.mouse.up()
    await expect(toolbar).toBeVisible()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const before = await nativeSelection(page)
    await page.keyboard.press('Control+c')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Alpha Beta. Suite Alpha Beta')
    expect(await nativeSelection(page)).toEqual(before)
    await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
    await expect(page.getByRole('searchbox')).toHaveValue('Alpha Beta. Suite Alpha Beta')
    await expect(page.getByRole('searchbox')).toBeFocused()
    await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  })
}

test('clavier : accès sans focus volé, conservation de la plage, flèches et fermeture Échap', async ({ page, request }) => {
  const { panel, toolbar } = await prepare(page, request)
  await selectText(page, 3, 12, true)
  await expect(toolbar).toBeVisible()
  await expect(panel).toBeFocused()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar).toHaveCount(0)
  await expect(toolbar).toBeVisible()
  expect((await nativeSelection(page)).text).toBe('Alpha Beta')
  const before = await nativeSelection(page)
  await page.keyboard.press('Tab')
  await expect(toolbar.getByRole('button', { name: 'Citer dans la note', exact: true })).toBeFocused()
  expect(await nativeSelection(page)).toEqual(before)
  await page.keyboard.press('ArrowRight')
  await expect(toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true })).toBeFocused()
  expect(await nativeSelection(page)).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(toolbar).toHaveCount(0)
  await expect(panel).toBeFocused()
  expect(await nativeSelection(page)).toEqual(before)
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(300)
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeEnabled()
})

test('Citer réutilise le timestamp, la session, la sauvegarde et Undo/Redo sur un extrait surligné', async ({ page, request }) => {
  const { editor, toolbar, video, noteURL } = await prepare(page, request, 'Avant')
  const original = await editor.elementHandle()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('X')
  await page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await page.getByRole('searchbox').fill('Alpha')
  await selectText(page, 4, sourceText.indexOf('Fin'), true)
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Citer dans la note', exact: true }).click()
  const expected = 'AvantX\n\n> [!quote:tr](sillage://videos/' + video.id + '/sources/' + video.sources[0].id +
    '?start_ms=1234)\n> pha Beta. Suite Alpha Beta.\n\n'
  await expect(editor).toBeFocused()
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(expected)
  expect(await original!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('AvantX')
  await page.keyboard.press('Control+Shift+Z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(expected)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

for (const reading of [false, true]) {
  test('citation refusée sans insertion différée ni changement de mode, lecture=' + reading, async ({ page, request }) => {
    const { editor, panel, toolbar, noteURL } = await prepare(page, request, 'Note existante')
    if (reading) await page.getByRole('button', { name: 'Lecture', exact: true }).click()
    const writes: string[] = []
    page.on('request', request => {
      if (request.url().endsWith('/note') && request.method() === 'PUT') writes.push(request.postData()!)
    })
    await selectText(page)
    await expect(toolbar).toBeVisible()
    if (reading) await toolbar.getByRole('button', { name: 'Citer dans la note', exact: true }).click()
    else {
      await page.keyboard.press('Tab')
      await toolbar.getByRole('button', { name: 'Citer dans la note', exact: true }).press('Enter')
      await expect(panel).toBeFocused()
    }
    await expect(page.getByRole('status').filter({ hasText: reading ? 'Passez en Édition' : 'Placez le curseur' })).toBeVisible()
    if (reading) await expect(editor).toBeHidden()
    else await expect(editor).toBeVisible()
    await expect(toolbar).toHaveCount(0)
    await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
    if (reading) await page.getByRole('button', { name: 'Édition', exact: true }).click()
    await expect(editor).toHaveText('Note existante')
    expect((await (await request.get(noteURL)).json()).content_md).toBe('Note existante')
    expect(writes).toEqual([])
  })
}

test('Rechercher rouvre la recherche existante à la première occurrence, même requête, sans réseau ni lecteur', async ({ page, request }) => {
  const { toolbar } = await prepare(page, request)
  const toggle = page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true })
  await toggle.click()
  const input = page.getByRole('searchbox')
  await input.fill('Alpha Beta')
  await page.getByRole('button', { name: 'Occurrence précédente' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('3 / 3')
  await input.press('Escape')
  const from = sourceText.lastIndexOf('Alpha Beta')
  await selectText(page, from, from + 10)
  await expect(toolbar).toBeVisible()
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  const player = await page.evaluate(() => {
    const p = window.youtubeTest.players.at(-1)!
    return { position: p.position, state: p.state, calls: p.navigationCalls, pauses: p.pauseCalls }
  })
  await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Alpha Beta')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 3')
  await expect(page.locator('mark[aria-current=true]')).toHaveText('Alpha Beta')
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  await input.press('Enter')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 3')
  expect(await page.evaluate(() => {
    const p = window.youtubeTest.players.at(-1)!
    return { position: p.position, state: p.state, calls: p.navigationCalls, pauses: p.pauseCalls }
  })).toEqual(player)
  expect(requests).toEqual([])
})

test('cycle de vie : nouvelle plage, repli, blancs, extérieur et recherche invalident les anciennes cibles', async ({ page, request }) => {
  const { toolbar } = await prepare(page, request)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await selectText(page, 8, 12)
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('Beta')
  await page.getByRole('searchbox').press('Escape')
  for (const [from, to] of [[2, 2], [0, 2]]) {
    await selectText(page, from, to)
    await page.waitForTimeout(250)
    await expect(toolbar).toHaveCount(0)
    await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  }
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await page.locator('.transcript-time').first().click()
  await page.waitForTimeout(250)
  await expect(toolbar).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toHaveLength(1)
  await selectText(page, 3, 12)
  await expect(toolbar).toBeVisible()
  await page.locator('.site-header h1').click()
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await page.getByRole('searchbox').fill('Suite')
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
})

test('plage caduque avant selectionchange et remplacement de transcription : aucune action ancienne', async ({ page, request }) => {
  const { toolbar, transcriptURL } = await prepare(page, request)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).evaluate(button => {
    window.getSelection()!.collapseToStart()
    ;(button as HTMLButtonElement).click()
  })
  await expect(page.getByRole('searchbox')).toBeHidden()
  await expect(toolbar).toHaveCount(0)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await page.route('**' + transcriptURL, route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-27T11:00:00Z',
    items: [{ start_ms: 40000, text: 'Nouveau contenu' }],
  } }))
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.locator('[data-transcript-text]')).toHaveText(['Nouveau contenu'])
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
})

test('actualisation reçue pendant un geste : invalider la cible sans perdre le gel jusqu’au relâchement', async ({ page, request }) => {
  const { panel, toolbar, transcriptURL } = await prepare(page, request)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const acquired = new Promise<void>(resolve => { started = resolve })
  await page.route('**' + transcriptURL, async route => {
    started()
    await gate
    await route.fulfill({ json: {
      language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-27T11:00:00Z',
      items: [{ start_ms: 40000, text: 'Nouveau passage.' }],
    } })
  })
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await acquired
  await panel.scrollIntoViewIfNeeded()
  const points = await dragPoints(page)
  await page.mouse.move(points.from.x, points.from.y)
  await page.mouse.down()
  release()
  await expect(page.locator('[data-transcript-text]')).toHaveText(['Nouveau passage.'])
  // Le DOM renouvelé reçoit une nouvelle plage valide, mais le bouton de souris est toujours enfoncé.
  await selectText(page, 0, 7)
  await page.waitForTimeout(300)
  await expect(toolbar).toHaveCount(0)
  await page.mouse.up()
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('Nouveau')
})

test('sélection extérieure non vide après focus sur la citation : ne jamais consommer l’ancien extrait', async ({ page, request }) => {
  const { toolbar, editor } = await prepare(page, request)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  const cite = page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note', exact: true })
  await cite.focus()
  await cite.evaluate(button => {
    const native = window.getSelection()!
    native.selectAllChildren(document.querySelector('.site-header')!)
    // L'action précède volontairement la notification native selectionchange.
    ;(button as HTMLButtonElement).click()
  })
  await expect(editor).toHaveText('')
  await expect(cite).toBeDisabled()
  await expect(toolbar).toHaveCount(0)
})

test('notification tardive après focus extérieur : ne réarmer ni le menu ni la citation d’en-tête', async ({ page, request }) => {
  const { toolbar } = await prepare(page, request)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).evaluate(button => {
    const native = window.getSelection()!
    const range = native.getRangeAt(0).cloneRange()
    // La sélection source change de sens ; sa notification arrive après la sortie de focus.
    native.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
    document.querySelector<HTMLButtonElement>('.transcript-acquisition')!.focus()
    ;(button as HTMLButtonElement).focus()
  })
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true })).toBeFocused()
  await page.waitForTimeout(300)
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('.transcript-actions').getByRole('button', { name: 'Citer dans la note', exact: true })).toBeDisabled()
})

test('fermeture hors écran avec focus dans le menu : rendre le clavier à la transcription sans déplacer le scroll', async ({ page, request }) => {
  const { panel, toolbar } = await prepare(page, request)
  await selectText(page)
  await expect(toolbar).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(toolbar.getByRole('button', { name: 'Citer dans la note', exact: true })).toBeFocused()
  const before = await panel.evaluate(element => {
    element.style.minHeight = '0'
    element.style.height = '20px'
    element.style.flex = 'none'
    element.style.overflow = 'auto'
    element.scrollTop = element.scrollHeight
    return { panel: element.scrollTop, page: scrollY }
  })
  await expect(toolbar).toHaveCount(0)
  await expect(panel).toBeFocused()
  expect(await panel.evaluate(element => ({ panel: element.scrollTop, page: scrollY }))).toEqual(before)
})

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark']) {
    test('position et thèmes, largeur=' + width + ', thème=' + theme, async ({ page, request }, info) => {
      await page.setViewportSize({ width, height: 850 })
      const { panel, toolbar } = await prepare(page, request)
      await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
      await selectTheme(page, theme)
      await selectText(page)
      await expect(toolbar).toBeVisible()
      for (const label of ['Citer dans la note', 'Rechercher dans la transcription']) {
        const action = toolbar.getByRole('button', { name: label, exact: true })
        const permanent = page.locator('.transcript-actions').getByRole('button', { name: label, exact: true })
        await expect(action).toHaveAccessibleName(label)
        await expect(action).toHaveAttribute('title', label)
        await expect(action.locator('svg')).toHaveAttribute('aria-hidden', 'true')
        expect(await action.textContent()).toBe('')
        expect(await action.locator('svg').innerHTML()).toBe(await permanent.locator('svg').innerHTML())
        const target = (await action.boundingBox())!
        expect(target.width).toBeGreaterThanOrEqual(40)
        expect(target.height).toBeGreaterThanOrEqual(40)
      }
      const quote = toolbar.getByRole('button', { name: 'Citer dans la note', exact: true }).locator('svg path')
      await expect(quote).toHaveCount(2)
      await expect(quote.nth(0)).toHaveAttribute('d', /^M16 3a2 2/)
      await expect(quote.nth(1)).toHaveAttribute('d', /^M5 3a2 2/)
      const box = (await toolbar.boundingBox())!
      const anchor = await page.evaluate(() => {
        const box = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
        return { top: box.top, bottom: box.bottom }
      })
      expect(box.x).toBeGreaterThanOrEqual(8)
      expect(box.x + box.width).toBeLessThanOrEqual(width - 8)
      expect(box.y).toBeGreaterThanOrEqual(8)
      expect(box.y + box.height).toBeLessThanOrEqual(850 - 8)
      expect(Math.min(Math.abs(box.y + box.height - anchor.top), Math.abs(box.y - anchor.bottom))).toBeLessThanOrEqual(9)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(panel).toBeFocused()
      await page.screenshot({ path: info.outputPath('transcript-actions.png'), fullPage: true })
      await panel.evaluate(element => {
        element.style.minHeight = '0'
        element.style.height = '20px'
        element.style.flex = 'none'
        element.style.overflow = 'auto'
        element.scrollTop = element.scrollHeight
      })
      await expect(toolbar).toHaveCount(0)
    })
  }
}

test.describe('tactile Chromium Android simulé', () => {
  test.use({
    hasTouch: true,
    viewport: { width: 375, height: 850 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  })

  test('sélection pendant un toucher simulé puis tap sur Rechercher sans perdre la cible', async ({ page, request, context }) => {
    const { panel, toolbar } = await prepare(page, request)
    await page.getByRole('button', { name: 'Masquer la vidéo' }).tap()
    await panel.scrollIntoViewIfNeeded()
    const points = await dragPoints(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: points.from.x + 20, y: points.from.y }],
    })
    // La plage est posée par le DOM : cela simule le changement de sélection des poignées,
    // sans prétendre valider le menu de sélection système d'un véritable appareil Android.
    await selectText(page, 2, 7)
    // Le navigateur peut céder le pointeur à la sélection native avant la fin du contact.
    await panel.dispatchEvent('pointercancel', { pointerType: 'touch' })
    await page.waitForTimeout(800)
    await expect(toolbar).toHaveCount(0)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(toolbar).toBeVisible()
    expect((await nativeSelection(page)).text).toBe('Alpha')
    await toolbar.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).tap()
    await expect(page.getByRole('searchbox')).toHaveValue('Alpha')
    await expect(page.getByRole('searchbox')).toBeFocused()
    await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 3')
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
    await cdp.detach()
  })
})
