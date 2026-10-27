import { test, expect } from '@playwright/test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'
import { markdownBlockLabel, markdownLinkDestination, transformMarkdown } from '../src/markdownTransforms'
import type { MarkdownAction } from '../src/markdownTransforms'

/** Vérifie le texte et les bornes exactes, indépendamment du DOM et du tooltip. */
function apply(text: string, from: number, to: number, action: MarkdownAction, address?: string) {
  const state = EditorState.create({ doc: text, selection: { anchor: from, head: to }, extensions: [history()] })
  const result = transformMarkdown(state, action, address)
  if ('reason' in result) throw new Error(result.reason)
  return state.update(result.transaction).state
}

for (const sample of [
  { text: 'bonjour', from: 0, to: 7, action: 'bold', expected: '**bonjour**', selected: 'bonjour' },
  { text: ' bonjour \t', from: 0, to: 10, action: 'italic', expected: ' *bonjour* \t', selected: 'bonjour' },
  { text: '**bonjour**', from: 0, to: 11, action: 'bold', expected: 'bonjour', selected: 'bonjour' },
  { text: '**bonjour**', from: 2, to: 9, action: 'bold', expected: 'bonjour', selected: 'bonjour' },
  { text: '*bonjour*', from: 0, to: 9, action: 'italic', expected: 'bonjour', selected: 'bonjour' },
  { text: '*bonjour*', from: 1, to: 8, action: 'italic', expected: 'bonjour', selected: 'bonjour' },
  { text: '**bonjour**', from: 2, to: 9, action: 'italic', expected: '**_bonjour_**', selected: 'bonjour' },
  { text: '*bonjour*', from: 0, to: 9, action: 'bold', expected: '__*bonjour*__', selected: '*bonjour*' },
  { text: 'un `backtick', from: 0, to: 12, action: 'code', expected: '``un `backtick``', selected: 'un `backtick' },
  { text: '`début', from: 0, to: 6, action: 'code', expected: '`` `début ``', selected: '`début' },
  { text: '`bonjour`', from: 1, to: 8, action: 'code', expected: 'bonjour', selected: 'bonjour' },
  { text: '``un `backtick``', from: 0, to: 16, action: 'code', expected: 'un `backtick', selected: 'un `backtick' },
  { text: '  mot  ', from: 0, to: 7, action: 'code', expected: '  `mot`  ', selected: 'mot' },
  { text: '## **bonjour** ###', from: 5, to: 9, action: 0, expected: '**bonjour**', selected: 'bonj' },
  { text: '# un\n\n### deux\nfin', from: 0, to: 14, action: 2, expected: '## un\n\n## deux\nfin', selected: 'un\n\n## deux' },
  { text: 'un\ndeux', from: 0, to: 3, action: 3, expected: '### un\ndeux', selected: 'un\n' },
  { text: '## un', from: 3, to: 5, action: 2, expected: '## un', selected: 'un' },
  { text: '[label] text', from: 0, to: 7, action: 'link', address: 'https://example.org/a(b) c?q="x"&k=1', expected: '[\\[label\\]](<https://example.org/a(b)%20c?q=%22x%22&amp;k=1>) text', selected: '\\[label\\]' },
] as { text: string; from: number; to: number; action: MarkdownAction; address?: string; expected: string; selected: string }[]) {
  for (const reversed of [false, true]) {
    test('transformation ' + JSON.stringify(sample) + ' inversée=' + reversed, () => {
      const state = apply(sample.text, reversed ? sample.to : sample.from, reversed ? sample.from : sample.to, sample.action, sample.address)
      expect(state.sliceDoc()).toBe(sample.expected)
      const selection = state.selection.main
      expect(state.sliceDoc(selection.from, selection.to)).toBe(sample.selected)
      expect(selection.anchor > selection.head).toBe(reversed)
    })
  }
}

for (const sample of [
  { text: ' \t ', action: 'bold' },
  { text: 'un\ndeux', action: 'italic' },
  { text: '**bonjour**', action: 'bold', from: 3, to: 7 },
  { text: 'avant *texte* après', action: 'bold', from: 0, to: 10 },
  { text: '[texte](https://example.org)', action: 'link', from: 1, to: 6 },
  { text: '[temps](sillage://videos/1/sources/2?start_ms=0)', action: 'bold', from: 1, to: 6 },
  { text: '[temps](sillage://videos/1/sources/2?start_ms=0)', action: 'code', from: 12, to: 20 },
  { text: '```\ntexte\n```', action: 1 },
  { text: '    code', action: 2 },
  { text: '- liste', action: 1 },
  { text: '> citation', action: 1 },
  { text: '> [!quote] auteur', action: 'bold' },
  { text: 'titre\n===', action: 2 },
  { text: 'titre\n---', action: 0, from: 0, to: 5 },
  { text: '| un | deux |\n| --- | --- |', action: 1 },
  { text: '| un | deux |\n| --- | --- |', action: 'bold', from: 2, to: 4 },
  { text: '[ref]: https://example.org', action: 1 },
  { text: '<div>\ntexte\n</div>', action: 2 },
  { text: '# - liste', action: 0 },
  { text: '# > citation', action: 0 },
  { text: '# <div>', action: 0 },
  { text: '# [ref]: /url', action: 0 },
  { text: '# titre\n---', action: 0, from: 0, to: 7 },
  { text: 'simple\n\n- liste', action: 2 },
  { text: 'mot', action: 'link', address: 'javascript:alert(1)' },
] as { text: string; action: MarkdownAction; from?: number; to?: number; address?: string }[]) {
  test('refus ' + JSON.stringify(sample), () => {
    const state = EditorState.create({ doc: sample.text, selection: { anchor: sample.from ?? 0, head: sample.to ?? sample.text.length } })
    const result = transformMarkdown(state, sample.action, sample.address)
    expect(result).toHaveProperty('reason')
    expect(state.sliceDoc()).toBe(sample.text)
  })
}

