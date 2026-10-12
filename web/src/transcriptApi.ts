/** Fragment normalisé par le serveur ; ses espaces et son ordre sont significatifs. */
export interface TranscriptItem {
  start_ms: number
  text: string
}

/** Dernière acquisition originale de la source identifiée dans l'URL REST. */
export interface Transcript {
  language: string
  provenance: string
  last_fetched_at: string
  items: TranscriptItem[]
}

/** Erreur de transcription ; uncertain autorise une relecture, jamais un POST automatique. */
export class TranscriptError extends Error {
  /** Conserve uniquement le diagnostic utile à la présentation et à la reprise. */
  constructor(message: string, readonly code = '', readonly uncertain = false) { super(message) }
}

/** Valide les fragments avant leur présentation sans les normaliser ni les trier. */
async function readTranscript(response: Response): Promise<Transcript> {
  const value = await response.json().catch(() => null)
  if (!value || typeof value.language !== 'string' || value.provenance !== 'youtube_auto' ||
      typeof value.last_fetched_at !== 'string' || !Number.isFinite(Date.parse(value.last_fetched_at)) ||
      !Array.isArray(value.items) || !value.items.length ||
      !value.items.every((item: TranscriptItem) => item && Number.isSafeInteger(item.start_ms) &&
        item.start_ms >= 0 && typeof item.text === 'string') ||
      !value.items.some((item: TranscriptItem) => item.text.trim())) {
    throw new TranscriptError('La réponse de transcription est illisible.', '', true)
  }
  return value
}

/** Lit ou acquiert avec des délais propres à la transcription, sans reprise distante implicite. */
async function requestTranscript(
  videoID: number,
  sourceID: number,
  method: 'GET' | 'POST',
  signal: AbortSignal,
): Promise<Transcript | null> {
  const acquiring = method === 'POST'
  try {
    const response = await fetch(`/api/v1/videos/${videoID}/sources/${sourceID}/transcript`, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(acquiring ? 90_000 : 12_000)]),
      cache: 'no-store',
    })
    if (response.ok) return await readTranscript(response)
    const body = await response.json().catch(() => null)
    const code = typeof body?.error?.code === 'string' ? body.error.code : ''
    if (!acquiring && response.status === 404 && code === 'transcript_not_found') return null
    const messages: Record<string, string> = {
      transcript_not_available: 'Aucune transcription automatique originale n’a pu être sélectionnée.',
      transcript_selection_ambiguous: 'Plusieurs transcriptions automatiques originales sont disponibles, mais Sillage ne peut pas encore choisir entre elles.',
      transcript_fetch_failed: 'La transcription n’a pas pu être récupérée auprès de YouTube.',
      transcript_fetch_timeout: 'Le délai de récupération de la transcription est dépassé.',
      video_not_found: 'Cette vidéo n’est plus disponible dans la bibliothèque.',
      video_source_not_found: 'Cette source n’est plus disponible pour cette vidéo.',
      internal_error: acquiring
        ? 'Une erreur interne a empêché l’acquisition de la transcription.'
        : 'Impossible de lire la transcription locale. Réessayez la lecture.',
    }
    throw new TranscriptError(messages[code] ?? (acquiring
      ? 'L’acquisition n’a pas été confirmée par le serveur.'
      : 'Impossible de lire la transcription locale.'), code, acquiring && !messages[code])
  } catch (error) {
    if (signal.aborted || error instanceof TranscriptError) throw error
    const timeout = error instanceof DOMException && error.name === 'TimeoutError'
    throw new TranscriptError(timeout
      ? 'Le délai d’attente de la transcription est dépassé.'
      : 'Le serveur est inaccessible. Vérifiez la connexion puis réessayez.', '', acquiring)
  }
}

/** Consulte exclusivement la dernière acquisition locale de cette source. */
export function getTranscript(videoID: number, sourceID: number, signal: AbortSignal) {
  return requestTranscript(videoID, sourceID, 'GET', signal)
}

/** Déclenche une acquisition unique, sans corps et sans réessai automatique. */
export function fetchTranscript(videoID: number, sourceID: number, signal: AbortSignal) {
  return requestTranscript(videoID, sourceID, 'POST', signal)
}
