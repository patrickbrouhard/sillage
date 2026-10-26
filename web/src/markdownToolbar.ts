import { Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, showTooltip, tooltips, repositionTooltips } from '@codemirror/view'
import type { Tooltip, TooltipView, ViewUpdate } from '@codemirror/view'
import { markdownBlockLabel, transformMarkdown } from './markdownTransforms'
import type { MarkdownAction } from './markdownTransforms'

/** Suit la visibilité réelle de la note sans reconfigurer ni recréer l'éditeur. */
export const markdownToolbarEnabled = StateEffect.define<boolean>()
const openToolbar = StateEffect.define<boolean>()
const linkForm = StateEffect.define<boolean>()

interface ToolbarState {
  enabled: boolean
  tooltip: Tooltip | null
  form: boolean
}

const toolbarState = StateField.define<ToolbarState>({
  create: () => ({ enabled: false, tooltip: null, form: false }),
  update(value, transaction) {
    let { enabled, tooltip, form } = value
    // Un formulaire conserve son message d'invalidation ; aucune position ancienne
    // ne sera utilisée. Une transaction ordinaire ferme les autres surfaces.
    if ((transaction.docChanged || transaction.selection) && !form) tooltip = null
    if (transaction.docChanged && tooltip) tooltip = { ...tooltip, pos: transaction.changes.mapPos(tooltip.pos) }
    for (const effect of transaction.effects) {
      if (effect.is(markdownToolbarEnabled)) enabled = effect.value
      if (effect.is(linkForm)) form = effect.value
      if (effect.is(openToolbar)) {
        tooltip = effect.value ? {
          pos: transaction.state.selection.main.head,
          above: true,
          create: view => new ToolbarPanel(view),
        } : null
        form = false
      }
    }
    if (!enabled || (!form && (transaction.state.selection.ranges.length !== 1 || transaction.state.selection.main.empty))) {
      tooltip = null; form = false
    }
    return { enabled, tooltip, form }
  },
  provide: field => showTooltip.from(field, value => value.tooltip),
})

/** Ferme une surface sans reprendre le focus d'un clic extérieur. */
function close(view: EditorView) {
  view.dispatch({ effects: openToolbar.of(false) })
}

/** Rend la zone utile, y compris le viewport réduit par le clavier virtuel. */
function tooltipSpace() {
  const viewport = window.visualViewport
  return {
    left: (viewport?.offsetLeft ?? 0) + 8,
    top: (viewport?.offsetTop ?? 0) + 8,
    right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - 8,
    bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 8,
  }
}

/** Présente les contrôles natifs ; le texte cible reste dans l'état CodeMirror. */
class ToolbarPanel implements TooltipView {
  dom = document.createElement('div')
  offset = { x: 0, y: 12 }
  private row = document.createElement('div')
  private surface = document.createElement('div')
  private message = document.createElement('p')
  private textButton!: HTMLButtonElement
  private linkButton!: HTMLButtonElement
  private target: { doc: EditorView['state']['doc']; selection: EditorView['state']['selection'] } | null = null
  private submenu = false

  constructor(private view: EditorView) {
    this.dom.className = 'markdown-formatting'
    this.row.className = 'markdown-formatting-row'
    this.row.setAttribute('role', 'toolbar')
    this.row.setAttribute('aria-label', 'Mise en forme Markdown')
    this.message.setAttribute('role', 'status')
    this.message.className = 'markdown-formatting-message'
    this.message.hidden = true
    this.surface.hidden = true
    this.textButton = this.button(markdownBlockLabel(view.state) + ' ▾', 'Style du texte', () => this.showHeadings())
    this.textButton.setAttribute('aria-expanded', 'false')
    this.textButton.setAttribute('aria-haspopup', 'true')
    this.row.append(this.textButton)
    for (const [action, label, text] of [
      ['bold', 'Gras', 'G'], ['italic', 'Italique', 'I'], ['code', 'Code inline', '</>'], ['link', 'Lien', '↗'],
    ] as const) {
      const button = this.button(text, label, () => action === 'link' ? this.showLink() : this.apply(action))
      button.classList.add('markdown-formatting-' + action)
      const check = transformMarkdown(view.state, action)
      if ('reason' in check) {
        button.setAttribute('aria-disabled', 'true')
        button.title = check.reason
        button.addEventListener('click', () => this.explain(check.reason))
      }
      if (action === 'link') this.linkButton = button
      this.row.append(button)
    }
    this.dom.append(this.row, this.surface, this.message)
    // Empêcher seulement les boutons de déplacer la sélection native. Le champ
    // conserve son comportement standard, y compris clavier virtuel et copier/coller.
    this.dom.addEventListener('mousedown', event => {
      if ((event.target as Element).closest('button')) event.preventDefault()
    })
    this.dom.addEventListener('keydown', event => this.keydown(event))
  }

