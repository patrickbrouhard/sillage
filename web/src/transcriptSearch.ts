import type { TranscriptBlock } from './transcriptPresentation'

/** Intervalle UTF-16 dans le texte original, compatible avec slice et le DOM. */
export interface TranscriptMatch {
  start: number
  end: number
}

/** Recherche Unicode sans casse : les blancs sont équivalents, les accents conservés. */
export function findTranscriptMatches(text: string, query: string): TranscriptMatch[] {
  if (!query) return []
  // Échapper la saisie conserve une recherche littérale et les indices du texte source.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Rechercher les blancs dans le texte original conserve les indices malgré leur longueur.
  const expression = new RegExp(escaped.replace(/\s+/g, '\\s+'), 'giu')
  return Array.from(text.matchAll(expression), match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/** Portion exacte d'un bloc ; une occurrence peut posséder plusieurs portions. */
export interface TranscriptPart {
  text: string
  matchIndex?: number
}

/** Projette les occurrences continues sur les blocs sans ajouter de séparateur. */
export function highlightTranscript(
  blocks: TranscriptBlock[],
  matches: TranscriptMatch[],
): TranscriptPart[][] {
  let offset = 0
  let matchIndex = 0
  return blocks.map(block => {
    const parts: TranscriptPart[] = []
    const end = offset + block.text.length
    let cursor = offset
    // Garder l'occurrence courante lorsqu'elle continue dans le bloc suivant.
    while (matchIndex < matches.length && matches[matchIndex].start < end) {
      const match = matches[matchIndex]
      const start = Math.max(cursor, match.start)
      if (start > cursor) parts.push({ text: block.text.slice(cursor - offset, start - offset) })
      const stop = Math.min(end, match.end)
      parts.push({ text: block.text.slice(start - offset, stop - offset), matchIndex })
      cursor = stop
      if (match.end > end) break
      matchIndex++
    }
    if (cursor < end) parts.push({ text: block.text.slice(cursor - offset) })
    offset = end
    return parts
  })
}
