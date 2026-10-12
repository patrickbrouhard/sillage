import { useEffect, useRef, useState } from 'react'
import type { VideoSource } from './api'
import { httpURL } from './videoPresentation'
import { loadYouTubeAPI } from './youtubeApi'
import type { YouTubePlayer as Player } from './youtubeApi'

/** Présente un lecteur YouTube isolé ; une pause confirmée précède son masquage. */
export function YouTubePlayer({ source }: { source: VideoSource }) {
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<Player | null>(null)
  const conceal = useRef(false)
  const concealTimer = useRef<number | undefined>(undefined)
  const [hidden, setHidden] = useState(false)
  const [hiding, setHiding] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const url = httpURL(source.canonical_url)

  useEffect(() => {
    let disposed = false
    let failed = false
    let instance: Player | null = null
    let readyTimer: number | undefined
    setReady(false); setMessage('')

    function fail(description: string) {
      if (disposed || failed) return
      failed = true
      window.clearTimeout(readyTimer)
      instance?.destroy()
      instance = null; player.current = null
      host.current?.replaceChildren()
      setReady(false); setMessage(description)
    }

    void loadYouTubeAPI().then(api => {
      if (disposed || conceal.current || !host.current) return
      // Le conteneur appartient à React ; seule son iframe appartient à YouTube.
      const iframe = document.createElement('iframe')
      const params = new URLSearchParams({
        enablejsapi: '1', origin: window.location.origin, autoplay: '0', controls: '1', playsinline: '1',
      })
      iframe.src = `https://www.youtube.com/embed/${source.external_id}?${params}`
      iframe.title = `Lecteur YouTube : ${source.title}`
      iframe.allow = 'encrypted-media; fullscreen; picture-in-picture'
      iframe.allowFullscreen = true
      iframe.referrerPolicy = 'strict-origin-when-cross-origin'
      host.current.append(iframe)
      readyTimer = window.setTimeout(() => fail('Le lecteur YouTube ne répond pas. Vous pouvez réessayer ou ouvrir la vidéo sur YouTube.'), 15_000)
      instance = new api.Player(iframe, { events: {
        onReady: event => {
          if (disposed || failed) return
          window.clearTimeout(readyTimer)
          player.current = event.target
          setReady(true)
          if (conceal.current) event.target.pauseVideo()
        },
        onStateChange: event => {
          if (disposed || failed || !conceal.current) return
          if ([1, 3].includes(event.data)) event.target.pauseVideo()
          else {
            window.clearTimeout(concealTimer.current)
            setHidden(true); setHiding(false)
          }
        },
        onError: event => {
          const errors: Record<number, string> = {
            2: 'L’identité de cette vidéo n’est pas acceptée par YouTube.',
            5: 'Cette vidéo ne peut pas être lue dans ce navigateur.',
            100: 'Cette vidéo est indisponible ou privée sur YouTube.',
            101: 'Cette vidéo n’autorise pas la lecture intégrée.',
            150: 'Cette vidéo n’autorise pas la lecture intégrée.',
            153: 'YouTube ne peut pas identifier cette intégration. Vérifiez les restrictions du navigateur.',
          }
          fail(errors[event.data] ?? 'La lecture YouTube a échoué.')
        },
      } })
    }).catch(error => fail(error instanceof Error ? error.message : 'Impossible de préparer le lecteur YouTube.'))

    return () => {
      disposed = true
      window.clearTimeout(readyTimer)
      window.clearTimeout(concealTimer.current)
      instance?.destroy()
      player.current = null
      host.current?.replaceChildren()
    }
  }, [source.external_id, source.title, attempt])

  function toggle() {
    if (hidden) {
      conceal.current = false
      setHidden(false)
      // Une instance en pause est conservée ; une initialisation interrompue repart sans autoplay.
      if (!player.current) setAttempt(value => value + 1)
      return
    }
    conceal.current = true
    const current = player.current
    if (!current) {
      setHidden(true)
      // Le nettoyage invalide aussi un chargement et ses événements tardifs.
      setAttempt(value => value + 1)
      return
    }
    current.pauseVideo()
    if (![1, 3].includes(current.getPlayerState())) { setHidden(true); return }
    setHiding(true)
    // En l'absence de confirmation, retirer l'iframe garantit l'arrêt du média.
    // Cette panne exceptionnelle ne garantit pas la restauration de position.
    concealTimer.current = window.setTimeout(() => {
      player.current = null
      setHidden(true); setHiding(false)
      setAttempt(value => value + 1)
    }, 1_000)
  }

  return <section className="video-player" aria-labelledby="player-title">
    <div className="player-toolbar">
      <h2 id="player-title">Lecteur</h2>
      <button className="button" onClick={toggle} disabled={hiding} aria-expanded={!hidden}>
        {hidden ? 'Afficher le lecteur' : hiding ? 'Mise en pause…' : 'Masquer le lecteur'}
      </button>
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Ouvrir sur YouTube ↗</a>}
    </div>
    <div hidden={hidden}>
      {!ready && !message && <p role="status">Chargement du lecteur YouTube…</p>}
      {message && <div role="alert"><p>{message}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer le lecteur</button></div>}
      <div className="youtube-frame" ref={host} />
    </div>
  </section>
}
