import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { IconButton } from './IconButton'
import { revealPlayer } from './player'
import type { PlayerHandle } from './player'

/** Lit une identité média exacte avec les contrôles natifs et sans reprise automatique. */
export function LocalPlayer({ url, ref, heading, children, initialStartMs }: {
  url?: string
  ref: Ref<PlayerHandle>
  heading: ReactNode
  children?: ReactNode
  initialStartMs?: number
}) {
  const host = useRef<HTMLVideoElement>(null)
  const stopped = useRef(false)
  const initialPosition = useRef(initialStartMs)
  const [hidden, setHidden] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [navigation, setNavigation] = useState(0)

  /** Retire aussi la source pour interrompre les requêtes HTTP, même en pause. */
  function stop() {
    stopped.current = true
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
          current.currentTime = Math.min(position / 1000, Number.isFinite(current.duration) ? current.duration : position / 1000)
        } catch { fail() }
      }
    }
    current.addEventListener('loadedmetadata', ready)
    current.addEventListener('error', fail)
    current.src = url
    return () => {
      disposed = true
      current.removeEventListener('loadedmetadata', ready)
      current.removeEventListener('error', fail)
      current.pause(); current.removeAttribute('src'); current.load()
    }
  }, [url, attempt])

  useLayoutEffect(() => {
    if (navigation && host.current) revealPlayer(host.current)
  }, [navigation])

  useImperativeHandle(ref, () => ({
    stop,
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
        setNavigation(value => value + 1)
        return ''
      } catch { return 'Navigation non effectuée : le repositionnement local a échoué.' }
    },
  }))

  return <section className="video-player" aria-label="Lecteur">
    <div className="player-toolbar">
      {heading}
      {children}
      <IconButton icon={hidden ? 'eye' : 'eye-off'} aria-expanded={!hidden}
        label={hidden ? 'Afficher la vidéo' : 'Masquer la vidéo'} onClick={() => {
          if (!hidden) host.current?.pause()
          setHidden(value => !value)
        }} />
    </div>
    <div hidden={hidden}>
      {message && <div role="alert"><p>{message}</p><button className="button"
        onClick={() => setAttempt(value => value + 1)}>Réessayer le lecteur</button></div>}
      {url && <video ref={host} className="local-video" aria-label="Lecteur vidéo local"
        controls playsInline preload="metadata" onPlay={() => {
          // Une reprise native tardive ne doit pas contourner le masquage.
          if (hidden || stopped.current) host.current?.pause()
        }} />}
    </div>
  </section>
}
