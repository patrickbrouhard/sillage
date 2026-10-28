import { apiFetch } from './auth'
import type { Video } from './api'

/** Un segment est du texte littéral avec une indication de surlignage. */
export interface SearchSegment { text: string; highlight: boolean }
/** Les champs indiquent une contribution partielle, indépendante pour chaque source. */
export interface SourceMatch { source_id: number; title: boolean; description: boolean; publisher: boolean }
/** La vidéo et ses explications sont issues du même instantané de lecture. */
export interface SearchResult { video: Video; note_excerpt: SearchSegment[]; source_matches: SourceMatch[] }
/** Le total et la page partagent un instantané ; deux requêtes restent indépendantes. */
export interface SearchPage { results: SearchResult[]; page: number; has_more: boolean; total: number }

/** Charge uniquement une requête soumise ; le serveur valide aussi les paramètres répétés. */
export async function searchVideos(params: string, signal: AbortSignal): Promise<SearchPage> {
  const response = await apiFetch('/api/v1/search?' + params, { signal })
  if (!response.ok) throw new Error(response.status === 400
    ? 'Recherche invalide : vérifiez les paramètres, le tri (relevance ou newest) et les limites de 1 024 octets, 32 termes et pages de 1 à 1 000.'
    : 'La recherche n’a pas pu aboutir. Réessayez.')
  const body = await response.json() as SearchPage
  if (!Array.isArray(body.results) || !Number.isInteger(body.page) || typeof body.has_more !== 'boolean' ||
      !Number.isSafeInteger(body.total) || body.total < 0) {
    throw new Error('La réponse de recherche est invalide.')
  }
  return body
}
