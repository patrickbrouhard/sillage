import { getNote, NoteError, putNote } from './noteApi'
import type { Note } from './noteApi'

type Phase = 'loading' | 'ready' | 'saving' | 'error' | 'conflict'

/** État visible d'une session ; remote undefined signifie que la relecture reste nécessaire. */
export interface NoteSnapshot {
  loaded: boolean
  content: string
  confirmed: Note | null
  phase: Phase
  message: string
  remote: Note | null | undefined
  editorVersion: number
}

interface Sent { content: string; revision: number }

/** Compare et édite en LF sans réécrire les anciennes notes lors de leur lecture. */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

/** Pilote une seule note en mémoire, sans cache persistant ni synchronisation entre onglets. */
export class NoteSession {
  private state: NoteSnapshot = {
    loaded: false, content: '', confirmed: null, phase: 'loading', message: '',
    remote: undefined, editorVersion: 0,
  }
  private listeners = new Set<() => void>()
  private lifetime = new AbortController()
  private running: Promise<void> | null = null
  private uncertain: Sent | null = null
  private idleTimer: number | undefined
  private maxTimer: number | undefined
  private firstPending: number | null = null
  private conflictRead = 0

  /** Associe définitivement la session à une vidéo. */
  constructor(private readonly videoID: number) {}

  /** Fournit un instantané stable pour useSyncExternalStore. */
  snapshot = () => this.state

  /** S'abonne uniquement aux changements de cette note. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<NoteSnapshot>) {
    this.state = { ...this.state, ...change }
    this.listeners.forEach(listener => listener())
  }

  /** Indique si le texte local diffère du dernier contenu confirmé. */
  get dirty() { return this.state.content !== normalizeLineEndings(this.state.confirmed?.content_md ?? '') }

  /** Une écriture incertaine reste à protéger, même après Undo vers le texte précédent. */
  get unconfirmed() { return this.dirty || this.uncertain !== null || this.running !== null || this.state.phase === 'saving' || this.state.phase === 'conflict' }

  /** Charge la note ; un échec ne crée jamais de document éditable. */
  async start() {
    this.lifetime = new AbortController()
    const lifetime = this.lifetime
    this.publish({ phase: 'loading', message: '' })
    try {
      const note = await getNote(this.videoID, this.signal())
      if (lifetime.signal.aborted) return
      this.publish({ loaded: true, content: normalizeLineEndings(note?.content_md ?? ''), confirmed: note, phase: 'ready' })
    } catch {
      if (!lifetime.signal.aborted) this.publish({ phase: 'error', message: 'Impossible de charger la note.' })
    }
  }

  /** Annule les temporisations et ignore les réponses d'une fiche quittée. */
  stop() { this.lifetime.abort(); this.clearTimers() }

