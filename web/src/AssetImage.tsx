import { useState } from 'react'
import { useAsset } from './useAsset'

/** Rend une image interne sans commande au lecteur ni modification de la note. */
export function AssetImage({ id, alt }: { id: number; alt?: string }) {
  const { asset, error } = useAsset(id)
  const [unavailable, setUnavailable] = useState(false)
  if (error) return <span role="status" className="asset-placeholder">{error}</span>
  if (!asset || asset.status === 'pending') return <span role="status" className="asset-placeholder">Capture en cours de génération…</span>
  if (asset.status === 'failed') return <span role="status" className="asset-placeholder">La génération de cette capture a échoué ou a été interrompue.</span>
  if (unavailable) return <span role="status" className="asset-placeholder">L’image générée est actuellement indisponible. <button type="button" onClick={() => setUnavailable(false)}>Réessayer l’affichage</button></span>
  return <img src={`/api/v1/assets/${id}/content`} alt={alt ?? 'Capture vidéo'} onError={() => setUnavailable(true)} />
}
