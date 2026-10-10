import { Link } from 'react-router'
import type { Video } from './api'
import { VideoThumbnail } from './VideoThumbnail'
import { providerLabel } from './videoPresentation'

/** Présente la première source sans lui attribuer un statut métier principal. */
export function VideoCard({ video }: { video: Video }) {
  const source = video.sources[0]
  const title = source?.title || 'Vidéo sans titre'
  const publisher = source?.publisher
    ? source.publisher.name ?? 'Compte de publication sans nom'
    : 'Compte de publication non renseigné'

  return (
    <article className="video-card">
      <Link className="card-link" to={`/videos/${video.id}`} aria-label={`Consulter : ${title}`}>
        <VideoThumbnail source={source} />
        <div className="card-content">
          <p className="source-label">{providerLabel(source?.provider)}</p>
          <h2>{title}</h2>
          <p className="publisher">{publisher}</p>
          {video.tags.length > 0 ? (
            <ul className="tags" aria-label="Tags">
              {video.tags.map((tag) => <li key={tag.id}>{tag.name}</li>)}
            </ul>
          ) : (
            <p className="no-tags">Aucun tag</p>
          )}
        </div>
      </Link>
    </article>
  )
}
