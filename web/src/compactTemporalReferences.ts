import { Facet, Prec, StateEffect } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { parseCalloutHeader } from './calloutHeader'
import { formatDuration } from './videoPresentation'
import type { TemporalReference } from './temporalReference'
import { parseTemporalReference } from './temporalReference'

interface Reference {
  from: number
  to: number
  label: string
  target: TemporalReference
}

const navigation = Facet.define<(reference: TemporalReference) => void>()

const composition = StateEffect.define<boolean>()
const reveal = StateEffect.define<number>()

/** Affiche du texte seulement ; aucun lien navigateur ; les actions passent par le callback partagé. */
class ReferenceWidget extends WidgetType {
  constructor(readonly label: string) { super() }

  eq(other: ReferenceWidget) { return this.label === other.label }

  toDOM() {
    const element = document.createElement('span')
    element.className = 'cm-temporal-reference'
    element.setAttribute('role', 'button')
    element.setAttribute('aria-label', 'Modifier la référence temporelle : ' + this.label)
    element.title = 'Cliquer pour modifier le Markdown ; Ctrl+clic (Cmd sur Mac) ou Ctrl/Cmd+Entrée dans la source pour naviguer.'
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
        if (cursor.name === 'Blockquote') {
          const quote = cursor.node
          let nested = false
          for (let parent = quote.parent; parent; parent = parent.parent) {
            if (parent.name === 'Blockquote') nested = true
          }
          let content = quote.firstChild
          while (content?.name === 'QuoteMark') content = content.nextSibling
          const line = document.lineAt(quote.from)
          if (!nested && content && document.lineAt(content.from).number === line.number &&
              !['CodeBlock', 'FencedCode', 'HTMLBlock', 'Blockquote'].includes(content.name)) {
            const header = parseCalloutHeader(document.sliceString(content.from, line.to))
            if (header?.kind === 'quote:tr') {
              const target = parseTemporalReference(header.uri)!
              const from = content.from + '[!quote:tr]('.length
              result.set(from, { from, to: from + header.uri.length, label: formatDuration(target.startMs), target })
            }
          }
        }
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
          result.set(node.from, { from: node.from, to: node.to, label: match[1], target: parseTemporalReference(match[2])! })
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

  pointerInside = false
  modified = false

  constructor(readonly view: EditorView) {
    this.refresh(view)
    // Écouter la fenêtre couvre aussi un modificateur pressé sans focus dans l'éditeur.
    window.addEventListener('keydown', this.modifierChanged)
    window.addEventListener('keyup', this.modifierChanged)
    window.addEventListener('blur', this.clearModifier)
  }

  /** Ne change que la classe DOM : ni transaction ni sélection CodeMirror. */
  updateCursor() {
    this.view.dom.classList.toggle('cm-temporal-navigation',
      this.pointerInside && this.modified && !this.composing && !this.view.composing)
  }

  modifierChanged = (event: KeyboardEvent | MouseEvent) => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    this.modified = (mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey
    this.updateCursor()
  }

  clearModifier = () => {
    this.modified = false
    this.updateCursor()
  }

  refresh(view: EditorView) {
    const recognized = references(view)
    this.compact = this.composing || view.composing ? [] : recognized.filter(reference =>
      reference.from !== this.revealedFrom && !selected(view, reference))
    const compactStarts = new Set(this.compact.map(reference => reference.from))
    this.decorations = Decoration.set([
      ...this.compact.map(reference =>
        Decoration.replace({ widget: new ReferenceWidget(reference.label) }).range(reference.from, reference.to)),
      // Les plages révélées partagent exactement la reconnaissance utilisée pour l'activation.
      ...recognized.filter(reference => !compactStarts.has(reference.from)).map(reference =>
        Decoration.mark({ class: 'cm-temporal-source' }).range(reference.from, reference.to)),
    ], true)
    this.updateCursor()
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

  destroy() {
    clearTimeout(this.timer)
    window.removeEventListener('keydown', this.modifierChanged)
    window.removeEventListener('keyup', this.modifierChanged)
    window.removeEventListener('blur', this.clearModifier)
    this.view.dom.classList.remove('cm-temporal-navigation')
  }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    mouseenter(event) {
      this.pointerInside = true
      this.modifierChanged(event)
    },
    mousemove(event) {
      this.pointerInside = true
      this.modifierChanged(event)
    },
    mouseleave() {
      this.pointerInside = false
      this.clearModifier()
    },
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || event.altKey || !(event.target instanceof Element)) return false
      if (view.composing || this.composing) return false
      const widget = event.target.closest('.cm-temporal-reference')
      const position = widget ? view.posAtDOM(widget) : view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (position === null) return false
      const mac = /Mac|iPhone|iPad/.test(navigator.platform)
      const modified = mac ? event.metaKey : event.ctrlKey
      const reference = (modified ? references(view) : this.compact).find(candidate =>
        widget ? candidate.from === position : position >= candidate.from && position < candidate.to)
      if (!reference || (!modified && !widget)) return false
      event.preventDefault()
      if (modified) {
        // Intercepter avant la sélection native ; aucun dispatch ni focus ne perturbe le curseur.
        view.state.facet(navigation)[0]?.(reference.target)
        return true
      }
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

/** Compacte les références et délègue leur activation, sans modifier le Markdown. */
export function compactTemporalReferences(onNavigate: (reference: TemporalReference) => void) {
  return [
    navigation.of(onNavigate),
    compactReferences,
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: view => {
        if (view.composing || view.state.selection.ranges.length !== 1) return false
        const selection = view.state.selection.main
        if (!selection.empty) return false
        const reference = references(view).find(candidate => selection.head > candidate.from && selection.head < candidate.to)
        if (!reference) return false
        view.state.facet(navigation)[0]?.(reference.target)
        return true
      } },
      { key: 'ArrowLeft', run: view => revealBoundary(view, true) },
      { key: 'ArrowRight', run: view => revealBoundary(view, false) },
      { key: 'Backspace', run: view => revealBoundary(view, true, true) },
      { key: 'Delete', run: view => revealBoundary(view, false, true) },
      { key: 'Mod-Backspace', run: view => revealBoundary(view, true, true) },
      { key: 'Mod-Delete', run: view => revealBoundary(view, false, true) },
    ])),
  ]
}
