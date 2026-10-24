import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SearchSegment } from './searchApi'

type Character = { text: string; highlight: boolean }

/** Réduit les blancs entre segments sans fusionner les mots ni réinterpréter leur texte. */
function continuousCharacters(segments: SearchSegment[]): Character[] {
  const result: Character[] = []
  let space = false
  for (const segment of segments) {
    for (const text of segment.text) {
      if (/\s/u.test(text)) { space = result.length > 0; continue }
      if (space) result.push({ text: ' ', highlight: false })
      result.push({ text, highlight: segment.highlight })
      space = false
    }
  }
  return result
}

/** Conserve l'ordre et les marques de la fenêtre ; les ellipses signalent chaque omission. */
function excerptWindow(characters: Character[], from: number, to: number): SearchSegment[] {
  const segments: SearchSegment[] = []
  function append(text: string, highlight: boolean) {
    const last = segments.at(-1)
    if (last?.highlight === highlight) last.text += text
    else segments.push({ text, highlight })
  }
  if (from > 0) append('…', false)
  for (let i = from; i < to; i++) append(characters[i].text, characters[i].highlight)
  if (to < characters.length) append('…', false)
  return segments
}

/** Affiche deux lignes mesurées autour d'une marque, ou tout l'extrait reçu sans réseau. */
export function SearchExcerpt({ segments }: { segments: SearchSegment[] }) {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLParagraphElement>(null)
  const characters = useMemo(() => continuousCharacters(segments), [segments])
  const full = useMemo(() => excerptWindow(characters, 0, characters.length), [characters])
  const [expanded, setExpanded] = useState(false)
  const [compact, setCompact] = useState({ segments: full, abbreviated: false })

  useLayoutEffect(() => {
    const element = probe.current!
    const host = container.current!
    let frame = 0
    let previousMetrics = ''

    function measure() {
      const style = getComputedStyle(element)
      const metrics = [element.clientWidth, style.font, style.lineHeight, style.letterSpacing, style.wordSpacing].join('|')
      if (metrics === previousMetrics || element.clientWidth === 0) return
      previousMetrics = metrics
      const maximumHeight = Number.parseFloat(style.lineHeight) * 2

      /** La sonde utilise les mêmes marques et styles que le paragraphe visible. */
      function fits(candidate: SearchSegment[]): boolean {
        const fragment = document.createDocumentFragment()
        for (const segment of candidate) {
          const node = document.createElement(segment.highlight ? 'mark' : 'span')
          node.textContent = segment.text
          fragment.append(node)
        }
        element.replaceChildren(fragment)
        // offsetHeight mesure les pixels CSS, indépendamment du zoom et des transformations.
        return element.offsetHeight <= maximumHeight + 0.5
      }

      if (fits(full)) {
        setCompact({ segments: full, abbreviated: false })
        return
      }
      const first = Math.max(0, characters.findIndex(character => character.highlight))
      let requiredEnd = first + 1
      while (requiredEnd < characters.length && characters[requiredEnd].highlight) requiredEnd++
      // Garder le premier mot marqué entier, sauf si ce token dépasse lui-même deux lignes.
      if (!fits(excerptWindow(characters, first, requiredEnd))) requiredEnd = first + 1
      // Réduire d'abord le contexte précédent pour garder cette correspondance.
      let low = 0
      let high = first
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (fits(excerptWindow(characters, middle, requiredEnd))) high = middle
        else low = middle + 1
      }
      const from = low
      // Puis remplir les deux lignes sans couper le contenu par un masque CSS.
      low = requiredEnd
      high = characters.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (fits(excerptWindow(characters, from, middle))) low = middle
        else high = middle - 1
      }
      setCompact({ segments: excerptWindow(characters, from, low), abbreviated: true })
    }

    function schedule() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    function fontsChanged() { previousMetrics = ''; schedule() }
    measure()
    // Seul le conteneur visible est observé : les essais de la sonde ne se réobservent pas.
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    document.fonts.addEventListener('loadingdone', fontsChanged)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.fonts.removeEventListener('loadingdone', fontsChanged)
    }
  }, [characters, full])

  return <div className="search-excerpt-container" ref={container}>
    <p id={id} className="search-excerpt" aria-label="Extrait de la note">
      {(expanded ? full : compact.segments).map((segment, index) => segment.highlight
        ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}
    </p>
    <p ref={probe} className="search-excerpt search-excerpt-measure" aria-hidden="true" inert />
    {compact.abbreviated && <button type="button" className="search-excerpt-toggle"
      aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Réduire' : 'Voir plus'}</button>}
  </div>
}
