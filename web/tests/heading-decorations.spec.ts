import { test, expect } from '@playwright/test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { headingDecorations } from '../src/livePreviewHeadings'

/** Observe les plages sources masquées et les classes, indépendamment de la géométrie DOM. */
function presentation(text: string, selections = [EditorSelection.cursor(text.length)]) {
  const state = EditorState.create({
    doc: text,
    selection: EditorSelection.create(selections),
    extensions: [markdown(), EditorState.allowMultipleSelections.of(true)],
  })
  ensureSyntaxTree(state, text.length, 1000)
  const hidden: { from: number; to: number; text: string }[] = []
  const headings: string[] = []
  headingDecorations(state, [{ from: 0, to: text.length }]).between(0, text.length, (from, to, value) => {
    if (value.spec.class?.startsWith('cm-note-heading cm-note-h')) headings.push(value.spec.class)
    if (!value.spec.class) hidden.push({ from, to, text: state.sliceDoc(from, to) })
  })
  return { hidden, headings }
}

for (const sample of [
  { text: '# Titre', markers: ['# '] },
  { text: '   ## \tTitre ###  ', markers: ['   ## \t', ' ###  '] },
  { text: '###### Six # texte', markers: ['###### '] },
  { text: '### Texte#', markers: ['### '] },
  { text: '## Texte ### autre', markers: ['## '] },
  { text: '## Texte \\###', markers: ['## '] },
  { text: '## Texte # #', markers: ['## ', ' #'] },
  { text: '#', markers: [] },
  { text: '## ', markers: [] },
  { text: '### ###', markers: [] },
  { text: '   #### \t####  ', markers: [] },
]) {
  test('marqueurs et clôture ' + JSON.stringify(sample.text), () => {
    const { hidden, headings } = presentation(sample.text + '\nfin')
    expect(headings).toHaveLength(1)
    expect(hidden.map(range => range.text)).toEqual(sample.markers)
    expect(hidden.every(range => range.to <= sample.text.length)).toBe(true)
  })
}

for (const text of [
  '#invalide', '####### invalide', '\\# échappé', '    # code', '\t# code',
  '\x60\x60\x60\n# code\n\x60\x60\x60', '~~~\n# code\n~~~', '\x60# inline\x60',
  '<div>\n# HTML\n</div>', '<!--\n# HTML\n-->', '<script>\n# HTML\n</script>',
  '> # citation', '> [!quote] Auteur\n> ## imbriqué', '- # liste', '- texte\n  ## imbriqué',
  'Setext\n===', 'Setext\n---',
]) {
  test('hors périmètre ' + JSON.stringify(text), () => {
    expect(presentation(text + '\n\nfin')).toEqual({ hidden: [], headings: [] })
  })
}

for (const reversed of [false, true]) {
  test('sélection traversante et dernière ligne exclue, inversée=' + reversed, () => {
    const text = 'avant\n# Un\n## Deux\n### Trois\nfin'
    const from = 2
    const to = text.indexOf('###')
    const selection = EditorSelection.range(reversed ? to : from, reversed ? from : to)
    expect(presentation(text, [selection]).hidden.map(range => range.text)).toEqual(['### '])
  })
}

test('curseur sur toute la ligne, sélection partielle et plages multiples', () => {
  const text = 'avant\n  # Un ###\n## Deux\n### Trois\nfin'
  const from = text.indexOf('  #')
  const to = text.indexOf('\n##')
  for (let position = from; position <= to; position++) {
    expect(presentation(text, [EditorSelection.cursor(position)]).hidden.map(range => range.text))
      .toEqual(['## ', '### '])
  }
  const selections = [
    EditorSelection.range(text.indexOf('Un'), text.indexOf('Un') + 1),
    EditorSelection.cursor(text.indexOf('Trois')),
  ]
  expect(presentation(text, selections).hidden.map(range => range.text)).toEqual(['## '])
})

test('une seule décoration pour des plages visibles recouvrantes et un titre replié', () => {
  const text = '# ' + 'Titre long '.repeat(100)
  const state = EditorState.create({ doc: text, extensions: [markdown()] })
  ensureSyntaxTree(state, text.length, 1000)
  const decorations = headingDecorations(state, [{ from: 30, to: 60 }, { from: 50, to: text.length }])
  expect(decorations.size).toBe(2)
})
