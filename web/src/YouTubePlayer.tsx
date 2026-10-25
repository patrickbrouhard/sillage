import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { VideoSource } from './api'
import { loadYouTubeAPI } from './youtubeApi'
import type { YouTubePlayer as Player } from './youtubeApi'
import { revealPlayer } from './player'
import type { PlayerSurfaceHandle, PlayerVisibility } from './player'

/** Présente un lecteur YouTube isolé ; une pause confirmée précède son masquage. */
export function YouTubePlayer({ source, ref, onVisibility, initialStartMs, onImagesFailure }: {
  onImagesFailure: (message: string) => void
  source: VideoSource
  ref: Ref<PlayerSurfaceHandle>
  onVisibility: (state: PlayerVisibility) => void
  initialStartMs?: number
}) {
  const initialPosition = useRef(initialStartMs)
  const prepared = useRef(initialStartMs)
  const uncertain = useRef(false)
  const experienced = useRef(false)
  const stopPlayer = useRef<(() => void) | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<Player | null>(null)
  const failPlayer = useRef<((description: string) => void) | null>(null)
  const images = useRef(false)
  const pauseImages = useRef<(() => void) | null>(null)
  const conceal = useRef(false)
  const concealed = useRef(false)
  const concealTimer = useRef<number | undefined>(undefined)
  const [hidden, setHidden] = useState(false)
  const [hiding, setHiding] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [navigation, setNavigation] = useState(0)

  useLayoutEffect(() => {
    onVisibility({ hidden, hiding })
  }, [hidden, hiding, onVisibility])

  useLayoutEffect(() => {
    if (!navigation || !host.current) return
    // La commande et le réaffichage sont déjà commités. Seule la page défile,
    // jamais les panneaux internes ; aucun travail n'attend onReady.
    revealPlayer(host.current)
  }, [navigation])

  /** Confirme la pause sans perdre l’instance ; un échec rend la surface accessible. */
  async function prepareImages() {
    images.current = true
    const current = player.current
    // L'initialisation n'a aucun autoplay ; les callbacks protègent aussi un démarrage tardif.
    if (!current) return
    try {
      if (![1, 3].includes(current.getPlayerState())) return
      current.pauseVideo()
      if (![1, 3].includes(current.getPlayerState())) return
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          window.clearInterval(timer)
          pauseImages.current = null
          if (error) reject(error); else resolve()
        }
        const deadline = Date.now() + 1000
        // Interroger aussi l'état : son callback peut ne pas être livré.
        const timer = window.setInterval(() => {
          try {
            if (player.current !== current) finish(new Error('Le lecteur a changé pendant la pause. Réessayez Images.'))
            else if (![1, 3].includes(current.getPlayerState())) finish()
            else if (Date.now() >= deadline) finish(new Error('La pause YouTube n’a pas été confirmée. Réessayez Images ou mettez le lecteur en pause.'))
          } catch { finish(new Error('Impossible de confirmer la pause YouTube. Réessayez Images.')) }
        }, 50)
        pauseImages.current = () => finish(new Error('Ouverture Images interrompue.'))
      })
    } catch (error) {
      throw error instanceof Error ? error : new Error('Impossible de mettre YouTube en pause. Réessayez Images.')
    }
  }

  useImperativeHandle(ref, () => ({
    stop() { stopPlayer.current?.() },
    releaseImages() { images.current = false; pauseImages.current?.() },
    prepareImages,
    toggleVisibility: toggle,
    getTransferPosition() {
      if (uncertain.current || hiding) return { kind: 'uncertain' }
      try {
        const current = player.current
        if (prepared.current !== undefined) {
          // L'état interrogé peut précéder la livraison du callback correspondant.
          if (!current || [-1, 2, 5].includes(current.getPlayerState())) {
            return { kind: 'prepared', milliseconds: prepared.current }
          }
          prepared.current = undefined
          experienced.current = true
        }
        if (current && ready && [0, 1, 2].includes(current.getPlayerState())) {
          const milliseconds = Math.round(current.getCurrentTime() * 1000)
          if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) return { kind: 'confirmed', milliseconds }
          return { kind: 'uncertain' }
        }
        return { kind: !experienced.current && (!current || [-1, 5].includes(current.getPlayerState())) ? 'empty' : 'uncertain' }
      } catch { return { kind: 'uncertain' } }
    },
    getCurrentTimeMs() {
      const current = player.current
      if (!current || !ready || hiding || prepared.current !== undefined) {
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
        if (![-1, 0, 1, 2, 3, 5].includes(state)) {
          return 'Navigation non effectuée : état du lecteur inconnu. Réessayez lorsque le lecteur est prêt.'
        }
        // Une référence demande une navigation réelle ; seul paused conserve la pause.
        // Le départ sans lecture reste réservé à l'initialisation d'une bascule.
        prepared.current = undefined
        current.seekTo(seconds, true)
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
    setReady(false); setMessage(''); setAutoplayBlocked(false)

    /** Une initialisation en échec ne peut pas être réactivée par un événement tardif. */
    function fail(description: string) {
      if (disposed || failed) return
      failed = true
      uncertain.current = true
      prepared.current = undefined
      initialPosition.current = undefined
      window.clearTimeout(readyTimer)
      instance?.destroy()
      instance = null; player.current = null
      host.current?.replaceChildren()
      setReady(false); setMessage(description); setAutoplayBlocked(false)
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
      iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
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
          if (images.current) void prepareImages().catch(error => {
            if (images.current) onImagesFailure(error.message)
          })
        },
        onStateChange: event => {
          if (disposed || failed) return
          if (event.data === 1) setAutoplayBlocked(false)
          // La lecture ou le buffering rend l'ancien départ cued impropre au repli.
          if ([1, 3].includes(event.data)) {
            experienced.current = true
            prepared.current = undefined
          }
          // Les états admissibles rétablissent la lecture du temps courant, sans
          // chercher un accusé de fin de seek que l'API ne garantit pas.
          if ([0, 1, 2].includes(event.data)) uncertain.current = false
          if (images.current && [1, 3].includes(event.data)) {
            if (!pauseImages.current) void prepareImages().catch(error => {
              if (images.current) onImagesFailure(error.message)
            })
          }
          if (!conceal.current) return
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
        onAutoplayBlocked: () => {
          // Ce signal n'est pas garanti après seekTo : aucune détection de remplacement.
          if (disposed || failed) return
          setAutoplayBlocked(true)
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
      pauseImages.current?.()
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
      uncertain.current = true
      prepared.current = undefined
      initialPosition.current = undefined
      player.current = null
      concealed.current = true
      setHidden(true); setHiding(false)
      setAttempt(value => value + 1)
    }, 1_000)
  }

  return <div className="player-surface" hidden={hidden}>
      {message && <div role="alert"><p>{message}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer le lecteur</button></div>}
      <div className="youtube-frame" ref={host} />
      {!ready && !message && <p role="status">Chargement du lecteur YouTube…</p>}
      {autoplayBlocked && <p role="status">Le navigateur a bloqué le démarrage. Utilisez le bouton Lecture du lecteur.</p>}
    </div>
}
