import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteMedia, downloadMessage, getDownload, MediaError, startDownload } from './mediaApi'
import type { DownloadState, MediaFile } from './mediaApi'
import { formatDuration } from './videoPresentation'

/** Suit la conservation sans commander le lecteur ni modifier la session de note. */
export function VideoDownload({ videoID, sourceID }: { videoID: number; sourceID: number }) {
  const [state, setState] = useState<DownloadState | null>(null)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState<MediaFile | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  const revision = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const deletion = useRef<MediaFile | null>(null)
  const removeButton = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted || busyRef.current) return
    const current = ++revision.current
    try {
      const value = await getDownload(videoID, sourceID, signal)
      if (!signal.aborted && current === revision.current) {
        setState(value)
        setMissing(null)
        setError('')
      }
    } catch (cause) {
      if (!signal.aborted && current === revision.current) {
        setError(cause instanceof MediaError ? cause.message : 'Impossible de consulter le téléchargement. Vérifiez la connexion puis actualisez l’état.')
        setMissing(cause instanceof MediaError ? cause.mediaFile : null)
        setState(null)
      }
    }
  }, [videoID, sourceID])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load()
    const visible = () => { if (!document.hidden) void load() }
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.abort()
      revision.current++
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])

  useEffect(() => {
    if (state?.status !== 'downloading' || busy) return
    const timer = window.setTimeout(() => { void load() }, 2_000)
    return () => window.clearTimeout(timer)
  }, [state, busy, load])

  async function mutate(file?: MediaFile) {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    revision.current++
    setError('')
    let failed = false
    try {
      if (file) {
        await deleteMedia(videoID, file.id, signal)
        setMissing(null)
      } else {
        const next = await startDownload(videoID, sourceID, signal)
        if (!signal.aborted) setState(next)
      }
    } catch (cause) {
      failed = true
      if (!signal.aborted) setError(cause instanceof MediaError ? cause.message : 'La réponse du serveur est incertaine. L’état va être relu sans relancer le téléchargement.')
    } finally {
      busyRef.current = false
      if (!signal.aborted) {
        setBusy(false)
        // Même après une réponse perdue, seule une lecture est automatique.
        // Le message de refus reste visible si la relecture retrouve l'absence.
        const current = ++revision.current
        try {
          const next = await getDownload(videoID, sourceID, signal)
          if (!signal.aborted && current === revision.current) {
            setState(next)
            setMissing(null)
            if (!failed || (!file && (next.status === 'available' || next.status === 'downloading'))) setError('')
          }
        } catch (cause) {
          if (!signal.aborted && current === revision.current) {
            setState(null)
            setMissing(cause instanceof MediaError ? cause.mediaFile : null)
            setError(cause instanceof MediaError ? cause.message : 'Impossible de confirmer l’état. Actualisez avant une nouvelle action.')
          }
        }
      }
    }
  }

  const file = state?.media_file ?? missing
  const status = state?.status
  return <div className="video-download" aria-label="Téléchargement local">
    <p role="status" aria-live="polite">
      {busy ? 'Opération en cours…' : error && !state ? 'État du fichier local indisponible.' :
        status === 'downloading' ? 'Téléchargement en cours sur le serveur…' :
        status === 'available' ? `Fichier local disponible · ${file!.format.toUpperCase()} · ${(file!.size / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mio · ${formatDuration(file!.duration_ms)}` :
        status === 'failed' ? 'Échec du téléchargement.' :
        status === 'not_downloaded' ? 'Aucun fichier local conservé.' : 'Consultation du fichier local…'}
    </p>
    {state?.error && <p className="error" role="alert">{downloadMessage(state.error.code)}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="download-actions">
      {(status === 'not_downloaded' || status === 'failed') &&
        <button className="button" disabled={busy} onClick={() => { void mutate() }}>
          {status === 'failed' ? 'Réessayer le téléchargement' : 'Télécharger'}
        </button>}
      {file && <button ref={removeButton} className="button" disabled={busy} onClick={() => {
        deletion.current = file
        dialog.current?.showModal()
      }}>Supprimer le fichier local</button>}
      {error && <button className="button" disabled={busy} onClick={() => { void load() }}>Actualiser l’état</button>}
    </div>
    <dialog ref={dialog} className="tag-dialog" aria-labelledby="delete-media-title"
      onClose={() => removeButton.current?.focus()}>
      <h2 id="delete-media-title">Supprimer le fichier local ?</h2>
      <p>La vidéo, les notes, les transcriptions et les captures restent conservées. Seul le fichier média local sera supprimé.</p>
      <div className="download-actions">
        <button className="button" autoFocus onClick={() => dialog.current?.close()}>Annuler</button>
        <button className="button" onClick={() => {
          const target = deletion.current
          dialog.current?.close()
          if (target) void mutate(target)
        }}>Confirmer la suppression</button>
      </div>
    </dialog>
  </div>
}
