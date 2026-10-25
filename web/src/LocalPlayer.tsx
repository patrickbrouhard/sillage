import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { revealPlayer } from './player'
import type { PlayerSurfaceHandle, PlayerVisibility } from './player'

/** Lit une identité média exacte avec les contrôles natifs et sans reprise automatique. */
export function LocalPlayer({ url, ref, onVisibility, initialStartMs }: {
  url?: string
  ref: Ref<PlayerSurfaceHandle>
  onVisibility: (state: PlayerVisibility) => void
  initialStartMs?: number
}) {
  const host = useRef<HTMLVideoElement>(null)
  const stopped = useRef(false)
  const initialPosition = useRef(initialStartMs)
  const prepared = useRef(initialStartMs)
  const [hidden, setHidden] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [navigation, setNavigation] = useState(0)

  /** Retire aussi la source pour interrompre les requêtes HTTP, même en pause. */
  function stop() {
    stopped.current = true
    prepared.current = undefined
    initialPosition.current = undefined
    const current = host.current
    if (current) { current.pause(); current.removeAttribute('src'); current.load() }
  }

  useEffect(() => {
    const current = host.current
    stopped.current = false
    setMessage('')
    if (!current || !url) return
    let disposed = false
    const fail = () => {
      if (disposed || stopped.current) return
      initialPosition.current = undefined
      setMessage('Impossible de lire ce fichier local dans ce navigateur. Vous pouvez réessayer ou sélectionner YouTube.')
      stop()
    }
    const ready = () => {
      if (disposed || stopped.current) return
      const position = initialPosition.current
      initialPosition.current = undefined
      if (position !== undefined) {
        // Le transfert est borné par la durée réelle, sans modifier les références enregistrées.
        try {
          current.pause()
          const seconds = Math.min(position / 1000, Number.isFinite(current.duration) ? current.duration : position / 1000)
          prepared.current = Math.round(seconds * 1000)
          current.currentTime = seconds
        } catch { fail() }
      }
    }
    const settled = () => { if (!disposed) prepared.current = undefined }
    current.addEventListener('seeked', settled)
    current.addEventListener('loadedmetadata', ready)
    current.addEventListener('error', fail)
    current.src = url
    return () => {
      disposed = true
      current.removeEventListener('seeked', settled)
      current.removeEventListener('loadedmetadata', ready)
      current.removeEventListener('error', fail)
      current.pause(); current.removeAttribute('src'); current.load()
    }
  }, [url, attempt])

  useLayoutEffect(() => {
    onVisibility({ hidden, hiding: false })
  }, [hidden, onVisibility])

  useLayoutEffect(() => {
    if (navigation && host.current) revealPlayer(host.current)
  }, [navigation])

  useImperativeHandle(ref, () => ({
    stop,
    prepareImages: async () => {},
    releaseImages: () => {},
    getTransferPosition() {
      const current = host.current
      if (!url) return { kind: 'empty' }
      if (!current || stopped.current || current.error) return { kind: 'uncertain' }
      const milliseconds = Math.round(current.currentTime * 1000)
      if (current.readyState >= 2 && !current.seeking && Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
        return { kind: 'confirmed', milliseconds }
      }
      // Le chargement initial et un seek explicite en pause conservent leur cible.
      // Un seek natif ou une lecture ne réutilise jamais un ancien curseur.
      if (prepared.current !== undefined && current.paused &&
          (current.readyState < 1 || milliseconds === prepared.current)) {
        return { kind: 'prepared', milliseconds: prepared.current }
      }
      return { kind: current.readyState < 1 && prepared.current === undefined ? 'empty' : 'uncertain' }
    },
    toggleVisibility() {
      if (!hidden) host.current?.pause()
      setHidden(value => !value)
    },
    getCurrentTimeMs() {
      const current = host.current
      const milliseconds = Math.round((current?.currentTime ?? NaN) * 1000)
      if (!current || stopped.current || current.error || current.readyState < 2 || current.seeking ||
        !Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new Error('Temps indisponible : attendez la fin du chargement ou du repositionnement du lecteur local.')
      }
      return milliseconds
    },
    navigate(startMs) {
      setHidden(false)
      const current = host.current
      if (!current || stopped.current || current.error || current.readyState < 1) {
        return 'Navigation non effectuée : le lecteur local est indisponible ou pas encore prêt. Activez à nouveau le timestamp une fois le lecteur prêt.'
      }
      if (!Number.isSafeInteger(startMs) || startMs < 0 ||
        (Number.isFinite(current.duration) && startMs / 1000 > current.duration)) {
        return 'Navigation non effectuée : cette position est hors du fichier local.'
      }
      try {
        // Affecter currentTime ne lance pas la lecture ; un lecteur masqué est déjà en pause.
        current.currentTime = startMs / 1000
        prepared.current = startMs
        setNavigation(value => value + 1)
        return ''
      } catch { return 'Navigation non effectuée : le repositionnement local a échoué.' }
    },
  }))

  return <div className="player-surface" hidden={hidden}>
      {message && <div role="alert"><p>{message}</p><button className="button"
        onClick={() => setAttempt(value => value + 1)}>Réessayer le lecteur</button></div>}
      {url && <video ref={host} className="local-video" aria-label="Lecteur vidéo local"
        controls playsInline preload="metadata" onPlay={() => {
          prepared.current = undefined
          // Une reprise native tardive ne doit pas contourner le masquage.
          if (hidden || stopped.current) host.current?.pause()
        }} />}
    </div>
}
