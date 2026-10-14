import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { expect, test } from './fixtures'
import { remarkCallouts } from '../src/remarkCallouts'

const uri = 'sillage://videos/42/sources/17?start_ms=40360'

/** Exerce la même chaîne Markdown, sans dépendre du navigateur pour les cas de syntaxe. */
function render(content: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkCallouts],
    skipHtml: true,
  }, content))
}

test('attribution littérale, corps GFM et définitions partagées dans la note', () => {
  const html = render('> [!quote] *Aristote* [site](https://example.org)\n> Un **texte** et [source][ref].\n>\n> - élément\n>\n> > citation classique\n\n[ref]: https://example.org/source')
  expect(html).toContain('data-callout="quote"')
  expect(html).toContain('data-attribution="*Aristote* [site](https://example.org)"')
  expect(html).toContain('<strong>texte</strong>')
  expect(html).toContain('<a href="https://example.org/source">source</a>')
  expect(html).toMatch(/<li>\s*(?:<p>)?élément/)
  expect(html).toContain('<blockquote>\n<p>citation classique</p>')
  expect(html).not.toContain('<em>Aristote</em>')
})

for (const newline of ['\n', '\r\n', '\r']) {
  test('en-têtes compacts, vides et séparés, fins de ligne ' + JSON.stringify(newline), () => {
    for (const header of ['[!quote]', '[!quote] Auteur', '[!quote:tr](' + uri + ')']) {
      for (const body of ['', '\n> corps', '\n>\n> corps']) {
        const html = render(('> ' + header + ' \t' + body).replaceAll('\n', newline))
        expect(html).toContain('data-callout=')
        if (body) expect(html).toContain('<p>corps</p>')
        expect(html).not.toContain('<p>[!quote')
      }
    }
  })
}

const invalid = [
  '[!quote:tr]', '[!quote:tr', '[!quote:tr]()', '[!quote:tr](',
  '[!quote:tr](https://example.org)', '[!quote:tr](mailto:a@example.org)',
  '[!quote:tr](javascript:alert(1))', '[!quote:tr](' + uri + '&end_ms=50000)',
  '[!quote:tr](' + uri.replace('/42/', '/042/') + ')',
  '[!quote:tr](' + uri.replace('40360', '9007199254740992') + ')',
  '[!quote:tr](' + uri + ') suite', '[!quote:tr](' + uri + ' "titre")',
  '[!quote:tr](<' + uri + '>)',
  '[!quote](https://example.org)', '[!quote]sans-espace',
  '[!quote:tr][ref]', '[!quote:tr] [lien](https://example.org)',
  '[!quote:tr] ![image](https://example.org/image) <b>texte</b>',
]

for (const header of invalid) {
  test('en-tête invalide inerte : ' + header, () => {
    const html = render('> ' + header + '\n> [Corps](https://example.org/body)\n\n[ref]: https://example.org')
    expect(html).not.toContain('data-callout=')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain('<a href="https://example.org/body">Corps</a>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
  })
}

test('un lien commencé dans un en-tête rejeté ne traverse pas le repli', () => {
  const html = render('> [!quote:tr] [début\n> suite](https://example.org/header) [Corps](https://example.org/body)')
  expect(html).not.toContain('href="https://example.org/header"')
  expect(html).toContain('suite')
  expect(html).toContain('<a href="https://example.org/body">Corps</a>')
})

test('attribution multiligne Markdown : le corps reste présent sans lien issu de l’en-tête', () => {
  const html = render('> [!quote] [début\n> suite](https://example.org/header) [Corps](https://example.org/body)')
  expect(html).toContain('data-attribution="[début"')
  expect(html).not.toContain('href="https://example.org/header"')
  expect(html).toContain('suite')
  expect(html).toContain('<a href="https://example.org/body">Corps</a>')
})

test('liste autorisée, descendants de blockquote non enrichis et en-têtes inertes', () => {
  const html = render('- élément\n\n  > [!quote] Auteur\n  > corps\n  >\n  > > [!quote:tr](' + uri + ')\n  > > [Corps](https://example.org/body)')
  expect(html.match(/data-callout=/g)).toHaveLength(1)
  expect(html).toContain('[!quote:tr](' + uri + ')')
  expect(html).toContain('<a href="https://example.org/body">Corps</a>')
  const nested = render('> classique\n>\n> - élément\n>\n>   > [!quote] Auteur\n>   > texte')
  expect(nested).not.toContain('data-callout=')
})

test('marqueurs inconnus, échappés, hors première ligne et code restent ordinaires', () => {
  for (const content of [
    '> [!quote:autre](https://example.org)\n> texte',
    '> [!QUOTE] Auteur\n> texte',
    '> \\[!quote] Auteur\n> texte',
    '> &#91;!quote] Auteur\n> texte',
    '> avant\n> [!quote] Auteur',
    '>\n> [!quote] Auteur',
    '> \x60[!quote]\x60 Auteur',
    '\x60\x60\x60md\n> [!quote] Auteur\n\x60\x60\x60',
    '    > [!quote] Auteur',
    '>     [!quote] Auteur',
  ]) expect(render(content)).not.toContain('data-callout=')
  expect(render('> [!quote:autre](https://example.org)')).toContain('<a href="https://example.org">!quote:autre</a>')
})

test('anciens blocs et leur référence séparée ne sont pas requalifiés', () => {
  const html = render('> Ancien extrait\n\n— [0:40](' + uri + ')')
  expect(html).not.toContain('data-callout=')
  expect(html).toContain('</blockquote>\n<p>— ')
})

/** Ouvre la vraie interface avec une note déterministe et le lecteur simulé commun aux tests 6.5. */
async function openReading(page: import('@playwright/test').Page, content: string) {
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-14', tags: [], person_ids: [],
    sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Callouts',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
  } }))
  await page.route('**/note', route => route.fulfill({ json: {
    video_id: 42, content_md: content, revision: 1, updated_at: '2026-10-14',
  } }))
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-14',
    items: [{ start_ms: 40360, text: 'Extrait de la transcription.' }],
  } }))
  await page.goto('/videos/42')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByLabel('Lecture de la note')).toBeVisible()
}

