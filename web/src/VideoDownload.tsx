import { useRef } from 'react'
import { IconButton } from './IconButton'
import { downloadMessage } from './mediaApi'
import type { MediaFile } from './mediaApi'
import type { useVideoDownload } from './useVideoDownload'
import { formatDuration } from './videoPresentation'

/** Présente les commandes sans posséder une deuxième consultation de l'état. */
export function VideoDownload({ download, beforeDelete }: { download: ReturnType<typeof useVideoDownload>; beforeDelete?: (file: MediaFile) => void }) {
  const { state, error, busy, file, load, mutate } = download
  const dialog = useRef<HTMLDialogElement>(null)
  const deletion = useRef<MediaFile | null>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const status = state?.status
  return <div className="video-download" aria-label="Téléchargement local">
    <p className="download-summary" role="status" aria-live="polite">
      {busy ? 'Opération en cours…' : error && !state ? 'État du fichier local indisponible.' :
        status === 'downloading' ? 'Téléchargement en cours sur le serveur…' :
        status === 'available' ? `${file!.format.toUpperCase()} · ${(file!.size / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mio · ${formatDuration(file!.duration_ms)}` :
        status === 'failed' ? 'Échec du téléchargement.' :
        status === 'not_downloaded' ? '' : 'Consultation du fichier local…'}
    </p>
    <div className="download-actions">
      {(status === 'not_downloaded' || status === 'failed') &&
        <IconButton icon="download" disabled={busy} onClick={() => { void mutate() }}
          label={status === 'failed' ? 'Réessayer le téléchargement' : 'Télécharger le fichier local'} />}
      {file && <IconButton icon="trash" label="Supprimer le fichier local" ref={removeButton} disabled={busy} onClick={() => {
        deletion.current = file
        dialog.current?.showModal()
      }} />}
      {error && <IconButton icon="refresh" label="Actualiser l’état" disabled={busy} onClick={() => { void load() }} />}
    </div>
    {state?.error && <p className="error" role="alert">{downloadMessage(state.error.code)}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <dialog ref={dialog} className="tag-dialog" aria-labelledby="delete-media-title"
      onClose={() => removeButton.current?.focus()}>
      <h2 id="delete-media-title">Supprimer le fichier local ?</h2>
      <p>La vidéo, les notes, les transcriptions et les captures restent conservées. Seul le fichier média local sera supprimé.</p>
      <div className="download-actions">
        <button className="button" autoFocus onClick={() => dialog.current?.close()}>Annuler</button>
        <button className="button" onClick={() => {
          const target = deletion.current
          dialog.current?.close()
          if (target) { beforeDelete?.(target); void mutate(target) }
        }}>Confirmer la suppression</button>
      </div>
    </dialog>
  </div>
}
