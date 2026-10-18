import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import { parseCalloutHeader } from './calloutHeader'

/** Décore les citations et le code visibles en conservant leur contexte syntaxique. */
function noteDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lines = new Map<number, boolean>()
  const headers = new Set<number>()
  const document = view.state.doc
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(cursor) {
        // Marquer le nœud entier conserve le monospace malgré la coloration d'un langage
        // imbriqué, et couvre aussi les clôtures, espaces et indentations du code.
        if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(cursor.name)) {
          if (cursor.to > cursor.from) {
            ranges.push(Decoration.mark({ class: 'cm-markdown-code' }).range(cursor.from, cursor.to))
          }
          return false
        }
        if (cursor.name !== 'Blockquote') return
        const quote = cursor.node
        let nested = false
        for (let parent = quote.parent; parent; parent = parent.parent) {
          if (parent.name === 'Blockquote') { nested = true; break }
        }
        // Les QuoteMark sont des délimiteurs, pas le premier contenu du bloc.
        let content = quote.firstChild
        while (content?.name === 'QuoteMark') content = content.nextSibling
        const firstLine = document.lineAt(quote.from)
        const eligible = !nested && content && document.lineAt(content.from).number === firstLine.number &&
          !['CodeBlock', 'FencedCode', 'HTMLBlock', 'Blockquote'].includes(content.name)
        const start = eligible ? content!.from : firstLine.to
        const literal = document.sliceString(start, firstLine.to)
        const header = eligible ? parseCalloutHeader(literal) : null

        // Plusieurs blocs imbriqués ou plages visibles peuvent couvrir la même ligne.
        // Une seule bordure continue suffit ; le fond du callout extérieur est conservé.
        const last = document.lineAt(Math.min(Math.max(quote.from, quote.to - 1), visible.to)).number
        for (let number = document.lineAt(Math.max(quote.from, visible.from)).number; number <= last; number++) {
          const line = document.line(number)
          lines.set(line.from, Boolean(header) || lines.get(line.from) === true)
        }
        if (!header || headers.has(start) || firstLine.to < visible.from || firstLine.from > visible.to) return
        headers.add(start)
        const markerEnd = start + (header.kind === 'quote' ? '[!quote]'.length : '[!quote:tr]'.length)
        ranges.push(Decoration.mark({ class: 'cm-callout-marker' }).range(start, markerEnd))
        let labelStart = markerEnd
        if (header.kind === 'quote:tr') {
          const uriStart = markerEnd + 1
          labelStart = uriStart + header.uri.length + 1
          ranges.push(Decoration.mark({ class: 'cm-callout-uri' }).range(uriStart, uriStart + header.uri.length))
        }
        const label = document.sliceString(labelStart, firstLine.to)
        const leading = label.match(/^[ \t]*/)![0].length
        const trailing = label.match(/[ \t]*$/)![0].length
        if (label.length > leading + trailing) {
          ranges.push(Decoration.mark({ class: 'cm-callout-label' })
            .range(labelStart + leading, firstLine.to - trailing))
        }
      },
    })
  }
  for (const [from, callout] of lines) {
    ranges.push(Decoration.line({ class: 'cm-markdown-quote' + (callout ? ' cm-markdown-callout' : '') }).range(from))
  }
  return Decoration.set(ranges, true)
}

/** Ajoute uniquement des décorations ; aucune transaction de texte, sélection ou historique. */
export const markdownDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = noteDecorations(view)
  }

  update(update: ViewUpdate) {
    // L'analyse incrémentale peut progresser sans saisie ; le viewport change aussi au retour en Édition.
    if (update.docChanged || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = noteDecorations(update.view)
    }
  }
}, { decorations: plugin => plugin.decorations })
