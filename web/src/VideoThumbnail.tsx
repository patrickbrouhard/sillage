import { useState } from 'react'
import type { VideoSource } from './api'
import { formatDuration, httpURL } from './videoPresentation'

/** Partage l'aperçu et son repli entre carte et fiche, sans charger de lecteur. */
export function VideoThumbnail({ source }: { source?: VideoSource }) {
  const thumbnail = httpURL(source?.thumbnail_url)
  const [failedURL, setFailedURL] = useState<string | null>(null)

  return (
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
  )
}