  private signal() {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12_000)])
  }

  private clearTimers() {
    window.clearTimeout(this.idleTimer); window.clearTimeout(this.maxTimer)
  }

  /** Reçoit le texte exact produit par CodeMirror, sans réinitialiser le délai maximal. */
  change = (content: string) => {
    if (content === this.state.content) return
    this.publish({ content })
    if (this.firstPending === null) this.firstPending = Date.now()
    this.schedule()
  }

  private schedule() {
    this.clearTimers()
    if (!this.dirty) { this.firstPending = null; return }
    if (this.lifetime.signal.aborted || ['error', 'conflict'].includes(this.state.phase)) return
    this.firstPending ??= Date.now()
    this.idleTimer = window.setTimeout(() => { void this.save() }, 2_000)
    this.maxTimer = window.setTimeout(() => { void this.save() }, Math.max(0, 20_000 - (Date.now() - this.firstPending)))
  }

  /** Sérialise les demandes ; un Ctrl+S pendant une écriture prend ensuite le texte le plus récent. */
  save = async (explicit = false): Promise<void> => {
    if (!this.state.loaded || this.lifetime.signal.aborted || this.state.phase === 'conflict') return
    if (this.running) {
      await this.running
      if (this.state.phase === 'ready' && this.dirty) return this.save()
      return
    }
    // Un enregistrement explicite peut normaliser une ancienne note sans modification visible.
    // Une simple lecture, un Undo ou un départ de fiche ne déclenchent pas cette écriture.
    const explicitWrite = explicit && (!this.state.confirmed || this.state.confirmed.content_md !== this.state.content)
    if (!this.dirty && !this.uncertain && !explicitWrite) return
    this.clearTimers()
    const sent = this.uncertain ?? { content: this.state.content, revision: this.state.confirmed?.revision ?? 0 }
    // Les modifications suivantes ont leur propre échéance de 20 secondes.
    this.firstPending = null
    this.publish({ phase: 'saving', message: '' })
    this.running = this.write(sent)
    try { await this.running } finally {
      this.running = null
      if (!this.lifetime.signal.aborted) { this.publish({}); this.schedule() }
    }
  }

  private async pause(ms: number) {
    const signal = this.lifetime.signal
    await new Promise<void>(resolve => {
      const finish = () => { window.clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
      const timer = window.setTimeout(finish, ms)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private confirm(note: Note) {
    this.uncertain = null
    // Ne jamais réinjecter la réponse dans CodeMirror : la saisie peut avoir avancé.
    this.publish({ confirmed: note, phase: 'ready', message: '', remote: undefined })
  }

  private async write(sent: Sent) {
    const lifetime = this.lifetime
    for (let attempt = 0; attempt < 3; attempt++) {
      if (lifetime.signal.aborted) return
      try {
        if (this.uncertain) {
          const remote = await getNote(this.videoID, this.signal())
          if (lifetime.signal.aborted) return
          if (remote && remote.content_md === sent.content) { this.confirm(remote); return }
          if ((remote?.revision ?? 0) !== sent.revision) {
            this.uncertain = null
            this.publish({ phase: 'conflict', remote, message: 'Conflit : la version serveur diffère du texte envoyé.' })
            return
          }
          // La même précondition reste valide ; une ancienne requête tardive ne pourra pas l'écraser.
          this.uncertain = null
        }
        const saved = await putNote(this.videoID, sent.content, sent.revision, this.signal())
        if (lifetime.signal.aborted) return
        this.confirm(saved)
        return
      } catch (error) {
        if (lifetime.signal.aborted) return
        if (error instanceof NoteError && error.status === 409) {
          this.uncertain = null
          this.publish({ phase: 'conflict', message: error.message, remote: undefined })
          await this.readConflict()
          return
        }
        if (error instanceof NoteError && error.status >= 400 && error.status < 500) {
          this.publish({ phase: 'error', message: error.message })
          return
        }
        // Un échec de transport ou un 5xx ne prouve pas que le PUT n'a pas été commité.
        this.uncertain = sent
        if (attempt < 2) await this.pause(attempt === 0 ? 1_000 : 3_000)
      }
    }
    if (!lifetime.signal.aborted) this.publish({
      phase: 'error',
      message: 'Sauvegarde non confirmée après deux réessais. Votre texte reste ici ; réessayez pour vérifier le serveur.',
    })
  }

  /** Relit la version distante sans toucher au brouillon ni autoriser une écriture. */
  async readConflict() {
    const request = ++this.conflictRead
    const lifetime = this.lifetime
    try {
      const remote = await getNote(this.videoID, this.signal())
      if (!lifetime.signal.aborted && request === this.conflictRead && this.state.phase === 'conflict') this.publish({ remote })
    } catch {
      if (!lifetime.signal.aborted && request === this.conflictRead && this.state.phase === 'conflict') this.publish({ message: 'Conflit : impossible de relire la version serveur. Votre texte est conservé.' })
    }
  }

  /** Abandon explicite du brouillon en faveur de la version effectivement présentée. */
  useServer = () => {
    const remote = this.state.remote
    if (this.state.phase !== 'conflict' || remote === undefined) return
    this.clearTimers(); this.uncertain = null; this.firstPending = null
    this.publish({
      content: normalizeLineEndings(remote?.content_md ?? ''), confirmed: remote, phase: 'ready', message: '',
      remote: undefined, editorVersion: this.state.editorVersion + 1,
    })
  }

  /** Autorise seulement la révision consultée ; une nouvelle concurrence provoque un nouveau conflit. */
  keepLocal = async () => {
    if (this.state.phase !== 'conflict' || this.state.remote === undefined) return
    this.uncertain = null
    this.publish({ confirmed: this.state.remote, remote: undefined, phase: 'ready', message: '' })
    await this.save(true)
  }

  /** Attend toutes les modifications courantes, sans quitter sur une simple confirmation partielle. */
  async flush(): Promise<boolean> {
    do {
      await this.save()
      if (this.lifetime.signal.aborted || ['error', 'conflict'].includes(this.state.phase)) return false
    } while (this.dirty || this.running)
    return !this.unconfirmed
  }
}
