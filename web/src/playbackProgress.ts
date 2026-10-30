/** Observation indépendante des positions annotables et des départs préparés. */
export interface PlaybackObservation {
  positionMs: number | null
  durationMs: number | null
  rate: number
  state: 'playing' | 'paused' | 'waiting' | 'ended' | 'unavailable'
}

/** Motif local ; les arrêts n'impliquent jamais une fin naturelle. */
export type PlaybackReason = 'sample' | 'seek' | 'stop' | 'reset'
/** Reçoit uniquement les observations de la surface encore vivante. */
export type PlaybackObserver = (sample: PlaybackObservation, reason?: PlaybackReason) => void

/** Politique déterministe : undefined ne décide rien, null efface le point de reprise. */
export class PlaybackProgress {
  private previous?: PlaybackObservation & { at: number }
  private qualifiedMs = 0
  private activeMs = 0
  private candidate?: number
  private restored = false
  private advanced = false
  private completed = false
  private anchor?: number

  /** Prépare l'exception de fin naturelle sans qualifier le temps restauré. */
  restore(position: number | null) {
    this.restored = position !== null
    this.anchor = position ?? undefined
  }

  /** Invalide la qualification sans toucher aux contrats de navigation du lecteur. */
  seek() {
    this.previous = undefined
    this.qualifiedMs = 0
    this.candidate = undefined
    this.restored = false
    this.advanced = false
    this.completed = false
    this.anchor = undefined
  }

  /** Repart sans crédit de lecture après désactivation, erreur ou suspension d'accès. */
  reset() {
    this.seek()
    this.activeMs = 0
  }

  /** Conserve la qualification seulement si un départ transférable existe. */
  transfer(position?: number) {
    if (position === undefined) this.reset()
    this.previous = undefined
    this.candidate = undefined
    this.anchor = position
    // Une surface préparée ne doit pas confirmer une nouvelle progression à elle seule.
    this.advanced = false
  }

  /** Observe le temps écoulé ; un intervalle aveugle ne devient pas du visionnage. */
  observe(sample: PlaybackObservation, at: number): number | null | undefined {
    const position = sample.positionMs
    if (position === null || !Number.isSafeInteger(position) || position < 0) {
      // Garder un repère pour vérifier la continuité au retour, sans créditer l'intervalle
      // inconnu ni écraser un départ déjà préparé par restauration ou transfert.
      this.anchor ??= this.previous?.positionMs ?? undefined
      this.previous = undefined
      this.candidate = undefined
      return
    }
    if (this.anchor !== undefined) {
      if (Math.abs(position - this.anchor) > 1500) this.seek()
      this.anchor = undefined
    }
    const previous = this.previous
    let elapsed = previous ? at - previous.at : 0
    if (previous && (elapsed < 0 || elapsed > 2500)) {
      // Après gel de l'onglet, ni continuité ni durée active ne sont démontrées.
      this.reset()
      elapsed = 0
    } else if (previous && previous.positionMs !== null) {
      const delta = position - previous.positionMs
      const expected = previous.state === 'playing' ? elapsed * previous.rate : 0
      // YouTube ne signale pas les seeks natifs : cette tolérance accepte sa précision
      // sans prétendre détecter les petits déplacements entre deux observations.
      if (delta < -250 || delta > expected + Math.max(1500, expected * 0.35)) {
        this.seek()
      } else if (!this.completed && previous.state === 'playing' && ['playing', 'paused', 'ended'].includes(sample.state) &&
          delta > 0 && sample.rate === previous.rate && previous.rate > 0) {
        const active = Math.min(elapsed, delta / previous.rate)
        this.qualifiedMs += active
        this.activeMs += active
        if (active > 0) this.advanced = true
      }
    }
    this.previous = { ...sample, at }
    const admissible = ['playing', 'paused', 'ended'].includes(sample.state)
    this.candidate = admissible && this.advanced && this.qualifiedMs >= 5000 ? position : undefined
    if (this.completed) return

    const duration = sample.durationMs
    const nearEnd = admissible && duration !== null && Number.isFinite(duration) &&
      duration > 0 && position >= duration - Math.min(10000, duration * 0.05)
    const qualifiedEnd = this.candidate !== undefined && (sample.state === 'ended' || nearEnd)
    const restoredEnd = sample.state === 'ended' && this.restored && this.advanced
    if (qualifiedEnd || restoredEnd) {
      this.completed = true
      this.candidate = undefined
      this.activeMs = 0
      return null
    }
    if (sample.state === 'paused' || this.activeMs >= 10000) return this.flush()
  }

  /** Prélève uniquement une position qualifiée encore admissible, jamais une cible. */
  flush(): number | undefined {
    if (this.completed || this.candidate === undefined) return
    this.activeMs = 0
    return this.candidate
  }
}

/** Sérialise les écritures normales et remplace le seul instantané en attente. */
export class PlaybackWrites {
  private running = false
  private pending: number | null | undefined
  private last: number | null | undefined
  private accepting = true

  /** Injecte le transport pour vérifier les courses sans dépendre du navigateur. */
  constructor(
    private readonly send: (position: number | null, keepalive: boolean) => Promise<void>,
    private readonly report: (failed: boolean) => void,
  ) {}

  /** Coupe les décisions futures ; une requête déjà partie peut encore se terminer. */
  enable(enabled: boolean) {
    this.accepting = enabled
    if (!enabled) this.pending = undefined
  }

  /** Ne rejoue pas un résultat incertain ; une nouvelle observation peut le remplacer. */
  submit(position: number | null | undefined, keepalive = false) {
    if (!this.accepting || position === undefined) return
    if (position === this.last && (!keepalive || this.pending !== position)) return
    this.last = position
    if (keepalive) {
      this.pending = undefined
      void this.send(position, true).catch(() => {})
      return
    }
    this.pending = position
    if (!this.running) void this.drain()
  }

  /** Tente la sortie du seul instantané non encore envoyé, sans rejouer celui en vol. */
  finish() {
    this.submit(this.pending, true)
  }

  /** Une erreur abandonne le lot en attente au lieu de le rejouer aveuglément. */
  private async drain() {
    this.running = true
    while (this.accepting && this.pending !== undefined) {
      const position = this.pending
      this.pending = undefined
      try {
        await this.send(position, false)
        this.report(false)
      } catch {
        this.pending = undefined
        this.report(true)
        break
      }
    }
    this.running = false
  }
}
