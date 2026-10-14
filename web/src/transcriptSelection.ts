import type { TranscriptItem } from './transcriptApi'
import { temporalReference } from './temporalReference'

/** Extrait autonome lié au premier fragment contenant un caractère retenu. */
export interface TranscriptExcerpt {
  text: string
  startMs: number
}

/** Extrait sans ajouter de blancs entre fragments ni interpoler leurs timestamps. */
export function extractTranscript(
  items: TranscriptItem[],
  start: number,
  end: number,
): TranscriptExcerpt | null {
  const text = items.map(item => item.text).join('')
  if (start < 0 || end > text.length || start >= end) return null
  const raw = text.slice(start, end)
  const leading = raw.search(/\S/u)
  if (leading < 0) return null
  const first = start + leading
  let offset = 0
  // L'ordre source prime, même si les timestamps reculent ou si des fragments sont vides.
  for (const item of items) {
    offset += item.text.length
    if (first < offset) return {
      text: raw.trim().replace(/\s+/gu, ' '),
      startMs: item.start_ms,
    }
  }
  return null
}

/** Traduit une borne DOM en offset continu, en ignorant timestamps et structure visuelle. */
function textOffset(container: HTMLElement, node: Node, position: number): number | null {
  if (!container.contains(node)) return null
  const element = node instanceof Element ? node : node.parentElement
  if (element?.closest('.transcript-time')) return null
  let offset = 0
  for (const paragraph of container.querySelectorAll('[data-transcript-text]')) {
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    if (paragraph.contains(node)) {
      range.setEnd(node, position)
      return offset + range.toString().length
    }
    if (range.comparePoint(node, position) < 0) return offset
    offset += paragraph.textContent?.length ?? 0
  }
  return offset
}

/** Accepte uniquement une plage native continue entièrement contenue dans la transcription. */
export function selectedTranscript(
  container: HTMLElement,
  items: TranscriptItem[],
): TranscriptExcerpt | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = textOffset(container, range.startContainer, range.startOffset)
  const end = textOffset(container, range.endContainer, range.endOffset)
  return start === null || end === null ? null : extractTranscript(items, start, end)
}

/** Protège la ponctuation Markdown, le HTML et les entités sans modifier le libellé cité. */
export function transcriptCitation(excerpt: TranscriptExcerpt, videoID: number, sourceID: number): string {
  const escaped = excerpt.text.replace(/[!-/:-@\[-\x60{-~]/g, '\\$&')
  return '> ' + escaped + '\n\n— ' + temporalReference(videoID, sourceID, excerpt.startMs)
}
