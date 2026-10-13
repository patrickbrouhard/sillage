import { formatDuration } from './videoPresentation'

/** Construit une référence autonome dans la base Sillage, sans interpréter le Markdown existant. */
export function temporalReference(videoID: number, sourceID: number, startMs: number): string {
  if (!Number.isSafeInteger(videoID) || videoID <= 0 ||
      !Number.isSafeInteger(sourceID) || sourceID <= 0 ||
      !Number.isSafeInteger(startMs) || startMs < 0) {
    throw new Error('Impossible de créer la référence : identité ou position invalide.')
  }
  // « videos » est l'autorité logique de l'URI ; les identifiants désignent la même source que le lecteur.
  return `[${formatDuration(startMs)}](sillage://videos/${videoID}/sources/${sourceID}?start_ms=${startMs})`
}
