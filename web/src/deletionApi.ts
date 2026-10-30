import { apiFetch } from './auth'

/** Un refus HTTP certain n'est pas assimilé à une réponse perdue ou à un commit incertain. */
export class DeletionError extends Error {
  constructor(readonly status: number) {
    super(status === 409
      ? 'Vidéo occupée : attendez la fin des téléchargements, captures ou transcriptions et fermez les autres lectures locales.'
      : 'La suppression a été refusée. Votre note est conservée.')
  }
}

/** Répéter cette commande sur le même ID reprend uniquement sa purge autorisée. */
export async function deleteVideo(id: number): Promise<'complete' | 'pending'> {
  const response = await apiFetch(`/api/v1/videos/${id}`, {
    method: 'DELETE', signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 204) return 'complete'
  if (response.status === 202 && (await response.json()).status === 'purge_pending') return 'pending'
  if (response.status >= 400 && response.status < 500) throw new DeletionError(response.status)
  throw new Error('Résultat de suppression incertain.')
}
