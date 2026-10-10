import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { Tag } from './api'
import { TagEditor } from './TagEditor'

interface Props {
  videoID: number
  tags: Tag[]
  onChange: (tags: Tag[]) => void
}

/** Présente les liens de classement et héberge provisoirement l'éditeur dans un dialogue natif. */
export function VideoTags({ videoID, tags, onChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [active, setActive] = useState(false)
  const close = useCallback(() => {
    dialog.current?.close()
    setActive(false)
    trigger.current?.focus()
  }, [])

  return (
    <section className="video-tags" aria-label="Classement de la vidéo">
      {tags.length ? <ul className="tags detail-tags" aria-label="Tags de la vidéo">
        {tags.map((tag) => <li key={tag.id}>
          <Link to={`/?tag_id=${tag.id}`}>{tag.name}</Link>
        </li>)}
      </ul> : <p className="muted">Aucun tag associé à cette vidéo.</p>}
      <button className="button" ref={trigger} onClick={() => {
        dialog.current?.showModal()
        setActive(true)
      }}>{tags.length ? 'Gérer les tags' : 'Ajouter des tags'}</button>
      <dialog ref={dialog} className="tag-dialog" aria-labelledby="tag-dialog-title"
        onCancel={(event) => { event.preventDefault(); close() }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          // Boucler localement évite de perdre le focus vers la barre du navigateur.
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          )].filter((element) => element.getClientRects().length)
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}>
        <div className="dialog-heading">
          <h2 id="tag-dialog-title">Gérer les tags</h2>
          <button className="button" onClick={close} autoFocus>Fermer</button>
        </div>
        <TagEditor videoID={videoID} tags={tags} active={active} onChange={onChange} />
      </dialog>
    </section>
  )
}
