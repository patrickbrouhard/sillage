import { useEffect, useId, useState } from 'react'
import type { Tag } from './api'

interface Props {
  tags: Tag[]
  onSelect: (value: string) => void
}

/** Recherche un tag existant sans créer ni conserver une sélection distincte de l'URL. */
export function LibraryTagFilter({ tags, onSelect }: Props) {
  const inputID = useId()
  const listID = useId()
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState(-1)
  // Comme dans l'éditeur, le rapprochement local ne redéfinit pas l'identité des tags.
  const matchText = (value: string) => value.normalize('NFC').toLocaleLowerCase('fr')
  const matches = tags.filter(tag => matchText(tag.name).includes(matchText(text.trim())))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  const open = expanded && matches.length > 0

  useEffect(() => {
    if (open && selected >= 0) {
      document.getElementById(`${listID}-${selected}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, selected, listID])

  /** Applique uniquement un choix existant ; la saisie demeure une recherche temporaire. */
  function choose(tag: Tag) {
    onSelect(String(tag.id))
    setText('')
    setSelected(-1)
    setExpanded(false)
  }

  return <div className="library-tag-filter">
    <label htmlFor={inputID}>Filtrer par tag</label>
    <input id={inputID} role="combobox" autoComplete="off" placeholder="Rechercher un tag…"
      aria-autocomplete="list" aria-expanded={open} aria-controls={listID}
      aria-describedby={`${inputID}-help`}
      aria-activedescendant={open && selected >= 0 && matches[selected] ? `${listID}-${selected}` : undefined}
      value={text}
      onChange={event => { setText(event.target.value); setSelected(-1); setExpanded(true) }}
      onFocus={() => setExpanded(true)}
      onBlur={() => { setExpanded(false); setSelected(-1) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          if (open && selected >= 0 && matches[selected]) choose(matches[selected])
        } else if (event.key === 'Escape' && open) {
          // Le premier Échap replie les suggestions ; le suivant ferme le popover natif.
          event.preventDefault()
          event.stopPropagation()
          setExpanded(false)
          setSelected(-1)
        } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
          event.preventDefault()
          setExpanded(true)
          setSelected(value => event.key === 'ArrowDown'
            ? Math.min(open ? value + 1 : 0, matches.length - 1)
            : open && value >= 0 ? Math.max(0, value - 1) : matches.length - 1)
        }
      }} />
    <p id={`${inputID}-help`} className="muted">Choisissez un tag existant avec les flèches et Entrée, ou par clic.</p>
    {open && <ul id={listID} role="listbox" aria-label="Propositions de tags" className="tag-options">
      {matches.map((tag, index) => <li key={tag.id} id={`${listID}-${index}`}
        role="option" aria-selected={index === selected}
        onPointerDown={event => event.preventDefault()}
        onClick={() => choose(tag)}>{tag.name}</li>)}
    </ul>}
    {expanded && text.trim() && matches.length === 0 && <p className="muted">Aucun tag correspondant.</p>}
  </div>
}
