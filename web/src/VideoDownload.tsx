import { useId, useRef } from 'react'
import type { Ref } from 'react'
import { downloadMessage } from './mediaApi'
import type { useVideoDownload } from './useVideoDownload'

/** Fenêtre unique de conservation : une incertitude ne devient jamais un POST implicite. */
export function VideoDownload({ download, ref, onClose, onDelete }: {
  download: ReturnType<typeof useVideoDownload>
  ref: Ref<HTMLDialogElement>
  onClose: () => void
  onDelete: () => void
}) {
  const { state, error, busy, file, load, mutate } = download
  const titleID = useId()
  const element = useRef<HTMLDialogElement | null>(null)
  const status = state?.status
  return <dialog ref={node => {
    element.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }} className="tag-dialog media-dialog" aria-labelledby={titleID} onClose={onClose}>
    <h2 id={titleID}>Fichier local</h2>
    {error ? <p role="alert">{error}</p> :
      status === 'available' ? <p>Le fichier local est disponible. Fermez cette fenêtre puis sélectionnez Local pour le regarder.</p> :
      status === 'downloading' ? <p role="status">Téléchargement en cours sur le serveur…</p> :
      status === 'failed' ? <p role="alert">{downloadMessage(state!.error!.code)}</p> :
      status === 'not_downloaded' ? <p>Télécharger cette vidéo pour la conserver et la regarder dans Sillage ? Le lecteur actuel restera inchangé.</p> :
      <p role="status">Consultation du fichier local…</p>}
    <div className="download-actions">
      <button className="button" autoFocus onClick={() => element.current?.close()}>
        {!error && (status === 'not_downloaded' || status === 'failed') ? 'Annuler' : 'Fermer'}
      </button>
      {!error && (status === 'not_downloaded' || status === 'failed') &&
        <button className="button" disabled={busy} onClick={() => {
          // Le hook verrouille la mutation synchroniquement ; fermer ne signifie pas succès.
          void mutate()
          element.current?.close()
        }}>{status === 'failed' ? 'Réessayer le téléchargement' : 'Télécharger le fichier local'}</button>}
      {error && <button className="button" disabled={busy} onClick={() => { void load() }}>Actualiser l’état</button>}
      {file && error && <button className="button" disabled={busy} onClick={onDelete}>Supprimer le fichier local</button>}
    </div>
  </dialog>
}
