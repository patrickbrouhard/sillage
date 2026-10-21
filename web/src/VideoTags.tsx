import { useCallback, useRef, useState } from 'react'
import type { Tag } from './api'
import { TagEditor } from './TagEditor'
import { IconButton } from './IconButton'
import { VideoTagList } from './VideoTagList'

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
    <section className="video-tags" data-empty={tags.length === 0} aria-label="Classement de la vidéo">
      <VideoTagList tags={tags} onRestoreFocus={() => trigger.current?.focus({ preventScroll: true })} />
      <IconButton icon="tags" label={tags.length ? 'Gérer les tags' : 'Ajouter des tags'} ref={trigger} onClick={() => {
        dialog.current?.showModal()
        setActive(true)
      }} />
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
