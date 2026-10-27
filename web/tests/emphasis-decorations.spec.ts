import { test, expect } from '@playwright/test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { emphasisDecorations } from '../src/livePreviewEmphasis'

/** Reconstruit seulement le rendu attendu des plages masquées, sans modifier l'état testé. */
function presentation(doc: string, selections = [EditorSelection.cursor(doc.length)], visible = [{ from: 0, to: doc.length }]) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(selections),
    extensions: [markdown(), EditorState.allowMultipleSelections.of(true)],
  })
  ensureSyntaxTree(state, doc.length, 1000)
  const hidden: { from: number; to: number; text: string }[] = []
  const revealed: string[] = []
  emphasisDecorations(state, visible).between(0, doc.length, (from, to, value) => {
    if (value.spec.class) revealed.push(state.sliceDoc(from, to))
    else hidden.push({ from, to, text: state.sliceDoc(from, to) })
  })
  let compact = doc
  for (const { from, to } of [...hidden].reverse()) compact = compact.slice(0, from) + compact.slice(to)
  expect(state.sliceDoc()).toBe(doc)
  return { hidden, revealed, compact }
}

for (const sample of [
  ['\\**texte\\**', '\\*texte\\*'],
  ['**gras**', 'gras'], ['__gras__', 'gras'], ['*italique*', 'italique'], ['_italique_', 'italique'],
  ['***texte***', 'texte'], ['**gras et *italique***', 'gras et italique'], ['**_texte_**', 'texte'],
  ['****texte****', 'texte'], ['*un **deux** trois*', 'un deux trois'],
  ['**un** *deux* __trois__ _quatre_', 'un deux trois quatre'],
  ['**deux\nlignes**', 'deux\nlignes'], ['*deux\nlignes*', 'deux\nlignes'],
  ['**un \n deux**', 'un \n deux'],
  ['# **Titre**', '# Titre'], ['> *citation*', '> citation'], ['- __liste__', '- liste'],
  ['> [!quote] Auteur\n> **corps**', '> [!quote] Auteur\n> corps'],
  ['> [!quote:tr](sillage://videos/1/sources/2?start_ms=0) Titre\n> *corps*', '> [!quote:tr](sillage://videos/1/sources/2?start_ms=0) Titre\n> corps'],
  ['**avant \x60*code*\x60 après**', 'avant \x60*code*\x60 après'],
  ['**[lien](https://example.org)**', '[lien](https://example.org)'],
  ['*[temps](sillage://videos/1/sources/2?start_ms=0)*', '[temps](sillage://videos/1/sources/2?start_ms=0)'],
  ['**![image](/a)**', '![image](/a)'],
  ['<span>*texte Markdown*</span>', '<span>texte Markdown</span>'],
]) {
  test('syntaxe reconnue ' + JSON.stringify(sample[0]), () => {
    const { compact, hidden } = presentation('before\n' + sample[0] + '\nafter')
    expect(compact).toBe('before\n' + sample[1] + '\nafter')
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every(range => !/[\s]/.test(range.text))).toBe(true)
  })
}

for (const text of [
  '\\*italique\\*', '\\_texte\\_', '**incomplet', '_incomplet',
  '** espaces **', '* espaces*', '*espaces *', 'mot_entre_mots', 'mot__entre__mots',
  '*', '**', '***', '---', '~~barré~~',
  '\x60**code**\x60', '\x60\x60\x60\n**code**\n\x60\x60\x60', '    *code*',
  '<div>\n**HTML**\n</div>', '<!-- *commentaire* -->', '<span title="**attribut**">texte</span>',
  '[**libellé**](https://example.org/_destination_)', '[__temps__](sillage://videos/1/sources/2?start_ms=0)',
  '![_alt_](/a)', '[référence **gras**][id]\n\n[id]: /a "*titre*"',
  '> [!quote] **Auteur**', '> [!quote:tr](invalide) *Titre*',
  '> > [!quote] __imbriqué__', '- > [!quote] *Auteur*',
  '> [!quote] **traverse\n> le corps**',
]) {
  test('conservé en source ' + JSON.stringify(text), () => {
    const result = presentation('before\n\n' + text + '\n\nafter')
    expect(result.hidden).toEqual([])
  })
}

test('chaque frontière et chaque caractère du contenu et des délimiteurs révèle la paire', () => {
  const doc = 'x **Alpha** et _Beta_ fin'
  const from = doc.indexOf('**')
  const to = from + '**Alpha**'.length
  for (let position = from; position <= to; position++) {
    const result = presentation(doc, [EditorSelection.cursor(position)])
    expect(result.revealed).toEqual(['**', '**'])
    expect(result.hidden.map(range => range.text)).toEqual(['_', '_'])
  }
  expect(presentation(doc, [EditorSelection.cursor(from - 1)]).revealed).toEqual([])
  expect(presentation(doc, [EditorSelection.cursor(to + 1)]).revealed).toEqual([])
})

for (const reversed of [false, true]) {
  test('intersection exclusive, adjacence et sélection traversante, inversée=' + reversed, () => {
    const doc = 'x **Alpha** et _Beta_ fin'
    const first = doc.indexOf('**')
    const second = doc.indexOf('_')
    const range = (from: number, to: number) => EditorSelection.range(reversed ? to : from, reversed ? from : to)
    expect(presentation(doc, [range(0, first)]).revealed).toEqual([])
    expect(presentation(doc, [range(first, second)]).revealed).toEqual(['**', '**'])
    expect(presentation(doc, [range(first + 9, second)]).revealed).toEqual([])
    expect(presentation(doc, [range(0, doc.length)]).hidden).toEqual([])
  })
}

test('imbrications : enveloppe et ancêtres, sans révéler les frères', () => {
  const doc = 'x **gras *italique* et _autre_** puis __voisin__ fin'
  const result = presentation(doc, [EditorSelection.cursor(doc.indexOf('italique') + 2)])
  expect(result.revealed).toEqual(['**', '*', '*', '**'])
  expect(result.hidden.map(range => range.text)).toEqual(['_', '_', '__', '__'])
  const outerOnly = presentation(doc, [EditorSelection.cursor(doc.indexOf('gras') + 1)])
  expect(outerOnly.revealed).toEqual(['**', '**'])
})

test('plages multiples et expression multiligne partiellement visible', () => {
  const doc = 'x **Alpha** et _Beta_ puis __Gamma\nsuite__ fin'
  const result = presentation(doc, [
    EditorSelection.cursor(doc.indexOf('Alpha')),
    EditorSelection.range(doc.indexOf('suite') + 2, doc.indexOf('suite')),
  ])
  expect(result.hidden.map(range => range.text)).toEqual(['_', '_'])
  expect(result.revealed).toEqual(['**', '**', '__', '__'])
  const visible = [{ from: doc.indexOf('Gamma'), to: doc.indexOf('suite') + 2 }]
  expect(presentation(doc, [EditorSelection.cursor(doc.length)], visible).hidden.map(range => range.text)).toEqual(['__', '__'])
})

test('plages visibles recouvrantes sans doublons', () => {
  const doc = 'x ***Alpha*** fin'
  const result = presentation(doc, [EditorSelection.cursor(doc.length)], [
    { from: 2, to: 8 }, { from: 6, to: doc.length },
  ])
  expect(result.hidden).toHaveLength(4)
  expect(result.compact).toBe('x Alpha fin')
})
