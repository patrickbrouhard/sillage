/** Identité publique de capture ; aucun chemin physique n'est transmis. */
export interface Asset {
  id: number
  video_id: number
  source_id: number
  timestamp_ms: number
  type: 'screenshot'
  status: 'pending' | 'available' | 'failed'
  error_code: string
  created_at: string
}

/** Paramètres figés au clic, indépendants de l'évolution du lecteur. */
export interface CaptureTarget { videoID: number; sourceID: number; timestampMs: number }

/** Distingue un refus explicite d'une réponse de transport incertaine. */
export class AssetError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === 'capture_busy' ? 'Une autre capture occupe le serveur. Réessayez après sa fin.'
      : code === 'capture_source_unsupported' ? 'Cette source ne permet pas la capture.'
      : 'La capture n’a pas pu être confirmée. Vous pouvez réessayer.')
  }
}

function validAsset(value: unknown): value is Asset {
  if (!value || typeof value !== 'object') return false
  const a = value as Asset
  return [a.id, a.video_id, a.source_id].every(id => Number.isSafeInteger(id) && id > 0) &&
    Number.isSafeInteger(a.timestamp_ms) && a.timestamp_ms >= 0 && a.type === 'screenshot' &&
    ['pending', 'available', 'failed'].includes(a.status) &&
    typeof a.error_code === 'string' && typeof a.created_at === 'string'
}

async function request(url: string, signal: AbortSignal, body?: object): Promise<Asset> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new AssetError(response.status, value?.error?.code ?? '')
  if (!validAsset(value)) throw new Error('Réponse de capture invalide.')
  return value
}

/** Consulte l'état sans relancer la génération. */
export function getAsset(id: number, signal: AbortSignal): Promise<Asset> {
  return request(`/api/v1/assets/${id}`, signal)
}

/** Retrouve une réponse perdue ; tout réessai conserve strictement la même clé de commande. */
export async function createCapture(target: CaptureTarget, requestID: string, signal: AbortSignal): Promise<Asset> {
  const url = `/api/v1/videos/${target.videoID}/sources/${target.sourceID}/captures`
  const body = { timestamp_ms: target.timestampMs, request_id: requestID }
  let result: Asset
  try {
    result = await request(url, signal, body)
  } catch (error) {
    if (signal.aborted || (error instanceof AssetError && error.status < 500)) throw error
    try {
      result = await request(`/api/v1/assets/requests/${requestID}`, signal)
    } catch (lookup) {
      if (!(lookup instanceof AssetError) || lookup.status !== 404) throw lookup
      result = await request(url, signal, body)
    }
  }
  if (result.video_id !== target.videoID || result.source_id !== target.sourceID || result.timestamp_ms !== target.timestampMs) {
    throw new Error('La réponse ne correspond pas à la capture demandée.')
  }
  return result
}

/** Reconnaît uniquement la route interne canonique, sans extension du filtrage des URL. */
export function assetIDFromURL(value: string | undefined): number | null {
  const match = value?.match(/^\/api\/v1\/assets\/([1-9]\d*)\/content$/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/** Produit une référence stable, utilisable plusieurs fois dans une note. */
export function assetMarkdown(a: Asset, label: string): string {
  return `![Capture à ${label}](/api/v1/assets/${a.id}/content) `
}

/** Page bornée du catalogue vidéo, sans relation avec le contenu de la note. */
export interface AssetPage { assets: Asset[]; page: number; has_more: boolean }

/** Consulte toutes les sources et tous les états, sans acquisition implicite. */
export async function listAssets(videoID: number, page: number, signal: AbortSignal): Promise<AssetPage> {
  const response = await fetch(`/api/v1/videos/${videoID}/assets?page=${page}`, {
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  })
  if (!response.ok) throw new Error(response.status === 404
    ? 'Cette vidéo n’existe plus.' : 'Impossible de consulter les images. Réessayez.')
  const value = await response.json()
  if (!Array.isArray(value.assets) || value.assets.length > 12 ||
      !value.assets.every((a: unknown) => validAsset(a) && a.video_id === videoID) ||
      value.page !== page || typeof value.has_more !== 'boolean') {
    throw new Error('Réponse du catalogue invalide.')
  }
  return value
}
