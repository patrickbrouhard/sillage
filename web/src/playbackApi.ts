import { apiFetch } from './auth'

/** Construit le chemin de la seule source de travail, sans identité de fichier média. */
function progressURL(videoID: number, sourceID: number) {
  return `/api/v1/videos/${videoID}/sources/${sourceID}/playback-progress`
}

/** Lit le point de reprise ; une réponse invalide ne vaut jamais une position nulle. */
export async function getPlaybackProgress(videoID: number, sourceID: number, signal: AbortSignal): Promise<number | null> {
  const response = await apiFetch(progressURL(videoID, sourceID), { signal })
  if (!response.ok) throw new Error('Reprise indisponible.')
  const body = await response.json()
  if (body?.position_ms !== null && (!Number.isSafeInteger(body?.position_ms) || body.position_ms < 0)) {
    throw new Error('Point de reprise invalide.')
  }
  return body.position_ms
}

/** Remplace ou efface le point avec le CSRF habituel ; la sortie reste opportuniste. */
export async function savePlaybackProgress(videoID: number, sourceID: number, position: number | null, keepalive: boolean) {
  const response = await apiFetch(progressURL(videoID, sourceID), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_ms: position }),
    keepalive,
  })
  if (response.status !== 204) throw new Error('Enregistrement de la reprise non confirmé.')
}