const citation = '> [!quote:tr](' + uri + ')\n> Un **extrait** librement éditable.'

for (const state of [-1, 0, 1, 2, 3, 5]) {
  test('callout : navigation existante et précision milliseconde, état ' + state, async ({ page }) => {
    await openReading(page, citation)
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    await page.evaluate(state => window.youtubeTest.players.at(-1)!.emitState(state), state)
    const button = page.getByLabel('Lecture de la note').getByRole('button')
    await expect(button).toHaveText('0:40')
    await expect(button).toHaveAccessibleDescription('Aller à 0:40 dans le lecteur')
    await button.focus()
    await button.press('Enter')
    await expect(button).toBeFocused()
    const result = await page.evaluate(() => {
      const player = window.youtubeTest.players.at(-1)!
      return { call: player.navigationCalls.at(-1), state: player.state }
    })
    expect(result.call?.seconds).toBe(40.36)
    expect(result.call?.command).toBe([-1, 0, 5].includes(state) ? 'cue' : 'seek')
    expect(result.state).toBe([-1, 0, 5].includes(state) ? 5 : state === 2 ? 2 : 1)
  })
}

test('callouts : identités différentes reconnues, message et focus conservés après sauvegarde', async ({ page }) => {
  await openReading(page, citation.replace('/42/', '/43/') + '\n\n' + citation.replace('/17?', '/18?'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/note', async route => {
    await gate
    await route.fulfill({ json: {
      video_id: 42, content_md: route.request().postDataJSON().content_md,
      revision: 2, updated_at: '2026-10-14',
    } })
  })
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  const editorNode = await editor.elementHandle()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Suite')
  const saving = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/note'))
  await page.keyboard.press('Control+s')
  await saving
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const reading = page.getByLabel('Lecture de la note')
  for (const [index, message] of ['autre vidéo', 'autre source'].entries()) {
    await reading.getByRole('button').nth(index).click()
    await expect(reading.getByRole('status').nth(index)).toContainText(message)
  }
  const button = reading.getByRole('button').last()
  const node = await button.elementHandle()
  release()
  await expect(page.getByRole('status', { name: 'État de la note' })).toHaveText('Enregistré')
  await expect(button).toBeFocused()
  expect(await node!.evaluate(el => el === document.querySelectorAll('.quote-callout button')[1])).toBe(true)
  await expect(reading.getByRole('status').last()).toContainText('autre source')
  expect(await page.evaluate(() => window.youtubeTest.players.every(p => !p.navigationCalls.length))).toBe(true)
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await editorNode!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText(' Suite')
})

