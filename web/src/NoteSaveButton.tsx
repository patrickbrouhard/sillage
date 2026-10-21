import { useEffect, useState } from 'react'
import { IconButton } from './IconButton'
import type { NoteSession, NoteSnapshot } from './noteSession'

/** Présente les confirmations réelles sans changer la politique de sauvegarde de la session. */
export function NoteSaveButton({ session, state, status, onResolve }: {
  session: NoteSession
  state: NoteSnapshot
  status: string
  onResolve: () => void
}) {
  const [success, setSuccess] = useState(false)
  useEffect(() => {
    let seen = session.snapshot().confirmationCount
    let timer: number | undefined
    const clear = () => { window.clearTimeout(timer); setSuccess(false) }
    const unsubscribe = session.subscribe(() => {
      const current = session.snapshot()
      if (session.unconfirmed || current.phase !== 'ready') clear()
      if (current.confirmationCount === seen) return
      // confirm publie avant la libération de running : attendre la publication finale.
      // Une confirmation partielle est consommée sans coche, même si Undo suit ensuite.
      if (session.dirty || current.phase !== 'ready') {
        seen = current.confirmationCount
      } else if (!session.unconfirmed) {
        seen = current.confirmationCount
        window.clearTimeout(timer)
        setSuccess(true)
        timer = window.setTimeout(() => setSuccess(false), 5_000)
      }
    })
    return () => { unsubscribe(); window.clearTimeout(timer) }
  }, [session])

  const kind = state.phase === 'conflict' ? 'conflict'
    : state.phase === 'error' ? 'error'
    : state.phase === 'saving' ? 'saving'
    : session.unconfirmed ? 'pending'
    : success ? 'success' : 'idle'
  const icon = kind === 'conflict' ? 'conflict'
    : kind === 'error' ? 'clear'
    : kind === 'saving' ? 'spinner'
    : kind === 'success' ? 'check' : 'save'
  const label = kind === 'conflict' ? 'Résoudre le conflit de sauvegarde'
    : kind === 'error' ? 'Réessayer la sauvegarde' : 'Enregistrer la note'
  const confirmed = state.confirmed
    ? 'Dernier contenu confirmé : révision ' + state.confirmed.revision + ' · '
      + new Date(state.confirmed.updated_at).toLocaleString('fr-FR')
    : 'Aucune révision confirmée'
  return <span className="note-save">
    <IconButton icon={icon} label={label} tooltip={status + '. ' + confirmed}
      className={'note-save-' + kind} data-save-state={kind} aria-busy={kind === 'saving'}
      onClick={() => kind === 'conflict' ? onResolve() : void session.save(true)} />
  </span>
}
