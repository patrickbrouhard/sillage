import type { TranscriptItem } from './transcriptApi'

/** Bloc dérivé sans identité persistée ; le début reste celui du premier fragment. */
export interface TranscriptBlock {
  start_ms: number
  text: string
}

/** Regroupe sans trier ni découper les fragments, même lorsque leurs temps reculent. */
export function groupTranscript(items: TranscriptItem[], seconds: number): TranscriptBlock[] {
  const groups: TranscriptBlock[] = []
  let previousBucket: number | undefined
  for (const item of items) {
    const bucket = Math.floor(item.start_ms / (seconds * 1000))
    if (bucket === previousBucket) groups[groups.length - 1].text += item.text
    else groups.push({ start_ms: item.start_ms, text: item.text })
    previousBucket = bucket
  }

  // Les groupes de blancs restent des séparateurs, sans ligne horodatée vide.
  // Les blancs initiaux précèdent le premier bloc textuel sans changer son instant.
  const visible: TranscriptBlock[] = []
  let leading = ''
  for (const group of groups) {
    if (!group.text.trim()) {
      if (visible.length) visible[visible.length - 1].text += group.text
      else leading += group.text
    } else {
      visible.push({ ...group, text: leading + group.text })
      leading = ''
    }
  }
  return visible
}
