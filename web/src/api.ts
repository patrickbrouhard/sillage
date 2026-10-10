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
export async function listVideos(signal: AbortSignal, tagID?: string): Promise<Video[]> {
  const query = tagID === undefined ? '' : '?' + new URLSearchParams({ tag_id: tagID })
  const response = await fetch('/api/v1/videos' + query, { signal })
  if (!response.ok) {
    if (response.status === 400) {
      throw await responseError(
        response,
        'Le filtre est invalide.',
        'Le filtre de tag est invalide. Retirez-le pour retrouver la bibliothèque.',
      )
    }
    throw new Error('Impossible de charger la bibliothèque. Réessayez dans un instant.')
  }
  const body: { videos: Video[] } = await response.json()
  if (!Array.isArray(body.videos)) {
    throw new Error('La réponse du serveur est invalide.')
  }
  return body.videos
}

/** Erreur REST identifiée par un code stable, sans dépendre du message du serveur. */
export class APIError extends Error {
  readonly code: string

  /** Conserve le code métier et un message français adapté au parcours. */
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Traduit les codes connus et garde un repli pour les réponses non JSON des proxies. */
async function responseError(
  response: Response,
  fallback: string,
  invalidInput: string,
  tooLarge = 'L’URL saisie est trop longue.',
): Promise<APIError> {
  const body = await response.json().catch(() => null)
  const code = typeof body?.error?.code === 'string' ? body.error.code : ''
  const messages: Record<string, string> = {
    bad_request: invalidInput,
    video_not_found: 'Cette vidéo n’existe pas ou n’est plus disponible dans votre bibliothèque.',
    metadata_fetch_failed: 'Les informations de cette vidéo n’ont pas pu être récupérées auprès de YouTube. Réessayez plus tard.',
    metadata_fetch_timeout: 'Le délai d’acquisition est dépassé. Vous pouvez réessayer.',
    payload_too_large: tooLarge,
    internal_error: 'Le serveur a rencontré une erreur. Réessayez dans un instant.',
  }
  return new APIError(code, messages[code] ?? fallback)
}

/** Lit une représentation vidéo et signale une réponse illisible sans détail technique. */
async function readVideo(response: Response): Promise<Video> {
  const video: Video | null = await response.json().catch(() => null)
  if (
    !video ||
    !Number.isInteger(video.id) ||
    video.id <= 0 ||
    !Array.isArray(video.sources) ||
    !Array.isArray(video.tags)
  ) {
    throw new Error('La réponse du serveur est invalide.')
  }
  return video
}

/** Charge une vidéo par son ID interne, conservé sous forme textuelle dans l'URL. */
export async function getVideo(id: string, signal: AbortSignal): Promise<Video> {
  const response = await fetch(`/api/v1/videos/${encodeURIComponent(id)}`, { signal })
  if (!response.ok) {
    throw await responseError(
      response,
      'Impossible de charger cette vidéo.',
      'L’identifiant vidéo est invalide.',
    )
  }
  return readVideo(response)
}

/** Lance un POST unique ; le statut distingue création et réutilisation sans refresh. */
export async function addVideo(
  url: string,
  signal: AbortSignal,
): Promise<{ video: Video; created: boolean }> {
  const response = await fetch('/api/v1/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!response.ok) {
    throw await responseError(
      response,
      'Impossible d’ajouter cette vidéo.',
      'Vérifiez l’URL : une adresse de vidéo YouTube est attendue.',
    )
  }
  return { video: await readVideo(response), created: response.status === 201 }
}

/** Distingue les erreurs réseau des erreurs API déjà traduites, sans relance automatique. */
export function errorMessage(
  error: unknown,
  networkMessage = 'Le serveur est inaccessible. Vérifiez la connexion puis réessayez.',
): string {
  return error instanceof TypeError
    ? networkMessage
    : error instanceof Error ? error.message : 'Une erreur est survenue.'
}

/** Valide l'enveloppe commune du catalogue et des associations retournées. */
async function readTags(response: Response): Promise<Tag[]> {
  const body = await response.json()
  if (!Array.isArray(body?.tags) || !body.tags.every((tag: Tag) =>
    tag && Number.isInteger(tag.id) && tag.id > 0 && typeof tag.name === 'string')) {
    throw new Error('La réponse des tags est invalide. Actualisez les associations.')
  }
  return body.tags
}

/** Charge le catalogue global, y compris les tags sans association vidéo. */
export async function listTags(signal: AbortSignal): Promise<Tag[]> {
  const response = await fetch('/api/v1/tags', { signal })
  if (!response.ok) {
    throw await responseError(
      response,
      'Impossible de charger le catalogue des tags.',
      'Requête de tags invalide.',
    )
  }
  return readTags(response)
}

/** Associe un nom ; le serveur décide de son identité et retourne tous les tags. */
export async function addTag(id: number, name: string, signal: AbortSignal): Promise<Tag[]> {
  const response = await fetch(`/api/v1/videos/${id}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: [name] }),
    signal,
  })
  if (!response.ok) throw await responseError(
    response,
    'Impossible d’associer ce tag.',
    'Saisissez un nom non vide de 200 caractères Unicode maximum.',
    'Le nom envoyé est trop volumineux.',
  )
  return readTags(response)
}

/** Retire uniquement l'association, même si elle a déjà disparu. */
export async function removeTag(id: number, tagID: number, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/v1/videos/${id}/tags/${tagID}`, { method: 'DELETE', signal })
  if (!response.ok) {
    throw await responseError(
      response,
      'Impossible de retirer ce tag.',
      'L’association demandée est invalide.',
    )
  }
}
