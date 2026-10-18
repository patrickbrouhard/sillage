/** Commandes communes aux deux lecteurs concrets du workspace. */
export interface PlayerHandle {
  /** Lit une position confirmée en millisecondes, sans commander le lecteur. */
  getCurrentTimeMs(): number
  /** Navigue immédiatement ou retourne un refus, sans mise en attente. */
  navigate(startMs: number): string
  /** Arrête et décharge l'instance avant une bascule ou une suppression. */
  stop(): void
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
