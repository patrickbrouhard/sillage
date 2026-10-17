import { MapMode, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

interface Marker { id: string; position: number; label: string }

/** Ajoute ou retire seulement une intention visuelle, jamais du Markdown provisoire. */
export const setCaptureMarker = StateEffect.define<Marker | null>()

class CaptureWidget extends WidgetType {
  constructor(private readonly label: string) { super() }
  eq(other: CaptureWidget) { return other.label === this.label }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'capture-marker'
    span.setAttribute('role', 'status')
    span.textContent = this.label
    return span
  }
}

/** Suit les modifications, Undo compris ; un ancrage supprimé ne ressuscite pas. */
export const captureMarker = StateField.define<Marker | null>({
  create: () => null,
  update(marker, transaction) {
    if (marker) {
      const position = transaction.changes.mapPos(marker.position, -1, MapMode.TrackDel)
      marker = position === null ? null : { ...marker, position }
    }
    for (const effect of transaction.effects) {
      if (effect.is(setCaptureMarker)) marker = effect.value
    }
    return marker
  },
  provide: field => EditorView.decorations.from(field, marker => marker
    ? Decoration.set([Decoration.widget({ widget: new CaptureWidget(marker.label), side: -1 }).range(marker.position)])
    : Decoration.none),
})

/** Exclut les changements visuels de l'historique documentaire. */
export const captureVisualTransaction = Transaction.addToHistory.of(false)
