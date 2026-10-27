import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { APIError, deleteCatalogTag, errorMessage, listTagCatalog, renameCatalogTag } from './api'
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
  return name.normalize('NFC').toLocaleLowerCase('fr')
    .includes(query.trim().normalize('NFC').toLocaleLowerCase('fr'))
}

/** Seuls les rejets métier explicites permettent d'affirmer que l'écriture a été refusée. */
function mutationError(reason: unknown): string {
  const rejected = reason instanceof APIError && [
    'bad_request', 'tag_not_found', 'tag_conflict', 'payload_too_large', 'unsupported_media_type',
  ].includes(reason.code)
  const message = errorMessage(reason)
  return rejected ? message : `${message} La modification a peut-être été enregistrée. Actualisez le catalogue pour vérifier son résultat avant de réessayer.`
}

/** Administre le catalogue partagé par mises à jour locales après chaque écriture réussie. */
export function Tags() {
  const [tags, setTags] = useState<CatalogTag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutationCount, setMutationCount] = useState(0)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [notice, setNotice] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const catalogRead = useRef<AbortController | null>(null)
  const activeMutations = useRef(0)

  /** Relit sans relancer d'écriture ; seules les réponses encore courantes sont appliquées. */
  async function refreshCatalog(reportError = true): Promise<boolean> {
    if (activeMutations.current > 0 || catalogRead.current) return false
    const controller = new AbortController()
    catalogRead.current = controller
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await listTagCatalog(controller.signal)
      if (controller.signal.aborted) return false
      setTags(result)
      return true
    } catch (reason) {
      if (!controller.signal.aborted && reportError) setError(errorMessage(reason))
      return false
    } finally {
      if (catalogRead.current === controller) {
        catalogRead.current = null
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    void refreshCatalog()
    return () => { catalogRead.current?.abort(); catalogRead.current = null }
  }, [])

  /** Une mutation invalide l'instantané en vol avant tout envoi, même si sa réponse est perdue. */
  function changeMutationState(running: boolean) {
    activeMutations.current += running ? 1 : -1
    setMutationCount(activeMutations.current)
    if (running && catalogRead.current) {
      catalogRead.current.abort()
      catalogRead.current = null
      setLoading(false)
      setNotice('Actualisation interrompue par une modification. Actualisez de nouveau le catalogue.')
    }
  }

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
      <button className="button" disabled={loading || mutationCount > 0} onClick={() => void refreshCatalog()}>Réessayer le catalogue</button>
    </div>}
    {!loading && !error && tags.length === 0 && <div className="state-panel">
      <h2>Aucun tag dans le catalogue</h2>
      <p>Les tags ajoutés aux vidéos, publishers et personnes apparaîtront ici.</p>
    </div>}
    {!loading && !error && tags.length > 0 && visible.length === 0 && <p>Aucun tag ne correspond à votre recherche.</p>}
    <ul className="tag-catalog-list" aria-label="Catalogue des tags" aria-busy={loading}>
      {/* Garder les lignes filtrées montées préserve les brouillons et les écritures en cours. */}
      {ordered.map(tag => <TagRow key={tag.id} tag={tag} hidden={!matchesName(tag.name, query)}
        refreshDisabled={loading || mutationCount > 0}
        onRecover={() => refreshCatalog(false)}
        onRecovered={restoreFocus => {
          setNotice('Catalogue actualisé.')
          if (restoreFocus) search.current?.focus()
        }}
        onMutationChange={changeMutationState}
        onRenamed={(result, restoreFocus) => {
          setTags(current => current.map(item => item.id === result.id ? { ...item, name: result.name } : item))
          setNotice(`Tag renommé : ${result.name}.`)
          // Un renommage peut sortir du filtre courant : restaurer alors un focus utile.
          if (restoreFocus && !matchesName(result.name, search.current?.value ?? '')) search.current?.focus()
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
function TagRow({
  tag,
  hidden,
  refreshDisabled,
  onRecover,
  onRecovered,
  onMutationChange,
  onRenamed,
  onDeleted,
}: {
  tag: CatalogTag
  hidden: boolean
  refreshDisabled: boolean
  onRecover: () => Promise<boolean>
  onRecovered: (restoreFocus: boolean) => void
  onMutationChange: (running: boolean) => void
  onRenamed: (tag: Tag, restoreFocus: boolean) => void
  onDeleted: () => void
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const rename = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const controller = useRef<AbortController | null>(null)
  const wasEditing = useRef(false)
  const row = useRef<HTMLLIElement>(null)
  const restoreRenameFocus = useRef(false)
  const recoveryPending = useRef(false)
  const busy = pending || recovering

  useEffect(() => () => controller.current?.abort(), [])
  useLayoutEffect(() => {
    if (editing && !wasEditing.current) { input.current?.focus(); input.current?.select() }
    else if (!editing && wasEditing.current && restoreRenameFocus.current && !hidden) rename.current?.focus()
    wasEditing.current = editing
  }, [editing, hidden])
  useLayoutEffect(() => {
    if (deleting) dialog.current?.showModal()
  }, [deleting])

  /** Le bouton désactivé peut rendre le focus au body, sans choix d'un autre contrôle. */
  function ownsFocus(): boolean {
    return Boolean(row.current && (row.current.contains(document.activeElement)
      || (document.activeElement === document.body && !row.current.hidden)))
  }

  /** Verrouille immédiatement les doubles soumissions ; une erreur conserve le brouillon. */
  async function mutate(action: 'rename' | 'delete') {
    if (controller.current || recoveryPending.current) return
    const request = new AbortController()
    controller.current = request
    onMutationChange(true)
    setPending(true)
    setError('')
    try {
      if (action === 'rename') {
        const result = await renameCatalogTag(tag.id, name, request.signal)
        if (request.signal.aborted) return
        // Une réponse tardive ne doit pas reprendre le focus quitté pendant l'attente.
        restoreRenameFocus.current = ownsFocus()
        setEditing(false)
        onRenamed(result, restoreRenameFocus.current)
      } else {
        await deleteCatalogTag(tag.id, request.signal)
        if (request.signal.aborted) return
        dialog.current?.close()
        onDeleted()
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        setError(mutationError(reason))
        // Revenir au champ pour corriger une collision sans fermer l'édition.
        if (action === 'rename' && ownsFocus()) input.current?.focus()
      }
    } finally {
      if (!request.signal.aborted) setPending(false)
      controller.current = null
      onMutationChange(false)
    }
  }

  /** Réconcilie la ligne choisie sans remonter les autres éditeurs ni rejouer la mutation. */
  async function recover() {
    if (controller.current || recoveryPending.current || refreshDisabled) return
    recoveryPending.current = true
    setRecovering(true)
    try {
      if (await onRecover()) {
        // La ligne peut avoir disparu ; préserver aussi un focus déplacé vers un autre brouillon.
        const restoreFocus = document.activeElement === document.body
          || Boolean(row.current?.contains(document.activeElement))
        restoreRenameFocus.current = false
        dialog.current?.close()
        setEditing(false)
        setError('')
        onRecovered(restoreFocus)
      } else {
        setError('Le catalogue n’a pas pu être actualisé. Réessayez l’actualisation avant de relancer la modification.')
      }
    } finally {
      recoveryPending.current = false
      setRecovering(false)
    }
  }

  function cancelEdit() {
    if (controller.current || recoveryPending.current) return
    restoreRenameFocus.current = true
    setEditing(false)
    setError('')
  }

  const recoveryError = error && <div className="tag-catalog-error">
    <p id={`${id}-error`} role="alert">{error}</p>
    {editing && <p>Actualiser remplace le brouillon de cette ligne par l’état enregistré.</p>}
    <button className="button" type="button" disabled={refreshDisabled || recovering}
      onClick={() => void recover()}>{recovering ? 'Actualisation…' : 'Actualiser le catalogue'}</button>
  </div>

  return <li ref={row} className="tag-catalog-row" hidden={hidden}>
    <div className="tag-catalog-content">
      {editing ? <form className="tag-rename" aria-label={`Renommer ${tag.name}`}
        onSubmit={event => { event.preventDefault(); void mutate('rename') }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); cancelEdit() }
        }}>
        <label htmlFor={`${id}-name`} className="sr-only">Nom du tag</label>
        <input id={`${id}-name`} ref={input} value={name} readOnly={busy}
          aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => setName(event.target.value)} />
        <div className="page-actions">
          <button className="button primary" disabled={busy} type="submit">{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
          <button className="button" disabled={busy} type="button" onClick={cancelEdit}>Annuler</button>
        </div>
      </form> : <span className="tag-catalog-name">{tag.name}</span>}
      <p className="tag-catalog-associations">{associations(tag)}</p>
      {!deleting && recoveryError}
    </div>
    {!editing && <div className="tag-catalog-actions">
      <IconButton ref={rename} icon="pencil" label={`Renommer le tag ${tag.name}`} tooltip="Renommer"
        onClick={() => { setName(tag.name); setError(''); setEditing(true) }} />
      <IconButton icon="trash" label={`Supprimer le tag ${tag.name}`} tooltip="Supprimer"
        onClick={() => { setError(''); setDeleting(true) }} />
    </div>}
    <dialog ref={dialog} className="tag-delete-dialog" aria-labelledby={`${id}-delete-title`} aria-describedby={`${id}-delete-description`}
      onCancel={event => { if (controller.current || recoveryPending.current) event.preventDefault() }}
      onClose={() => { setDeleting(false); setError('') }}>
      <h2 id={`${id}-delete-title`}>Supprimer « {tag.name} » ?</h2>
      <div id={`${id}-delete-description`}>
        <p>{associations(tag)}</p>
        <p>Le tag et toutes ses associations seront supprimés. Les vidéos, publishers et personnes seront conservés.</p>
      </div>
      {deleting && recoveryError}
      <div className="page-actions">
        <button className="button" autoFocus disabled={busy} onClick={() => dialog.current?.close()}>Annuler</button>
        <button className="button danger" disabled={busy} onClick={() => void mutate('delete')}>{pending ? 'Suppression…' : 'Supprimer'}</button>
      </div>
    </dialog>
  </li>
}
