import type { VideoSource } from './api'
import type { useVideoDownload } from './useVideoDownload'
import { LocalFileDetails } from './LocalFileDetails'
import { formatDuration, httpURL } from './videoPresentation'

/** Décrit seulement la source de travail ou son fichier, sans remplacer les autres sources de la fiche. */
export function PlayerInformation({ mode, source, download, onDelete, onDownload }: {
  mode: 'youtube' | 'local'
  source: VideoSource
  download: ReturnType<typeof useVideoDownload>
  onDelete: () => void
  onDownload: () => void
}) {
  if (mode === 'local') return <>
    <LocalFileDetails download={download} />
    {download.file ? <button className="button" disabled={download.busy} onClick={onDelete}>Supprimer le fichier local</button> :
      <button className="button" onClick={onDownload}>Gérer le téléchargement</button>}
  </>
  const url = httpURL(source.canonical_url)
  return <>
    <h2>Source YouTube</h2>
    <p className="source-title">{source.title || 'Titre non renseigné'}</p>
    <dl className="metadata">
      <dt>Identifiant externe</dt><dd>{source.external_id ?? 'Non renseigné'}</dd>
      <dt>Compte de publication</dt><dd>{source.publisher?.name ?? 'Non renseigné'}</dd>
      <dt>Durée</dt><dd>{source.duration_ms == null ? 'Inconnue' : formatDuration(source.duration_ms)}</dd>
    </dl>
    {url && <a href={url} target="_blank" rel="noopener noreferrer">Ouvrir la source ↗</a>}
    {source.description && <details><summary>Description</summary><p className="description">{source.description}</p></details>}
  </>
}
