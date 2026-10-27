import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

/** Masque seulement les paires d'emphase reconnues, hors zones littérales et libellés de liens/images. */
export function emphasisDecorations(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<number>()
  const headers = new Map<number, number>()
  for (const visible of visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(cursor) {
        // Les libellés enrichis restent en source, notamment pour conserver les
        // règles existantes de reconnaissance et de navigation des liens temporels.
        if (['InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'Link', 'Image'].includes(cursor.name)) return false
        if (cursor.name === 'Blockquote') {
          let content = cursor.node.firstChild
          while (content?.name === 'QuoteMark') content = content.nextSibling
          const line = state.doc.lineAt(cursor.from)
          if (content && state.doc.lineAt(content.from).number === line.number &&
              !['CodeBlock', 'FencedCode', 'HTMLBlock', 'Blockquote'].includes(content.name)) {
            const literal = state.sliceDoc(content.from, line.to)
            // Les déclarations connues invalides ou imbriquées sont aussi littérales
            // en Lecture. Une expression traversant cet en-tête reste entièrement source.
            if (/^\[!quote(?=\]|[ \t(]|$)|^\[!quote:tr(?=\]|[ \t(]|$)/.test(literal)) {
              headers.set(line.from, line.to)
            }
          }
        }
        if (!['Emphasis', 'StrongEmphasis'].includes(cursor.name)) return
        if ([...headers].some(([from, to]) => cursor.from < to && cursor.to > from)) return false
        if (seen.has(cursor.from)) return
        seen.add(cursor.from)

        const opening = cursor.node.firstChild
        const closing = cursor.node.lastChild
        if (opening?.name !== 'EmphasisMark' || closing?.name !== 'EmphasisMark' || opening.to > closing.from) return
        // Le curseur inclut les deux frontières ; une sélection non vide utilise
        // l'intersection semi-ouverte. Les ancêtres contenant une plage se révèlent
        // naturellement avec elle, sans révéler les expressions voisines.
        const selected = state.selection.ranges.some(range => range.empty
          ? range.head >= cursor.from && range.head <= cursor.to
          : range.from < cursor.to && range.to > cursor.from)
        const marker = selected ? Decoration.mark({ class: 'cm-note-emphasis-marker' }) : Decoration.replace({ emphasisMarker: true })
        // Les blancs du contenu et tous les sauts de ligne restent hors remplacement.
        ranges.push(marker.range(opening.from, opening.to), marker.range(closing.from, closing.to))
      },
    })
  }
  return Decoration.set(ranges, true)
}
