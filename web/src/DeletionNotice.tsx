import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { deleteVideo } from './deletionApi'

/** Garde une purge incomplète réessayable dans l'historique de cette entrée de bibliothèque. */
export function DeletionNotice() {
  const location = useLocation()
  const navigate = useNavigate()
  const value = location.state?.videoDeletion
  const [notice, setNotice] = useState<{ id: number; pending: boolean } | null>(
    value && Number.isSafeInteger(value.id) && value.id > 0 ? value : null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!notice || notice.pending) return
    // Un succès complet ne doit pas réapparaître après un retour navigateur.
    navigate(location.pathname + location.search, { replace: true, state: null })
    const timer = window.setTimeout(() => setNotice(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [notice?.id, notice?.pending])

  async function retry() {
    if (!notice || busy) return
    setBusy(true)
    setError('')
    try {
      const pending = await deleteVideo(notice.id) === 'pending'
      const next = { ...notice, pending }
      setNotice(next)
      navigate(location.pathname + location.search, { replace: true, state: { videoDeletion: next } })
    } catch {
      setError('Nettoyage non confirmé. Vous pouvez réessayer ; la vidéo reste supprimée.')
    } finally { setBusy(false) }
  }

  if (!notice) return null
  return <aside className="deletion-notice" aria-label="Résultat de suppression">
    <p role="status">{notice.pending
      ? 'Vidéo supprimée. Le nettoyage des fichiers reste à terminer ; il sera aussi retenté au démarrage du serveur.'
      : 'Vidéo supprimée définitivement.'}</p>
    {notice.pending && <button className="button" disabled={busy} onClick={() => void retry()}>
      {busy ? 'Nettoyage en cours…' : 'Réessayer le nettoyage'}
    </button>}
    {error && <p role="alert">{error}</p>}
  </aside>
}
