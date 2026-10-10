import { useState } from 'react'
import type { Video } from './api'

/** N'accepte que des images distantes HTTP(S), jamais une URL exécutable. */
function thumbnailURL(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Formate une durée connue en secondes, sans confondre zéro et absence. */
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Présente la première source sans lui attribuer un statut métier principal. */
export function VideoCard({ video }: { video: Video }) {
  const source = video.sources[0]
  const thumbnail = thumbnailURL(source?.thumbnail_url)
  const [failedURL, setFailedURL] = useState<string | null>(null)
  const provider = source?.provider === 'youtube' ? 'YouTube' : source?.provider
  const publisher = source?.publisher
    ? source.publisher.name ?? 'Compte de publication sans nom'
    : 'Compte de publication non renseigné'

  return (
    <article className="video-card">
      <div className="thumbnail">
        {thumbnail && failedURL !== thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedURL(thumbnail)}
          />
        ) : (
          <div className="thumbnail-placeholder">
            <span className="placeholder-mark" aria-hidden="true">▷</span>
            <span>Aucun aperçu disponible</span>
          </div>
        )}
        {source?.duration_ms != null && (
          <span className="duration" aria-label={`Durée : ${formatDuration(source.duration_ms)}`}>
            {formatDuration(source.duration_ms)}
          </span>
        )}
      </div>
      <div className="card-content">
        <p className="source-label">{provider || 'Source non renseignée'}</p>
        <h2>{source?.title || 'Vidéo sans titre'}</h2>
        <p className="publisher">{publisher}</p>
        {video.tags.length > 0 ? (
          <ul className="tags" aria-label="Tags">
            {video.tags.map((tag) => <li key={tag.id}>{tag.name}</li>)}
          </ul>
        ) : (
          <p className="no-tags">Aucun tag</p>
        )}
      </div>
    </article>
  )
}