  /** Construit une commande nommée dont le refus reste consultable au clavier. */
  private button(text: string, label: string, action: () => void) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.setAttribute('aria-label', label)
    button.title = label
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') !== 'true') action()
    })
    return button
  }

  private explain(text: string) {
    this.message.textContent = text
    this.message.hidden = !text
    repositionTooltips(this.view)
  }

  private apply(action: MarkdownAction, address?: string) {
    if (!this.view.state.field(toolbarState).enabled || this.view.composing) return
    const change = transformMarkdown(this.view.state, action, address)
    if ('reason' in change) { this.explain(change.reason); return }
    // La fermeture appartient à la même transaction, mais n'ajoute aucune écriture.
    this.view.dispatch({
      ...change.transaction,
      effects: openToolbar.of(false),
    })
    this.view.focus()
  }

  private resetSurface() {
    this.submenu = false
    this.target = null
    this.surface.replaceChildren()
    this.surface.hidden = true
    this.row.hidden = false
    this.textButton.setAttribute('aria-expanded', 'false')
    this.view.dispatch({ effects: linkForm.of(false) })
    this.explain('')
  }

  private showHeadings() {
    if (this.submenu) { this.resetSurface(); return }
    this.resetSurface()
    this.submenu = true
    this.textButton.setAttribute('aria-expanded', 'true')
    this.surface.hidden = false
    this.surface.setAttribute('role', 'group')
    this.surface.setAttribute('aria-label', 'Niveau du texte')
    for (const level of [0, 1, 2, 3, 4, 5, 6] as const) {
      const label = level ? 'H' + level : 'Paragraphe'
      const button = this.button(label, label, () => this.apply(level))
      const check = transformMarkdown(this.view.state, level)
      if ('reason' in check) {
        button.setAttribute('aria-disabled', 'true')
        button.title = check.reason
        button.addEventListener('click', () => this.explain(check.reason))
      }
      this.surface.append(button)
    }
    this.surface.querySelector('button')?.focus({ preventScroll: true })
    repositionTooltips(this.view)
  }

  private showLink() {
    this.resetSurface()
    this.target = { doc: this.view.state.doc, selection: this.view.state.selection }
    this.view.dispatch({ effects: linkForm.of(true) })
    this.row.hidden = true
    this.surface.hidden = false
    this.surface.removeAttribute('role')
    this.surface.removeAttribute('aria-label')
    const form = document.createElement('form')
    const label = document.createElement('label')
    label.textContent = 'Adresse du lien'
    const input = document.createElement('input')
    input.type = 'text'
    input.autocomplete = 'off'
    input.placeholder = 'https://…'
    label.append(input)
    const confirm = this.button('Insérer', 'Insérer le lien', () => {})
    confirm.type = 'submit'
    const cancel = this.button('Annuler', 'Annuler le lien', () => {
      this.resetSurface()
      this.linkButton.focus({ preventScroll: true })
    })
    form.append(label, confirm, cancel)
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!this.validTarget()) { this.invalidate(); return }
      this.apply('link', input.value)
    })
    this.surface.append(form)
    input.focus({ preventScroll: true })
    repositionTooltips(this.view)
  }

  /** Une confirmation serveur garde le même document ; une capture le remplace. */
  private validTarget() {
    return this.target && this.target.doc === this.view.state.doc &&
      this.target.selection.eq(this.view.state.selection)
  }

  private invalidate() {
    this.explain('La note a changé depuis l’ouverture du formulaire. Sélectionnez à nouveau le texte pour insérer le lien.')
    const confirm = this.surface.querySelector<HTMLButtonElement>('button[type=submit]')
    if (confirm) confirm.disabled = true
  }

  update(update: ViewUpdate) {
    if (this.target && (update.docChanged || update.selectionSet) && !this.validTarget()) this.invalidate()
  }

  /** Les flèches restent natives dans le champ ; Échap ferme une surface à la fois. */
  private keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (this.target || this.submenu) {
        const wasLink = !!this.target
        this.resetSurface()
        const button = wasLink ? this.linkButton : this.textButton
        button.focus({ preventScroll: true })
      } else { close(this.view); this.view.focus() }
      return
    }
    if (event.key === 'Tab') {
      const controls = [...this.dom.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
        .filter(element => !element.disabled && element.getClientRects().length > 0)
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      if ((event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault()
        const next = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
          .find(element => element.tabIndex >= 0 && !this.dom.contains(element) &&
            element.getClientRects().length > 0 && !element.matches(':disabled') &&
            !!(this.view.dom.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
        close(this.view)
        if (event.shiftKey || !next) this.view.focus()
        else next.focus({ preventScroll: true })
        return
      }
    }
    if ((event.target as Element).closest('input')) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const group = this.submenu ? this.surface : this.row
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
  }

  /** Ancre à l'extrémité active visible, ou à la limite visible d'une longue sélection. */
  getCoords = () => {
    const view = this.view
    const range = view.state.selection.main
    const space = tooltipSpace()
    const container = view.dom.closest('.note-content')!.getBoundingClientRect()
    const top = Math.max(space.top, container.top)
    const bottom = Math.min(space.bottom, container.bottom)
    const hidden = { left: -10000, right: -10000, top: -10000, bottom: -10000 }
    if (bottom <= top || container.right <= space.left || container.left >= space.right) return hidden
    const direct = view.coordsAtPos(range.head, range.head > range.anchor ? -1 : 1)
    if (direct && direct.bottom > top && direct.top < bottom) return direct
    // Garder une ligne de marge évite de choisir la ligne repliée juste sous le viewport.
    const x = Math.max(container.left + 24, Math.min(container.right - 24, direct?.left ?? container.left + 24))
    const y = range.head > range.anchor ? bottom - view.defaultLineHeight : top + view.defaultLineHeight
    const position = view.posAtCoords({ x, y })
    const coords = position !== null && position >= range.from && position <= range.to ? view.coordsAtPos(position) : null
    return coords && coords.bottom > top && coords.top < bottom ? coords : hidden
  }
}

/** Temporise les gestes natifs et ne réouvre jamais sur une sauvegarde ou une mesure. */
const gestures = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined
  dragging = false
  composing = false
  touch = false
  destroyed = false

  constructor(readonly view: EditorView) {
    window.addEventListener('pointerup', this.pointerup)
    window.addEventListener('pointercancel', this.pointercancel)
    document.addEventListener('pointerdown', this.outside, true)
    document.addEventListener('focusin', this.focusChanged)
    window.addEventListener('scroll', this.geometry, true)
    window.addEventListener('resize', this.geometry)
    window.visualViewport?.addEventListener('resize', this.geometry)
    window.visualViewport?.addEventListener('scroll', this.geometry)
    this.observer.observe(view.dom)
  }

  observer = new ResizeObserver(() => this.geometry())

  geometry = () => {
    if (!this.destroyed && this.view.state.field(toolbarState).tooltip) repositionTooltips(this.view)
  }

  outside = (event: PointerEvent) => {
    const target = event.target as Element
    if (!target.closest('.markdown-formatting') && !this.view.contentDOM.contains(target)) {
      clearTimeout(this.timer)
      close(this.view)
    }
  }

  focusChanged = (event: FocusEvent) => {
    const target = event.target as Element
    if (!target.closest('.markdown-formatting') && !this.view.dom.contains(target)) {
      clearTimeout(this.timer)
      close(this.view)
    }
  }

  schedule() {
    clearTimeout(this.timer)
    if (this.dragging || this.composing) return
    this.timer = setTimeout(() => {
      const state = this.view.state
      if (this.destroyed || !this.view.hasFocus || this.view.composing ||
          !state.field(toolbarState).enabled || state.selection.ranges.length !== 1 || state.selection.main.empty) return
      this.view.dispatch({ effects: openToolbar.of(true) })
    }, this.touch ? 600 : 180)
  }

  pointerup = () => {
    if (!this.dragging) return
    this.dragging = false
    this.schedule()
  }

  pointercancel = () => {
    this.dragging = false
    clearTimeout(this.timer)
  }

  update(update: ViewUpdate) {
    if (update.docChanged) clearTimeout(this.timer)
    else if (update.transactions.some(transaction => transaction.isUserEvent('select')) &&
        !update.state.field(toolbarState).form) this.schedule()
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.timer)
    this.observer.disconnect()
    window.removeEventListener('pointerup', this.pointerup)
    window.removeEventListener('pointercancel', this.pointercancel)
    document.removeEventListener('pointerdown', this.outside, true)
    document.removeEventListener('focusin', this.focusChanged)
    window.removeEventListener('scroll', this.geometry, true)
    window.removeEventListener('resize', this.geometry)
    window.visualViewport?.removeEventListener('resize', this.geometry)
    window.visualViewport?.removeEventListener('scroll', this.geometry)
  }
}, {
  eventHandlers: {
    pointerdown(event) {
      this.touch = event.pointerType === 'touch'
      this.dragging = true
      clearTimeout(this.timer)
      close(this.view)
    },
    keyup(event) {
      if (event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) this.schedule()
    },
    keydown(event) {
      if (event.key !== 'Tab' && !event.shiftKey) {
        clearTimeout(this.timer)
        if (this.view.state.field(toolbarState).tooltip) close(this.view)
      }
    },
    compositionstart() {
      this.composing = true
      clearTimeout(this.timer)
      close(this.view)
    },
    compositionend() { this.composing = false },
  },
})

/** Ajoute un tooltip CodeMirror fixé au viewport, hors du clipping des panneaux. */
export function markdownToolbar() {
  return [
    toolbarState,
    tooltips({ parent: document.body, position: 'fixed', tooltipSpace }),
    gestures,
    Prec.high(keymap.of([{
      key: 'Tab',
      run(view) {
        const tooltip = view.state.field(toolbarState).tooltip
        if (!tooltip) return false
        document.querySelector<HTMLButtonElement>('.markdown-formatting button')?.focus({ preventScroll: true })
        return true
      },
    }])),
  ]
}
