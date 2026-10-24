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
      <div className="library-thumbnail">
        <VideoThumbnail source={source} />
        <span className="provider-badge">{providerLabel(source?.provider)}</span>
      </div>
      <div className="card-content">
        <h2>
          <Link className="card-link" to={`/videos/${video.id}`} aria-label={`Consulter : ${title}`}>
            {title}
          </Link>
        </h2>
        <p className="publisher">{publisher}</p>
        {video.tags.length > 0 && (
          <ul className="tags" aria-label="Tags">
            {video.tags.map((tag) => <li key={tag.id}>
              <Link to={'/?tag_id=' + tag.id}>{tag.name}</Link>
            </li>)}
          </ul>
        )}
      </div>
    </article>
  )
}
