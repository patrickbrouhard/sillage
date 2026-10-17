import type { useVideoDownload } from './useVideoDownload'
import { formatDuration } from './videoPresentation'

/** Décrit la représentation locale de la source de travail, distincte de sa provenance. */
export function LocalFileDetails({ download }: { download: ReturnType<typeof useVideoDownload> }) {
  const { file, state, error } = download
  return <section className="source-section" aria-labelledby="local-file-title">
    <h2 id="local-file-title">Fichier local</h2>
    <p className="muted">Représentation conservée de la source de travail</p>
    {file ? <>
      {error && <p className="error">Disponibilité non confirmée. Métadonnées enregistrées :</p>}
      <dl className="metadata">
        <dt>Conteneur</dt><dd>{file.format.toUpperCase()}</dd>
        <dt>Taille</dt><dd>{(file.size / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mio</dd>
        <dt>Dimensions encodées</dt><dd>{file.width != null && file.height != null ? file.width + ' × ' + file.height : 'Inconnues'}</dd>
        <dt>Cadence moyenne</dt><dd>{file.fps != null ? file.fps.toLocaleString('fr-FR', { maximumFractionDigits: 3 }) + ' images/s' : 'Inconnue'}</dd>
        <dt>Codec vidéo</dt><dd>{file.video_codec ?? 'Inconnu'}</dd>
        <dt>Codec audio</dt><dd>{file.audio_codec ?? 'Inconnu'}</dd>
        <dt>Langue audio déclarée</dt><dd>{file.audio_language ?? 'Inconnue'}</dd>
        <dt>Durée</dt><dd>{formatDuration(file.duration_ms)}</dd>
      </dl>
    </> : <p>{error ? 'Consultation du fichier impossible.' :
      state?.status === 'downloading' ? 'Acquisition en cours.' :
      state ? 'Aucun fichier local conservé.' : 'Consultation en cours…'}</p>}
  </section>
}