test('callout indisponible : refus sans défilement ni commande différée', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await openReading(page, citation)
  await page.evaluate(() => { window.scrollBy = () => { throw new Error('Défilement interdit') } })
  const button = page.getByLabel('Lecture de la note').getByRole('button')
  await button.evaluate((el: HTMLButtonElement) => el.click())
  await expect(page.getByLabel('Lecture de la note').getByRole('status')).toContainText('Navigation non effectuée')
  await page.evaluate(() => {
    const p = window.youtubeTest.players.at(-1)!
    p.options.events.onReady({ target: p })
  })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

for (const width of [375, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test('présentation accessible, repli et ancien format : ' + width + ' ' + theme, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 850 })
      await page.emulateMedia({ colorScheme: theme })
      await openReading(page, [
        '> [!quote] *Aristote* [attribution](https://example.org)\n> L’homme est par nature un animal politique.',
        citation,
        '> [!quote:tr](https://example.org/interdit)\n> [Corps](https://example.org/body)',
        '> Ancien extrait\n\n— [0:40](' + uri + ')',
        '> [!quote:tr](' + uri + ')\n> ![Image](' + uri + ') <script>interdit()</script>',
      ].join('\n\n'))
      const reading = page.getByLabel('Lecture de la note')
      await expect(reading.locator('.quote-callout')).toHaveCount(3)
      await expect(reading.locator('.quote-callout').first()).toHaveAccessibleName('Citation')
      await expect(reading.locator('.quote-callout').nth(1)).toHaveAccessibleName('Citation de transcription')
      await expect(reading.locator('.quote-callout-attribution')).toHaveText('*Aristote* [attribution](https://example.org)')
      await expect(reading.getByRole('link')).toHaveCount(1)
      await expect(reading.getByRole('link')).toHaveAttribute('href', 'https://example.org/body')
      await expect(reading.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(reading.locator('script, img[src^="sillage:"]')).toHaveCount(0)
      await expect(reading.getByRole('button')).toHaveCount(3)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await reading.scrollIntoViewIfNeeded()
      await reading.screenshot({ path: info.outputPath('callouts.png') })
      await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
      await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
      await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
      const button = reading.getByRole('button').first()
      await button.click()
      await expect(button).toBeFocused()
      await expect(page.locator('.youtube-frame iframe')).toBeVisible()
      expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
    })
  }
}

test('frontière isolée : entités, code inline et syntaxe setext ne mangent pas le corps', () => {
  const entities = render('> [!quote] A&#10;B\n> Corps &amp; **fort**')
  expect(entities).toContain('data-attribution="A&amp;#10;B"')
  expect(entities).toContain('<p>Corps &amp; <strong>fort</strong></p>')
  expect(entities).not.toContain('<p>B')
  const heading = render('> [!quote]\n> ---\n> suite')
  expect(heading).toContain('<hr/>')
  expect(heading).toContain('<p>suite</p>')
  const multiline = render('> [!quote:tr] \x60début\n> suite\x60 [Corps](https://example.org/body)')
  expect(multiline).toContain('suite')
  expect(multiline).toContain('<a href="https://example.org/body">Corps</a>')
})

test('GFM du corps : tableau, tâche, code et note de bas de page définie hors citation', () => {
  const html = render('> [!quote]\n> | A | B |\n> | - | - |\n> | 1 | 2 |\n>\n> - [x] fait\n>\n> \x60\x60\x60md\n> [!quote] dans le code\n> \x60\x60\x60\n>\n> Référence[^note]\n\n[^note]: texte partagé')
  expect(html).toContain('<table>')
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('[!quote] dans le code')
  expect(html).toContain('texte partagé')
  expect(html.match(/data-callout=/g)).toHaveLength(1)
})

test('continuations paresseuses : le corps reste cité, même dans une liste', () => {
  for (const prefix of ['> ', '- > ']) {
    const html = render(prefix + '[!quote] Auteur\ncorps **fort**\nsuite [lien](https://example.org/body)')
    expect(html).toContain('data-callout="quote"')
    expect(html).toMatch(/<blockquote[^>]*>\s*<p>corps <strong>fort<\/strong>\nsuite <a href="https:\/\/example.org\/body">lien<\/a><\/p>\s*<\/blockquote>/)
  }
  const multiple = render('> [!quote]\npremier\n\n> [!quote:tr](' + uri + ')\nsecond\n>\n> > [!quote:tr](https://example.org/inert)\n> suite intérieure')
  expect(multiple.match(/data-callout=/g)).toHaveLength(2)
  expect(multiple).toContain('second')
  expect(multiple).not.toContain('href="https://example.org/inert"')
  expect(multiple).toContain('suite intérieure')
})
