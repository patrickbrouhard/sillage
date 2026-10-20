import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteMedia, getDownload, MediaError, startDownload } from './mediaApi'
import type { DownloadState, MediaFile } from './mediaApi'

/** Partage une unique consultation entre commandes et description du fichier local. */
export function useVideoDownload(videoID: number, sourceID: number | undefined) {
  const [state, setState] = useState<DownloadState | null>(null)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState<MediaFile | null>(null)
  const [result, setResult] = useState<'success' | 'failure' | null>(null)
  const observedDownload = useRef(false)
  const requestedDownload = useRef(false)
  const [requesting, setRequesting] = useState(false)
  // Un état initial disponible/échoué n'est pas le résultat d'une opération suivie ici.
  // Après POST perdu, available confirme la conservation ; failed peut être ancien
  // et n'est un nouveau résultat que si l'activité serveur a réellement été observée.
  const observe = useCallback((value: DownloadState) => {
    if (value.status === 'downloading') {
      observedDownload.current = true
      setResult(null)
    } else if (observedDownload.current || requestedDownload.current) {
      if (value.status === 'available' || (value.status === 'failed' && observedDownload.current)) {
        setResult(value.status === 'available' ? 'success' : 'failure')
      }
      observedDownload.current = false
      requestedDownload.current = false
    }
    setState(value)
  }, [])
  useEffect(() => {
    if (!result) return
    const timer = window.setTimeout(() => setResult(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [result])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  const revision = useRef(0)

  const load = useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!sourceID || !signal || signal.aborted || busyRef.current) return
    const current = ++revision.current
    try {
      const value = await getDownload(videoID, sourceID, signal)
      if (!signal.aborted && current === revision.current) {
        observe(value)
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
  }, [videoID, sourceID, observe])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    busyRef.current = false
    setBusy(false)
    setRequesting(false)
    setResult(null)
    observedDownload.current = false
    requestedDownload.current = false
    setState(null)
    setMissing(null)
    setError('')
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
    if (!sourceID || !signal || signal.aborted || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    revision.current++
    setError('')
    if (!file) {
      requestedDownload.current = true
      setRequesting(true)
      setResult(null)
    }
    let failed = false
    try {
      if (file) {
        await deleteMedia(videoID, file.id, signal)
        if (!signal.aborted) setMissing(null)
      } else {
        const next = await startDownload(videoID, sourceID, signal)
        if (!signal.aborted) observe(next)
      }
    } catch (cause) {
      failed = true
      if (!signal.aborted) setError(cause instanceof MediaError ? cause.message : 'La réponse du serveur est incertaine. L’état va être relu sans relancer le téléchargement.')
    } finally {
      if (lifetime.current?.signal === signal) busyRef.current = false
      if (!signal.aborted) {
        setBusy(false)
        setRequesting(false)
        // Même après une réponse perdue, seule une lecture est automatique.
        // Le message de refus reste visible si la relecture retrouve l'absence.
        const current = ++revision.current
        try {
          const next = await getDownload(videoID, sourceID, signal)
          if (!signal.aborted && current === revision.current) {
            observe(next)
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

  return { state, error, busy, requesting, result, file: state?.media_file ?? missing, load, mutate }
}
