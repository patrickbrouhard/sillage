import { useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router'
import { AuthenticationError } from './auth'
import { deleteVideo, DeletionError } from './deletionApi'
import type { NoteSession } from './noteSession'

/** Confirme l'abandon de la vidéo et du brouillon, puis réconcilie les réponses incertaines. */
export function DeleteVideo({ videoID, title, session, onPrepare, onRefused }: {
  videoID: number
  title: string
  session: NoteSession
  onPrepare: () => void
  onRefused: () => void
}) {
  const navigate = useNavigate()
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const active = useRef(false)
  const uncertain = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [unknown, setUnknown] = useState(false)

  async function remove() {
    if (active.current) return
    active.current = true
    setBusy(true)
    setMessage('')
    try {
      await session.suspendForDeletion()
      onPrepare()
      const result = await deleteVideo(videoID)
      // Le garde de navigation observe l'abandon explicite avant le changement de route.
      flushSync(() => session.confirmDeletion())
      dialog.current?.close()
      navigate('/', { replace: true, state: { videoDeletion: { id: videoID, pending: result === 'pending' } } })
    } catch (error) {
      if (!uncertain.current && (error instanceof DeletionError || error instanceof AuthenticationError)) {
        session.resumeAfterDeletionRefused()
        onRefused()
        setMessage(error.message)
      } else {
        // Un refus ultérieur ne résout pas une première réponse perdue : conserver la suspension.
        uncertain.current = true
        setUnknown(true)
        setMessage('Réponse incertaine. Votre brouillon reste en mémoire et l’autosauvegarde est suspendue. Vérifiez et réessayez la même suppression pour confirmer son résultat.')
      }
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  return <section className="video-deletion" aria-labelledby="video-deletion-title">
    <h2 id="video-deletion-title">Suppression définitive</h2>
    <p>Supprimer cette vidéo et ses données associées de Sillage.</p>
    <button ref={trigger} className="button danger" onClick={() => {
      setMessage('')
      dialog.current?.showModal()
    }}>Supprimer la vidéo</button>
    <dialog ref={dialog} className="tag-dialog video-delete-dialog" aria-labelledby="confirm-video-deletion"
      onCancel={event => { if (busy || unknown) event.preventDefault() }}
      onClose={() => trigger.current?.focus()}>
      <h2 id="confirm-video-deletion">Supprimer définitivement cette vidéo ?</h2>
      <p><strong>{title}</strong></p>
      <p>La note, les transcriptions, les captures, les médias locaux et les points de reprise seront supprimés. Cette action est irréversible, sans corbeille.</p>
      <p>Les tags, comptes de publication et personnes sont conservés. Les références dans les autres notes ne seront pas modifiées et peuvent devenir invalides.</p>
      {(session.unconfirmed || snapshot.phase === 'conflict') && <p>Votre brouillon local et les modifications non confirmées seront également abandonnés après confirmation de la suppression.</p>}
      {message && <p role="alert">{message}</p>}
      {busy && <p role="status">Suppression en cours…</p>}
      <div className="download-actions">
        <button className="button" autoFocus disabled={busy || unknown} onClick={() => dialog.current?.close()}>Annuler</button>
        <button className="button danger" disabled={busy} onClick={() => void remove()}>
          {unknown ? 'Vérifier et réessayer' : 'Supprimer définitivement'}
        </button>
      </div>
    </dialog>
  </section>
}
