import { parseTemporalReference } from './temporalReference'

/** Deux en-têtes valides seulement, indépendants des arbres Remark et CodeMirror. */
export type CalloutHeader =
  | { kind: 'quote'; attribution: string }
  | { kind: 'quote:tr'; uri: string; title: string }

/** Reconnaît une ligne source littérale ; le contexte blockquote reste à la charge du lecteur. */
export function parseCalloutHeader(literal: string): CalloutHeader | null {
  const ordinary = /^\[!quote\](?:[ \t]+(.*?))?[ \t]*$/.exec(literal)
  if (ordinary) return { kind: 'quote', attribution: ordinary[1] ?? '' }
  // La première parenthèse fermante termine l'URI, même si le titre contient des parenthèses.
  const transcript = /^\[!quote:tr\]\(([^()\r\n]*)\)(?:[ \t]+(.*?))?[ \t]*$/.exec(literal)
  return transcript && parseTemporalReference(transcript[1])
    ? { kind: 'quote:tr', uri: transcript[1], title: transcript[2]?.trim() ?? '' }
    : null
}
