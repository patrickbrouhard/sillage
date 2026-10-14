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


/** Identité et position d'une référence canonique, indépendantes de son libellé. */
export interface TemporalReference {
  videoID: number
  sourceID: number
  startMs: number
}

/** Refuse toute extension ou normalisation implicite du format produit par Sillage. */
export function parseTemporalReference(value: string): TemporalReference | null {
  const match = /^sillage:\/\/videos\/([1-9][0-9]*)\/sources\/([1-9][0-9]*)\?start_ms=(0|[1-9][0-9]*)$/.exec(value)
  // $ accepte aussi une fin de ligne finale en JS : exiger la chaîne complète.
  if (!match || match[0] !== value) return null
  const [videoID, sourceID, startMs] = match.slice(1).map(Number)
  return [videoID, sourceID, startMs].every(Number.isSafeInteger)
    ? { videoID, sourceID, startMs }
    : null
}
