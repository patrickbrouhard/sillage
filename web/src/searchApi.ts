import type { Video } from './api'

/** Un segment est du texte littéral avec une indication de surlignage. */
export interface SearchSegment { text: string; highlight: boolean }
/** Les champs indiquent une contribution partielle, indépendante pour chaque source. */
export interface SourceMatch { source_id: number; title: boolean; description: boolean; publisher: boolean }
/** La vidéo et ses explications sont issues du même instantané de lecture. */
export interface SearchResult { video: Video; note_excerpt: SearchSegment[]; source_matches: SourceMatch[] }
/** Une page ne promet ni total ni instantané entre requêtes. */
export interface SearchPage { results: SearchResult[]; page: number; has_more: boolean }

/** Charge uniquement une requête soumise ; le serveur valide aussi les paramètres répétés. */
export async function searchVideos(params: string, signal: AbortSignal): Promise<SearchPage> {
  const response = await fetch('/api/v1/search?' + params, { signal })
  if (!response.ok) throw new Error(response.status === 400
    ? 'Recherche invalide : 1 024 octets, 32 termes et pages de 1 à 1 000 maximum.'
    : 'La recherche n’a pas pu aboutir. Réessayez.')
  const body = await response.json() as SearchPage
  if (!Array.isArray(body.results) || !Number.isInteger(body.page) || typeof body.has_more !== 'boolean') {
    throw new Error('La réponse de recherche est invalide.')
  }
  return body
}
