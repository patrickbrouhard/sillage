/** Accepte uniquement une URL HTTP(S) absolue, sans identifiants de connexion. */
export function httpURL(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Formate une durée connue sans confondre zéro et absence de métadonnée. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Nomme la plateforme sans l'assimiler au compte de publication ou à une personne. */
export function providerLabel(provider: string | undefined): string {
  return provider === 'youtube' ? 'YouTube' : provider || 'Source non renseignée'
}