test('titres temporels et niveaux mixtes sans altération du lien', () => {
  const link = '[temps](sillage://videos/1/sources/2?start_ms=0)'
  const state = apply(link, 1, 4, 2)
  expect(state.sliceDoc()).toBe('## ' + link)
  expect(markdownBlockLabel(state)).toBe('H2')
  expect(markdownBlockLabel(EditorState.create({ doc: '# un\n## deux', selection: { anchor: 0, head: 12 } }))).toBe('Mixte')
})

test('aucune transformation silencieuse d’une sélection multiple', () => {
  const state = EditorState.create({
    doc: 'un deux',
    selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 7)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  expect(transformMarkdown(state, 'bold')).toHaveProperty('reason')
})

test('une commande sépare les saisies voisines dans l’historique', () => {
  let state = EditorState.create({ doc: 'mot', extensions: [history()] })
  state = state.update({ changes: { from: 3, insert: 's' }, userEvent: 'input.type' }).state
  state = state.update({ selection: { anchor: 0, head: 4 } }).state
  const change = transformMarkdown(state, 'bold')
  if ('reason' in change) throw new Error(change.reason)
  state = state.update(change.transaction).state
  state = state.update({ changes: { from: state.doc.length, insert: '!' }, userEvent: 'input.type' }).state
  expect(undoDepth(state)).toBe(3)
})

test('politique des destinations sans réseau', () => {
  for (const value of ['https://example.org', 'http://example.org', '/videos/42', '#ancre', 'mailto:a@example.org']) {
    expect(markdownLinkDestination(value)).toEqual({ destination: value })
  }
  for (const value of ['', 'javascript:x', 'data:text/html,x', 'sillage://videos/1/sources/2?start_ms=0', 'https://a\nb']) {
    expect(markdownLinkDestination(value)).toHaveProperty('reason')
  }
})


test('les entités dans une destination restent des caractères de son URL', () => {
  const state = apply('mot', 0, 3, 'link', 'https://example.org/?q=&copy;&x=1')
  expect(state.sliceDoc()).toBe('[mot](<https://example.org/?q=&amp;copy;&amp;x=1>)')
})

test('code littéral avec plusieurs enveloppes et padding existant', () => {
  expect(apply('`un` et `deux`', 0, 14, 'code').sliceDoc()).toBe('`` `un` et `deux` ``')
  const state = apply('` texte `', 0, 9, 'code')
  expect(state.sliceDoc()).toBe('texte')
  expect(state.selection.main.from).toBe(0)
  expect(state.selection.main.to).toBe(5)
})

test('aucune restructuration inline de préfixes et aucun Undo pour un niveau identique', () => {
  const state = EditorState.create({ doc: '- liste', selection: { anchor: 0, head: 7 } })
  expect(transformMarkdown(state, 'bold')).toHaveProperty('reason')
  const same = apply('## titre ###', 3, 8, 2)
  expect(same.sliceDoc()).toBe('## titre ###')
  expect(undoDepth(same)).toBe(0)
})

test('indentation ATX et sélection interne conservent le contenu utile', () => {
  const heading = apply('   titre', 3, 8, 2)
  expect(heading.sliceDoc()).toBe('   ## titre')
  expect(heading.sliceDoc(heading.selection.main.from, heading.selection.main.to)).toBe('titre')
  const paragraph = apply('   ## titre ###', 6, 11, 0)
  expect(paragraph.sliceDoc()).toBe('   titre')
  expect(paragraph.sliceDoc(paragraph.selection.main.from, paragraph.selection.main.to)).toBe('titre')
})

test('refus des délimiteurs échappés ou d’un retrait révélant une liste', () => {
  const escaped = EditorState.create({ doc: String.raw`avant \mot`, selection: { anchor: 7, head: 10 } })
  expect(transformMarkdown(escaped, 'bold')).toHaveProperty('reason')
  const code = EditorState.create({ doc: '`- liste`', selection: { anchor: 0, head: 9 } })
  expect(transformMarkdown(code, 'code')).toHaveProperty('reason')
})
