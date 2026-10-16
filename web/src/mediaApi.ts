/** Métadonnées publiques du fichier ; son chemin reste exclusivement côté serveur. */
export interface MediaFile {
  id: number
  format: string
  size: number
  duration_ms: number
  added_at: string
}

/** État local de conservation, distinct d'une erreur de consultation. */
export interface DownloadState {
  status: 'not_downloaded' | 'downloading' | 'available' | 'failed'
  media_file: MediaFile | null
  error: { code: string; message: string } | null
}

const messages: Record<string, string> = {
  download_busy: 'Un autre téléchargement occupe le serveur. Réessayez après sa fin.',
  download_timeout: 'Le délai de téléchargement est dépassé. Vous pouvez réessayer.',
  download_interrupted: 'Le téléchargement a été interrompu.',
  download_failed: 'Le téléchargement du média a échoué. Vous pouvez réessayer.',
  media_format_unavailable: 'Aucune représentation vidéo et audio admissible n’est disponible.',
  media_audio_ambiguous: 'Plusieurs pistes audio sont possibles. Sillage ne peut pas identifier l’audio original de façon fiable.',
  media_unfinished: 'Cette vidéo n’est pas encore disponible comme vidéo terminée.',
  media_duration_mismatch: 'La durée du fichier ne correspond pas suffisamment à celle de la source. Le fichier n’a pas été conservé.',
  media_invalid: 'Le fichier obtenu n’a pas passé les contrôles de validation.',
  local_media_unavailable: 'Le fichier enregistré est absent, illisible ou a changé. Aucun nouveau téléchargement n’a été lancé.',
  media_source_unsupported: 'Cette source ne permet pas le téléchargement YouTube.',
  video_not_found: 'Cette vidéo n’existe plus.',
  video_source_not_found: 'Cette source n’existe plus pour cette vidéo.',
  media_file_not_found: 'Ce fichier n’appartient pas à cette vidéo.',
  internal_error: 'Une erreur interne empêche cette opération. Réessayez la consultation de l’état.',
}

/** Traduit uniquement des codes stables ; aucun diagnostic technique distant n'est affiché. */
export function downloadMessage(code: string): string {
  return messages[code] ?? 'L’opération n’a pas pu être confirmée. Actualisez son état.'
}

/** Conserve l'identité d'un fichier indisponible pour permettre sa suppression explicite. */
export class MediaError extends Error {
  /** Associe un diagnostic public à l’identité éventuellement récupérable. */
  constructor(readonly code: string, readonly mediaFile: MediaFile | null = null) {
    super(downloadMessage(code))
  }
}

function validMedia(value: unknown): value is MediaFile {
  if (!value || typeof value !== 'object') return false
  const f = value as MediaFile
  return Number.isSafeInteger(f.id) && f.id > 0 && typeof f.format === 'string' && f.format.trim().length > 0 &&
    Number.isSafeInteger(f.size) && f.size > 0 && Number.isSafeInteger(f.duration_ms) &&
    f.duration_ms > 0 && typeof f.added_at === 'string' && Number.isFinite(Date.parse(f.added_at))
}

async function request(url: string, method: string, signal: AbortSignal): Promise<DownloadState | null> {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    cache: 'no-store',
  })
  if (response.status === 204 && method === 'DELETE') return null
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new MediaError(
    typeof body?.error?.code === 'string' ? body.error.code : '',
    validMedia(body?.media_file) ? body.media_file : null,
  )
  if (!body || !['not_downloaded', 'downloading', 'available', 'failed'].includes(body.status) ||
    (body.status === 'available' ? !validMedia(body.media_file) : body.media_file !== null) ||
    (body.status === 'failed'
      ? typeof body.error?.code !== 'string'
      : body.error !== null)) throw new MediaError('')
  return body as DownloadState
}

/** Consulte exclusivement la disponibilité et l'activité serveur. */
export async function getDownload(videoID: number, sourceID: number, signal: AbortSignal): Promise<DownloadState> {
  return (await request(`/api/v1/videos/${videoID}/sources/${sourceID}/download`, 'GET', signal))!
}

/** Demande une acquisition volontaire ; aucun réessai automatique de POST. */
export async function startDownload(videoID: number, sourceID: number, signal: AbortSignal): Promise<DownloadState> {
  return (await request(`/api/v1/videos/${videoID}/sources/${sourceID}/download`, 'POST', signal))!
}

/** Supprime l'identité confirmée, jamais « le dernier fichier » d'une source. */
export async function deleteMedia(videoID: number, fileID: number, signal: AbortSignal): Promise<void> {
  await request(`/api/v1/videos/${videoID}/media-files/${fileID}`, 'DELETE', signal)
}
