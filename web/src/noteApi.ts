/** Note persistée ; la révision 0 est réservée à l'absence attendue. */
export interface Note {
  video_id: number
  content_md: string
  revision: number
  created_at: string
  updated_at: string
}

/** Distingue refus certain du serveur et résultat d'écriture potentiellement incertain. */
export class NoteError extends Error {
  /** Une réponse 5xx peut suivre une écriture effectuée ; elle impose une relecture. */
  constructor(message: string, readonly status: number, readonly code = '') { super(message) }
}

/** Lit le JSON de note et refuse un contrat incomplet. */
async function read(response: Response): Promise<Note> {
  const note = await response.json()
  if (!note || typeof note.content_md !== 'string' ||
      !Number.isSafeInteger(note.revision) || note.revision < 1 ||
      !Number.isSafeInteger(note.video_id) || typeof note.updated_at !== 'string') {
    throw new Error('Réponse de note illisible. Relisez son état avant de réessayer.')
  }
  return note
}

/** Traduit les erreurs sans assimiler une panne à une note absente. */
async function failure(response: Response): Promise<NoteError> {
  const body = await response.json().catch(() => null)
  const messages: Record<number, string> = {
    400: 'La sauvegarde de la note est invalide.',
    404: 'La vidéo ou la note n’est plus disponible.',
    409: 'Conflit : la note a été modifiée depuis votre lecture.',
    413: 'La note dépasse la limite de 1 Mio de JSON. Réduisez son contenu avant de réessayer.',
  }
  return new NoteError(messages[response.status] ?? 'Le serveur n’a pas confirmé la sauvegarde.', response.status, body?.error?.code)
}

/** Une seule absence métier est convertie en null ; toute autre erreur reste visible. */
export async function getNote(id: number, signal: AbortSignal): Promise<Note | null> {
  const response = await fetch(`/api/v1/videos/${id}/note`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const error = await failure(response)
    if (error.status === 404 && error.code === 'note_not_found') return null
    throw error
  }
  return read(response)
}

/** Sauvegarde conditionnelle, sans normalisation ni relance implicite. */
export async function putNote(id: number, content: string, revision: number, signal: AbortSignal): Promise<Note> {
  const response = await fetch(`/api/v1/videos/${id}/note`, {
    method: 'PUT', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_md: content, expected_revision: revision }),
  })
  if (!response.ok) throw await failure(response)
  return read(response)
}
