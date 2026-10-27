import { EditorSelection, findClusterBreak } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import type { DecorationSet, EditorView, MouseSelectionStyle } from '@codemirror/view'

interface Marker {
  from: number
  to: number
}

interface Point {
  pos: number
  assoc: -1 | 1
}

/** Utilise les catégories et graphèmes natifs, avec les seuls marqueurs masqués comme bornes. */
function emphasisWordRange(state: EditorState, point: Point, markers: readonly Marker[]) {
  const line = state.doc.lineAt(point.pos)
  if (!line.length) return EditorSelection.cursor(point.pos)
  const offset = point.pos - line.from
  const before = offset === line.length || (offset > 0 && point.assoc < 0)
  let from = before ? findClusterBreak(line.text, offset, false) : offset
  let to = before ? offset : findClusterBreak(line.text, offset)
  const category = state.charCategorizer(point.pos)
  const selectedCategory = category(line.text.slice(from, to))
  // Une ponctuation ou un underscore ordinaire garde sa catégorie CodeMirror.
  // Seules les bornes des remplacements syntaxiques coupent le groupe de caractères.
  const boundary = (start: number, end: number) => markers.some(marker =>
    start + line.from < marker.to && end + line.from > marker.from)
  while (from > 0) {
    const previous = findClusterBreak(line.text, from, false)
    if (boundary(previous, from) || category(line.text.slice(previous, from)) !== selectedCategory) break
    from = previous
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to)
    if (boundary(to, next) || category(line.text.slice(to, next)) !== selectedCategory) break
    to = next
  }
  return EditorSelection.undirectionalRange(line.from + from, line.from + to)
}

/** Borne les groupes du double clic aux seuls marqueurs masqués, dans le cycle souris natif. */
export function emphasisMouseSelection(
  view: EditorView,
  event: MouseEvent,
  decorations: DecorationSet,
): MouseSelectionStyle | null {
  if (event.button !== 0 || event.detail !== 2 || event.shiftKey || event.altKey ||
      event.ctrlKey || event.metaKey || view.state.selection.ranges.length !== 1 ||
      view.compositionStarted) return null
  let markers: Marker[] = []
  decorations.between(0, view.state.doc.length, (from, to, decoration) => {
    if (decoration.spec.emphasisMarker) markers.push({ from, to })
  })
  if (!markers.length) return null
  const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false)
  // Même si le mot initial est hors emphase, le glisser peut rencontrer une
  // paire compacte. Les autres groupes gardent leurs catégories et graphèmes natifs.
  return {
    get(currentEvent) {
      // Le point initial est documentaire ; aucun recalcul après une révélation.
      const current = currentEvent === event ? start
        : view.posAndSideAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }, false)
      const first = emphasisWordRange(view.state, start, markers)
      let range = currentEvent === event ? first : emphasisWordRange(view.state, current, markers)
      if (current.pos !== start.pos) {
        const from = Math.min(first.from, range.from)
        const to = Math.max(first.to, range.to)
        range = from < range.from ? EditorSelection.range(from, to, range.assoc)
          : EditorSelection.range(to, from, range.assoc)
      }
      return EditorSelection.create([range])
    },
    update(update) {
      if (!update.docChanged) return
      start.pos = update.changes.mapPos(start.pos)
      markers = markers.map(marker => ({
        from: update.changes.mapPos(marker.from, 1),
        to: update.changes.mapPos(marker.to, -1),
      })).filter(marker => marker.from < marker.to)
    },
  }
}
