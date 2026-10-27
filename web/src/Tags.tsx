import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { deleteCatalogTag, errorMessage, listTagCatalog, renameCatalogTag } from './api'
import type { CatalogTag, Tag } from './api'
import { IconButton } from './IconButton'

const nameOrder = new Intl.Collator('fr', { sensitivity: 'variant' })

/** Décrit uniquement les liens directs et masque les catégories vides. */
function associations(tag: CatalogTag): string {
  return [
    tag.video_count ? `${tag.video_count} vidéo${tag.video_count > 1 ? 's' : ''}` : '',
    tag.publisher_count ? `${tag.publisher_count} publisher${tag.publisher_count > 1 ? 's' : ''}` : '',
    tag.person_count ? `${tag.person_count} personne${tag.person_count > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ') || 'Inutilisé'
}

/** Filtre d'affichage seulement ; l'identité Unicode reste exclusivement métier. */
function matchesName(name: string, query: string): boolean {
  return name.toLocaleLowerCase('fr').includes(query.trim().toLocaleLowerCase('fr'))
}

/** Administre le catalogue partagé par mises à jour locales après chaque écriture réussie. */
export function Tags() {
  const [tags, setTags] = useState<CatalogTag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [notice, setNotice] = useState('')
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void listTagCatalog(controller.signal).then(result => {
      if (!controller.signal.aborted) setTags(result)
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [attempt])

  const ordered = [...tags].sort((a, b) => {
    const usage = (tag: CatalogTag) => tag.video_count + tag.publisher_count + tag.person_count
    const difference = sort === 'least' ? usage(a) - usage(b) : sort === 'most' ? usage(b) - usage(a) : 0
    return difference || nameOrder.compare(a.name, b.name) || a.id - b.id
  })
  const visible = ordered.filter(tag => matchesName(tag.name, query))

  return <section className="tag-catalog" aria-labelledby="tags-title">
    <title>Tags · Sillage</title>
    <div className="page-heading">
      <div>
        <h1 id="tags-title">Tags</h1>
        <p className="intro">Le catalogue partagé des vidéos, publishers et personnes.</p>
      </div>
    </div>
    <div className="tag-catalog-controls">
      <label>Rechercher un tag
        <input ref={search} type="search" value={query} onChange={event => { setQuery(event.target.value); setNotice('') }} />
      </label>
      <label>Trier par
        <select value={sort} onChange={event => { setSort(event.target.value); setNotice('') }}>
          <option value="name">Ordre alphabétique</option>
          <option value="least">Utilisations croissantes</option>
          <option value="most">Utilisations décroissantes</option>
        </select>
      </label>
    </div>
    <p className="tag-catalog-status" role="status">{loading ? 'Chargement des tags…' : notice || `${visible.length} tag${visible.length > 1 ? 's' : ''}`}</p>
    {error && <div className="notice error" role="alert">
      <p>{error}</p>
      <button className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer le catalogue</button>
    </div>}
    {!loading && !error && tags.length === 0 && <div className="state-panel">
      <h2>Aucun tag dans le catalogue</h2>
      <p>Les tags ajoutés aux vidéos, publishers et personnes apparaîtront ici.</p>
    </div>}
    {!loading && !error && tags.length > 0 && visible.length === 0 && <p>Aucun tag ne correspond à votre recherche.</p>}
    <ul className="tag-catalog-list" aria-label="Catalogue des tags" aria-busy={loading}>
      {/* Garder les lignes filtrées montées préserve les brouillons et les écritures en cours. */}
      {ordered.map(tag => <TagRow key={tag.id} tag={tag} hidden={!matchesName(tag.name, query)}
        onRenamed={result => {
          setTags(current => current.map(item => item.id === result.id ? { ...item, name: result.name } : item))
          setNotice(`Tag renommé : ${result.name}.`)
          // Un renommage peut sortir du filtre courant : restaurer alors un focus utile.
          if (!matchesName(result.name, query)) search.current?.focus()
        }}
        onDeleted={() => {
          setTags(current => current.filter(item => item.id !== tag.id))
          setNotice(`Tag supprimé : ${tag.name}.`)
          search.current?.focus()
        }} />)}
    </ul>
  </section>
}

/** Isole le brouillon, le dialogue et les erreurs de chaque ligne pendant les tris. */
function TagRow({ tag, hidden, onRenamed, onDeleted }: {
  tag: CatalogTag
  hidden: boolean
  onRenamed: (tag: Tag) => void
  onDeleted: () => void
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const rename = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const controller = useRef<AbortController | null>(null)
  const wasEditing = useRef(false)

  useEffect(() => () => controller.current?.abort(), [])
  useLayoutEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select() }
    else if (wasEditing.current) rename.current?.focus()
    wasEditing.current = editing
  }, [editing])
  useLayoutEffect(() => {
    if (deleting) dialog.current?.showModal()
  }, [deleting])

  /** Verrouille immédiatement les doubles soumissions ; une erreur conserve le brouillon. */
  async function mutate(action: 'rename' | 'delete') {
    if (controller.current) return
    const request = new AbortController()
    controller.current = request
    setPending(true)
    setError('')
    try {
      if (action === 'rename') {
        const result = await renameCatalogTag(tag.id, name, request.signal)
        if (request.signal.aborted) return
        setEditing(false)
        onRenamed(result)
      } else {
        await deleteCatalogTag(tag.id, request.signal)
        if (request.signal.aborted) return
        dialog.current?.close()
        onDeleted()
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        setError(errorMessage(reason))
        // Revenir au champ pour corriger une collision sans fermer l'édition.
        if (action === 'rename') input.current?.focus()
      }
    } finally {
      if (!request.signal.aborted) setPending(false)
      controller.current = null
    }
  }

  function cancelEdit() {
    if (controller.current) return
    setEditing(false)
    setError('')
  }

  return <li className="tag-catalog-row" hidden={hidden}>
    <div className="tag-catalog-content">
      {editing ? <form className="tag-rename" aria-label={`Renommer ${tag.name}`}
        onSubmit={event => { event.preventDefault(); void mutate('rename') }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); cancelEdit() }
        }}>
        <label htmlFor={`${id}-name`} className="sr-only">Nom du tag</label>
        <input id={`${id}-name`} ref={input} value={name} readOnly={pending}
          aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => setName(event.target.value)} />
        <div className="page-actions">
          <button className="button primary" disabled={pending} type="submit">{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
          <button className="button" disabled={pending} type="button" onClick={cancelEdit}>Annuler</button>
        </div>
      </form> : <span className="tag-catalog-name">{tag.name}</span>}
      <p className="tag-catalog-associations">{associations(tag)}</p>
      {error && !deleting && <p id={`${id}-error`} role="alert" className="tag-catalog-error">{error}</p>}
    </div>
    {!editing && <div className="tag-catalog-actions">
      <IconButton ref={rename} icon="pencil" label={`Renommer le tag ${tag.name}`} tooltip="Renommer"
        onClick={() => { setName(tag.name); setError(''); setEditing(true) }} />
      <IconButton icon="trash" label={`Supprimer le tag ${tag.name}`} tooltip="Supprimer"
        onClick={() => { setError(''); setDeleting(true) }} />
    </div>}
    <dialog ref={dialog} className="tag-delete-dialog" aria-labelledby={`${id}-delete-title`} aria-describedby={`${id}-delete-description`}
      onCancel={event => { if (controller.current) event.preventDefault() }}
      onClose={() => { setDeleting(false); setError('') }}>
      <h2 id={`${id}-delete-title`}>Supprimer « {tag.name} » ?</h2>
      <div id={`${id}-delete-description`}>
        <p>{associations(tag)}</p>
        <p>Le tag et toutes ses associations seront supprimés. Les vidéos, publishers et personnes seront conservés.</p>
      </div>
      {error && <p role="alert" className="tag-catalog-error">{error}</p>}
      <div className="page-actions">
        <button className="button" autoFocus disabled={pending} onClick={() => dialog.current?.close()}>Annuler</button>
        <button className="button danger" disabled={pending} onClick={() => void mutate('delete')}>{pending ? 'Suppression…' : 'Supprimer'}</button>
      </div>
    </dialog>
  </li>
}
