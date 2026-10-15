import { Prec, StateEffect } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { parseTemporalReference } from './temporalReference'

interface Reference {
  from: number
  to: number
  label: string
}

const composition = StateEffect.define<boolean>()
const reveal = StateEffect.define<number>()

/** Affiche du texte seulement ; aucun lien navigateur ni commande lecteur. */
class ReferenceWidget extends WidgetType {
  constructor(readonly label: string) { super() }

  eq(other: ReferenceWidget) { return this.label === other.label }

  toDOM() {
    const element = document.createElement('span')
    element.className = 'cm-temporal-reference'
    element.setAttribute('role', 'button')
    element.setAttribute('aria-label', 'Modifier la référence temporelle : ' + this.label)
    element.title = 'Cliquer pour modifier le Markdown ; les flèches permettent aussi d’entrer dans la référence.'
    const icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '◷'
    element.append(icon, document.createTextNode(this.label))
    return element
  }

  ignoreEvent() { return false }
}

/** Détecte les liens simples visibles, en respectant les en-têtes littéraux de Sillage. */
function references(view: EditorView): Reference[] {
  const document = view.state.doc
  const result = new Map<number, Reference>()
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(cursor) {
        if (['Image', 'InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag'].includes(cursor.name)) return false
        if (cursor.name !== 'Link') return
        const node = cursor.node
        if (document.lineAt(node.from).number !== document.lineAt(node.to).number) return false
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.name !== 'Blockquote') continue
          let content = parent.firstChild
          while (content?.name === 'QuoteMark') content = content.nextSibling
          if (!content || document.lineAt(content.from).number !== document.lineAt(parent.from).number) continue
          const line = document.lineAt(content.from)
          const header = document.sliceString(content.from, line.to)
          // Même invalides ou imbriqués, ces en-têtes restent littéraux en Lecture.
          // Le corps reste éligible ; un lien traversant l'en-tête est déjà exclu par sa ligne.
          if (node.from <= line.to && /^\[!quote(?=\]|[ \t(]|$)|^\[!quote:tr(?=\]|[ \t(]|$)/.test(header)) return false
        }
        // Les titres de lien, échappements, entités et libellés enrichis restent en source.
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (!['LinkMark', 'URL'].includes(child.name)) return false
        }
        const match = /^\[([^\[\]\\\r\n]+)\]\((sillage:\/\/[^()\r\n]+)\)$/.exec(document.sliceString(node.from, node.to))
        if (match && match[1].trim() && parseTemporalReference(match[2])) {
          result.set(node.from, { from: node.from, to: node.to, label: match[1] })
        }
        return false
      },
    })
  }
  return [...result.values()]
}

/** Révèle aussi les références entièrement englobées par une sélection traversante. */
function selected(view: EditorView, reference: Reference): boolean {
  return view.state.selection.ranges.some(range => range.empty
    ? range.from > reference.from && range.from < reference.to
    : range.from < reference.to && range.to > reference.from)
}

const compactReferences = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  compact: Reference[] = []
  composing = false
  revealedFrom: number | null = null
  timer: ReturnType<typeof setTimeout> | undefined

  constructor(view: EditorView) { this.refresh(view) }

  refresh(view: EditorView) {
    this.compact = this.composing || view.composing ? [] : references(view).filter(reference =>
      reference.from !== this.revealedFrom && !selected(view, reference))
    this.decorations = Decoration.set(this.compact.map(reference =>
      Decoration.replace({ widget: new ReferenceWidget(reference.label) }).range(reference.from, reference.to)), true)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.revealedFrom = null
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(composition)) this.composing = effect.value
        if (effect.is(reveal)) this.revealedFrom = effect.value
      }
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        update.transactions.some(transaction => transaction.effects.some(effect => effect.is(composition) || effect.is(reveal))) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) this.refresh(update.view)
  }

  destroy() { clearTimeout(this.timer) }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element)) return false
      const widget = event.target.closest('.cm-temporal-reference')
      if (!widget) return false
      const position = view.posAtDOM(widget)
      const reference = this.compact.find(candidate => candidate.from === position)
      if (!reference) return false
      event.preventDefault()
      view.dispatch({ selection: { anchor: reference.from + 1 }, userEvent: 'select.pointer' })
      view.focus()
      return true
    },
    compositionstart(_event, view) {
      clearTimeout(this.timer)
      view.dispatch({ effects: composition.of(true) })
    },
    compositionend(_event, view) {
      // Attendre la dernière mise à jour native de composition avant de masquer à nouveau.
      this.timer = setTimeout(() => view.dispatch({ effects: composition.of(false) }), 0)
    },
  },
})

/** Entre dans la source sans effacer de caractère caché, même pour les références adjacentes. */
function revealBoundary(view: EditorView, backwards: boolean, deletion = false): boolean {
  if (view.composing || view.state.selection.ranges.length !== 1) return false
  const selection = view.state.selection.main
  if (!selection.empty) return false
  const reference = view.plugin(compactReferences)?.compact.find(candidate =>
    (backwards ? candidate.to : candidate.from) === selection.head)
  if (!reference) return false
  if (deletion) {
    // Conserver la frontière : le second appui effacera le vrai caractère adjacent.
    view.dispatch({ effects: reveal.of(reference.from), userEvent: 'select' })
    return true
  }
  view.dispatch({
    selection: { anchor: backwards ? reference.to - 1 : reference.from + 1 },
    userEvent: 'select',
  })
  return true
}

/** Compacte uniquement les liens temporels directs ; aucune modification du Markdown ni navigation vidéo. */
export const compactTemporalReferences = [
  compactReferences,
  Prec.highest(keymap.of([
    { key: 'ArrowLeft', run: view => revealBoundary(view, true) },
    { key: 'ArrowRight', run: view => revealBoundary(view, false) },
    { key: 'Backspace', run: view => revealBoundary(view, true, true) },
    { key: 'Delete', run: view => revealBoundary(view, false, true) },
    { key: 'Mod-Backspace', run: view => revealBoundary(view, true, true) },
    { key: 'Mod-Delete', run: view => revealBoundary(view, false, true) },
  ])),
]
