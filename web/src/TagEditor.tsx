import { useEffect, useId, useRef, useState } from 'react'
import { addTag, errorMessage, getVideo, removeTag } from './api'
import type { Tag } from './api'
import { useTagCatalog } from './useTagCatalog'

interface Props {
  videoID: number
  tags: Tag[]
  active: boolean
  onChange: (tags: Tag[]) => void
}

/** Classe une vidéo indépendamment du conteneur visuel, avec écritures successives. */
export function TagEditor({ videoID, tags, active, onChange }: Props) {
  const catalog = useTagCatalog(active)
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController | null>(null)
  const shouldFocus = useRef(false)
  const listID = useId()
  const inputID = useId()
  const query = text.trim()
  // Ce rapprochement sert uniquement aux suggestions ; Go reste maître de l'identité.
  const matchText = (value: string) => value.normalize('NFC').toLocaleLowerCase('fr')
  const alreadyAssigned = tags.some((tag) => matchText(tag.name) === matchText(query))
  const matches = catalog.tags.filter((tag) =>
    !tags.some((assigned) => assigned.id === tag.id) &&
    matchText(tag.name).includes(matchText(query)),
  ).sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  const options = query ? matches.map((tag) => ({ name: tag.name, label: tag.name })) : []
  if (query && !alreadyAssigned && !matches.some((tag) => matchText(tag.name) === matchText(query))) {
    options.push({ name: query, label: `Ajouter « ${query} »` })
  }
  const open = expanded && options.length > 0 && !busy

  useEffect(() => () => {
    operation.current?.abort()
    operation.current = null
  }, [])
  useEffect(() => {
    if (!busy && shouldFocus.current) {
      shouldFocus.current = false
      // Ne pas déplacer le focus si le conteneur a été fermé pendant l'écriture.
      if (input.current?.getClientRects().length) input.current.focus()
    }
  }, [busy])
  useEffect(() => {
    if (open && selected >= 0) document.getElementById(`${listID}-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, selected, listID])

  // À chaque réouverture, relire les associations pour retrouver les changements externes.
  useEffect(() => {
    if (active) void mutate('refresh')
    // La lecture dépend de l'ouverture ; onChange ne doit pas relancer une mutation.
  }, [active])

  /** Sérialise aussi les relectures pour ne pas appliquer un instantané périmé. */
  async function mutate(kind: 'add' | 'remove' | 'refresh', name = '', tagID = 0) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    setNotice('')
    setExpanded(false)
    let removed = false
    try {
      if (kind === 'add') {
        const result = await addTag(videoID, name, controller.signal)
        if (controller.signal.aborted) return
        onChange(result)
        setText('')
        setSelected(-1)
        setNotice('Associations enregistrées.')
        catalog.refresh()
      } else {
        if (kind === 'remove') {
          await removeTag(videoID, tagID, controller.signal)
          removed = true
          if (controller.signal.aborted) return
          onChange(tags.filter((tag) => tag.id !== tagID))
        }
        const video = await getVideo(String(videoID), controller.signal)
        if (controller.signal.aborted) return
        onChange(video.tags)
        setNotice(kind === 'remove' ? 'Tag retiré de cette vidéo.' : 'Associations actualisées.')
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(removed
          ? 'Le retrait est enregistré, mais la relecture a échoué. Actualisez les associations.'
          : errorMessage(reason, kind === 'refresh'
            ? 'Impossible de relire les associations. Les données affichées sont conservées.'
            : 'La réponse du serveur est indisponible. L’opération a peut-être abouti ; actualisez les associations avant de réessayer.'))
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null
        shouldFocus.current = true
        setBusy(false)
      }
    }
  }

  return (
    <div className="tag-editor">
      <p className="muted">Les modifications sont enregistrées immédiatement. Retirer un tag ne le supprime pas du catalogue.</p>
      {tags.length ? (
        <ul className="tag-associations" aria-label="Associations de tags">
          {tags.map((tag) => <li key={tag.id}>
            <span>{tag.name}</span>
            <button className="button" disabled={busy} onClick={() => void mutate('remove', '', tag.id)}
              aria-label={`Retirer le tag ${tag.name} de cette vidéo`}>Retirer</button>
          </li>)}
        </ul>
      ) : <p>Aucun tag associé.</p>}
      <form onSubmit={(event) => {
        event.preventDefault()
        const choice = open && selected >= 0 ? options[selected]?.name : undefined
        if (choice || (query && !alreadyAssigned)) void mutate('add', choice ?? query)
      }}>
        <label htmlFor={inputID}>Rechercher ou ajouter un tag</label>
        <p id={`${inputID}-help`} className="muted">Saisissez un nom, puis utilisez les flèches et Entrée pour choisir une proposition.</p>
        <div className="tag-combobox">
          <input id={inputID} ref={input} role="combobox" autoComplete="off"
            aria-autocomplete="list" aria-expanded={open} aria-controls={listID}
            aria-describedby={`${inputID}-help`}
            aria-activedescendant={open && selected >= 0 && options[selected] ? `${listID}-${selected}` : undefined}
            value={text} disabled={busy}
            onChange={(event) => { setText(event.target.value); setSelected(-1); setExpanded(true) }}
            onFocus={() => setExpanded(true)}
            onBlur={() => { setExpanded(false); setSelected(-1) }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && open && selected >= 0 && options[selected]) {
                event.preventDefault()
                void mutate('add', options[selected].name)
              } else if (event.key === 'Escape' && open) {
                event.preventDefault()
                event.stopPropagation()
                setExpanded(false)
                setSelected(-1)
              } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
                event.preventDefault()
                setExpanded(true)
                setSelected((value) => event.key === 'ArrowDown'
                  ? Math.min(open ? value + 1 : 0, options.length - 1)
                  : open && value >= 0 ? Math.max(0, value - 1) : options.length - 1)
              }
            }} />
          {open && <ul id={listID} role="listbox" aria-label="Propositions de tags" className="tag-options">
            {options.map((option, index) => <li id={`${listID}-${index}`} key={option.name}
              role="option" aria-selected={index === selected}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void mutate('add', option.name)}>{option.label}</li>)}
          </ul>}
        </div>
        {alreadyAssigned && <p className="muted">Ce tag est déjà associé.</p>}
        <button className="button primary" type="submit" disabled={busy || !query || alreadyAssigned}>
          {query ? `Ajouter « ${query} »` : 'Ajouter le tag'}
        </button>
      </form>
      {busy && <p role="status">Mise à jour des tags…</p>}
      {notice && !busy && <p role="status">{notice}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {catalog.loading && <p className="muted">Chargement du catalogue…</p>}
      {catalog.error && <div role="alert" className="notice error">
        <p>{catalog.error} Vous pouvez toujours saisir un nom.</p>
        <button className="button" onClick={catalog.refresh}>Réessayer le catalogue</button>
      </div>}
      <button className="button" disabled={busy} onClick={() => { void mutate('refresh'); catalog.refresh() }}>
        Actualiser les associations
      </button>
    </div>
  )
}
