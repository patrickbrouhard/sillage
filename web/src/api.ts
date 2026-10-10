/** Tag directement associé à une vidéo, sans héritage depuis ses relations. */
export interface Tag {
  id: number
  name: string
}

/** Métadonnées d'une provenance, distinctes de l'identité de la vidéo. */
export interface VideoSource {
  id: number
  provider: string
  external_id: string | null
  canonical_url: string | null
  title: string
  description: string | null
  publisher: { id: number; name: string | null } | null
  duration_ms: number | null
  thumbnail_url: string | null
}

/** Représentation REST de la vidéo ; l'ordre des sources vient du serveur. */
export interface Video {
  id: number
  created_at: string
  sources: VideoSource[]
  tags: Tag[]
  person_ids: number[]
}

/** Lit la bibliothèque locale ; l'annulation empêche les réponses devenues inutiles. */
export async function listVideos(signal: AbortSignal): Promise<Video[]> {
  const response = await fetch('/api/v1/videos', { signal })
  if (!response.ok) {
    throw new Error('Impossible de charger la bibliothèque. Réessayez dans un instant.')
  }
  const body: { videos: Video[] } = await response.json()
  if (!Array.isArray(body.videos)) {
    throw new Error('La réponse du serveur est invalide.')
  }
  return body.videos
}
