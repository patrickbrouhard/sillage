/** Commandes communes aux deux lecteurs concrets du workspace. */
export interface PlayerHandle {
  /** Lit le temps annoncé en millisecondes dans un état admissible, jamais un départ préparé. */
  getCurrentTimeMs(): number
  /** Navigue immédiatement ou retourne un refus, sans mise en attente. */
  navigate(startMs: number): string
  /** Arrête et décharge l'instance avant une bascule ou une suppression. */
  stop(): void
  /** Prépare la superposition Images sans décharger la surface ni changer sa visibilité. */
  prepareImages(): Promise<void>
  /** Termine la protection de pause, sans reprendre la lecture. */
  releaseImages(): void
}

/** Révèle le cadre dans la page sans modifier le focus ou les défilements internes. */
export function revealPlayer(element: HTMLElement) {
  const bounds = element.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0
  const height = viewport?.height ?? window.innerHeight
  const delta = bounds.height > height || bounds.top < top
    ? bounds.top - top
    : bounds.bottom > top + height ? bounds.bottom - top - height : 0
  if (delta) window.scrollBy({ top: delta, behavior: 'instant' })
}

/** État réservé au transfert ; une préparation ne certifie jamais un temps de capture. */
export type TransferPosition =
  | { kind: 'confirmed' | 'prepared'; milliseconds: number }
  | { kind: 'empty' | 'uncertain' }

/** Commandes internes de la surface, indépendantes de l'en-tête permanent. */
export interface PlayerSurfaceHandle extends PlayerHandle {
  /** Distingue un départ encore valable d'une position devenue indéterminable. */
  getTransferPosition(): TransferPosition
  /** Masque après arrêt confirmé, ou révèle sans reprendre la lecture. */
  toggleVisibility(): void
}

/** État de visibilité confirmé par la surface, notamment après la pause YouTube. */
export interface PlayerVisibility {
  hidden: boolean
  hiding: boolean
}
