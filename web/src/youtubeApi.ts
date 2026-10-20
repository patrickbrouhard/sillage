/** Surface officielle utilisée par le lecteur, sans abstraction de fournisseurs. */
export interface YouTubePlayer {
  /** Lit la position courante en secondes sans agir sur la lecture. */
  getCurrentTime(): number
  /** Déplace la lecture ; seul l'état paused garantit l'absence de démarrage. */
  seekTo(seconds: number, allowSeekAhead: boolean): void
  /** Prépare un départ sans lancer la vidéo, notamment depuis un état cued ou ended. */
  cueVideoById(options: { videoId: string; startSeconds: number }): void
  /** Suspend la lecture sans changer volontairement la position. */
  pauseVideo(): void
  /** Retourne l'état natif pour confirmer l'arrêt avant de masquer l'iframe. */
  getPlayerState(): number
  /** Supprime le lecteur et interrompt toute activité média restante. */
  destroy(): void
}

/** Événements nécessaires au cycle de vie du lecteur YouTube. */
export interface YouTubeOptions {
  events: {
    onReady: (event: { target: YouTubePlayer }) => void
    onStateChange: (event: { target: YouTubePlayer; data: number }) => void
    /** Signale un blocage de lecture scriptée, sans garantie pour chaque seekTo. */
    onAutoplayBlocked: (event: { target: YouTubePlayer }) => void
    onError: (event: { data: number }) => void
  }
}

/** Constructeur officiel appliqué à une iframe créée avec origine et referrer explicites. */
export interface YouTubeAPI {
  Player: new (element: HTMLIFrameElement, options: YouTubeOptions) => YouTubePlayer
}

declare global {
  interface Window {
    YT?: YouTubeAPI
    onYouTubeIframeAPIReady?: () => void
  }
}

let loading: Promise<YouTubeAPI> | undefined

/** Partage le chargement entre montages React et permet un nouvel essai après échec. */
export function loadYouTubeAPI(): Promise<YouTubeAPI> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (loading) return loading
  loading = new Promise<YouTubeAPI>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    let finished = false
    const previous = window.onYouTubeIframeAPIReady
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous
      script.onerror = null
      if (error) { script.remove(); reject(error) }
      else resolve(window.YT!)
    }
    const ready = () => {
      if (window.YT?.Player) finish()
      else finish(new Error('L’API YouTube n’a pas pu être initialisée.'))
      previous?.()
    }
    const timer = window.setTimeout(() => finish(new Error('Le chargement de l’API YouTube est trop long.')), 15_000)
    window.onYouTubeIframeAPIReady = ready
    script.onerror = () => finish(new Error('Impossible de charger l’API YouTube. Vérifiez la connexion ou les blocages du navigateur.'))
    document.head.append(script)
  }).catch(error => { loading = undefined; throw error })
  return loading
}
