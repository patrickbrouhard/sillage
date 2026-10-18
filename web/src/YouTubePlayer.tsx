import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { VideoSource } from './api'
import { IconButton } from './IconButton'
import { loadYouTubeAPI } from './youtubeApi'
import type { YouTubePlayer as Player } from './youtubeApi'
import { revealPlayer } from './player'
import type { PlayerHandle } from './player'

/** Présente un lecteur YouTube isolé ; une pause confirmée précède son masquage. */
export function YouTubePlayer({ source, ref, children, heading, status, initialStartMs }: { source: VideoSource; ref: Ref<PlayerHandle>; children?: ReactNode; heading: ReactNode; status?: ReactNode; initialStartMs?: number }) {
  const initialPosition = useRef(initialStartMs)
  const stopPlayer = useRef<(() => void) | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<Player | null>(null)
  const failPlayer = useRef<((description: string) => void) | null>(null)
  const conceal = useRef(false)
  const concealed = useRef(false)
  const concealTimer = useRef<number | undefined>(undefined)
  const [hidden, setHidden] = useState(false)
  const [hiding, setHiding] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [navigation, setNavigation] = useState(0)

  useLayoutEffect(() => {
    if (!navigation || !host.current) return
    // La commande et le réaffichage sont déjà commités. Seule la page défile,
    // jamais les panneaux internes ; aucun travail n'attend onReady.
    revealPlayer(host.current)
  }, [navigation])

  useImperativeHandle(ref, () => ({
    stop() { stopPlayer.current?.() },
    getCurrentTimeMs() {
      const current = player.current
      if (!current || !ready || hiding) {
        throw new Error('Temps indisponible : le lecteur doit être prêt et son masquage terminé.')
      }
      try {
        // Un départ préparé par cueVideoById n'est pas une position de lecture confirmée.
        // Le buffering peut aussi correspondre à un repositionnement encore en cours.
        if (![0, 1, 2].includes(current.getPlayerState())) {
          throw new Error('unavailable')
        }
        const seconds = current.getCurrentTime()
        const milliseconds = Math.round(seconds * 1000)
        if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(milliseconds)) {
          throw new Error('unavailable')
        }
        return milliseconds
      } catch {
        throw new Error('Temps indisponible : démarrez la vidéo ou attendez la fin du chargement avant de réessayer.')
      }
    },
    navigate(startMs) {
      // Ne jamais annuler la garantie d'arrêt d'un masquage encore en cours.
      if (hiding) return 'Mise en pause du lecteur en cours. Activez à nouveau le timestamp après son arrêt.'
      if (hidden) toggle()
      const current = player.current
      if (!current || !ready) return 'Navigation non effectuée : le lecteur est indisponible ou pas encore prêt. Activez à nouveau le timestamp une fois le lecteur prêt.'
      try {
        const state = current.getPlayerState()
        const seconds = startMs / 1000
        if ([1, 2, 3].includes(state)) current.seekTo(seconds, true)
        // seekTo démarre depuis cued, unstarted ou ended : préparer seulement le départ.
        else if ([-1, 0, 5].includes(state)) current.cueVideoById({
          videoId: source.external_id!,
          startSeconds: seconds,
        })
        else return 'Navigation non effectuée : état du lecteur inconnu. Réessayez lorsque le lecteur est prêt.'
        setNavigation(value => value + 1)
        return ''
      } catch {
        // Une commande en échec ne laisse pas une instance potentiellement active.
        failPlayer.current?.('La commande YouTube a échoué. Réessayez le lecteur.')
        return 'Navigation non effectuée : la commande YouTube a échoué.'
      }
    },
  }))

  useEffect(() => {
    let disposed = false
    let failed = false
    let instance: Player | null = null
    let readyTimer: number | undefined
    setReady(false); setMessage('')

    /** Une initialisation en échec ne peut pas être réactivée par un événement tardif. */
    function fail(description: string) {
      if (disposed || failed) return
      failed = true
      window.clearTimeout(readyTimer)
      instance?.destroy()
      instance = null; player.current = null
      host.current?.replaceChildren()
      setReady(false); setMessage(description)
    }
    failPlayer.current = fail
    stopPlayer.current = () => {
      failed = true
      window.clearTimeout(readyTimer)
      window.clearTimeout(concealTimer.current)
      instance?.destroy()
      instance = null; player.current = null
      setReady(false)
    }

    void loadYouTubeAPI().then(api => {
      if (disposed || failed || conceal.current || !host.current) return
      // Le conteneur appartient à React ; seule son iframe appartient à YouTube.
      const iframe = document.createElement('iframe')
      const params = new URLSearchParams({
        enablejsapi: '1',
        origin: window.location.origin,
        autoplay: '0',
        controls: '1',
        playsinline: '1',
      })
      iframe.src = `https://www.youtube.com/embed/${source.external_id}?${params}`
      iframe.title = `Lecteur YouTube : ${source.title}`
      iframe.allow = 'encrypted-media; fullscreen; picture-in-picture'
      iframe.referrerPolicy = 'strict-origin-when-cross-origin'
      host.current.append(iframe)
      readyTimer = window.setTimeout(() => fail('Le lecteur YouTube ne répond pas. Vous pouvez réessayer ou ouvrir la vidéo sur YouTube.'), 15_000)
      instance = new api.Player(iframe, { events: {
        onReady: event => {
          if (disposed || failed) return
          window.clearTimeout(readyTimer)
          player.current = event.target
          setReady(true)
          // Seule la bascule prépare un départ à l'initialisation ; les timestamps ne sont jamais différés.
          const startMs = initialPosition.current
          initialPosition.current = undefined
          if (startMs !== undefined) {
            try { event.target.cueVideoById({ videoId: source.external_id!, startSeconds: startMs / 1000 }) }
            catch { fail('Impossible de préparer la position YouTube. Réessayez le lecteur.') }
          }
          if (conceal.current) event.target.pauseVideo()
        },
        onStateChange: event => {
          if (disposed || failed || !conceal.current) return
          if ([1, 3].includes(event.data)) {
            // Une reprise tardive après masquage ne doit pas devenir une lecture en arrière-plan.
            if (concealed.current) fail('Le lecteur a été arrêté après une reprise inattendue alors qu’il était masqué.')
            else event.target.pauseVideo()
          }
          else {
            window.clearTimeout(concealTimer.current)
            concealed.current = true
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
      failPlayer.current = null
      stopPlayer.current = null
      window.clearTimeout(readyTimer)
      window.clearTimeout(concealTimer.current)
      instance?.destroy()
      player.current = null
      host.current?.replaceChildren()
    }
  }, [source.external_id, source.title, attempt])

  /** Attend une pause confirmée ; le lecteur reste visible tant qu'il peut encore jouer. */
  function toggle() {
    if (hidden) {
      conceal.current = false
      concealed.current = false
      setHidden(false)
      // Une instance en pause est conservée ; une initialisation interrompue repart sans autoplay.
      if (!player.current) setAttempt(value => value + 1)
      return
    }
    conceal.current = true
    const current = player.current
    if (!current) {
      concealed.current = true
      setHidden(true)
      // Le nettoyage invalide aussi un chargement et ses événements tardifs.
      setAttempt(value => value + 1)
      return
    }
    current.pauseVideo()
    if (![1, 3].includes(current.getPlayerState())) {
      concealed.current = true
      setHidden(true)
      return
    }
    setHiding(true)
    // En l'absence de confirmation, retirer l'iframe garantit l'arrêt du média.
    // Cette panne exceptionnelle ne garantit pas la restauration de position.
    concealTimer.current = window.setTimeout(() => {
      player.current = null
      concealed.current = true
      setHidden(true); setHiding(false)
      setAttempt(value => value + 1)
    }, 1_000)
  }

  return <section className="video-player" aria-label="Lecteur">
    <div className="player-toolbar">
      {heading}
      {children}
      <IconButton icon={hidden ? 'eye' : 'eye-off'} onClick={toggle} disabled={hiding}
        aria-expanded={!hidden} aria-busy={hiding}
        label={hidden ? 'Afficher la vidéo' : hiding ? 'Mise en pause…' : 'Masquer la vidéo'} />
    </div>
    {status}
    <div hidden={hidden}>
      {!ready && !message && <p role="status">Chargement du lecteur YouTube…</p>}
      {message && <div role="alert"><p>{message}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer le lecteur</button></div>}
      <div className="youtube-frame" ref={host} />
    </div>
  </section>
}
