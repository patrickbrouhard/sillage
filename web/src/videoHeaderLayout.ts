/** Mesure le budget desktop indépendamment du préfixe affiché et du mode centré/gauche. */
export function measureHeaderLayout(
  header: HTMLElement,
  navigation: HTMLElement,
  title: HTMLElement,
  management: Element,
  minimumTagsWidth: number,
  hasTags: boolean,
) {
  const style = getComputedStyle(header)
  const width = header.getBoundingClientRect().width
    - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const navigationWidth = navigation.getBoundingClientRect().width
  const outerGap = parseFloat(style.columnGap) || 0
  const host = title.closest<HTMLElement>('.video-header-content')!
  const titleGap = parseFloat(getComputedStyle(host).columnGap) || 0
  const tagGroup = management.parentElement!
  const tagGap = hasTags ? parseFloat(getComputedStyle(tagGroup).columnGap) || 0 : 0
  const commandWidth = management.getBoundingClientRect().width
  const budget = Math.max(0, width - navigationWidth - outerGap)

  // Réserver l’accès aux tags avant de tronquer le titre ; aucun quota de tags.
  const titleWidth = Math.min(
    title.getBoundingClientRect().width,
    Math.max(0, budget - titleGap - commandWidth - tagGap - minimumTagsWidth),
  )
  const fixedWidth = titleWidth + titleGap + commandWidth + tagGap
  return {
    navigationWidth,
    titleWidth,
    tagBudget: Math.max(0, budget - fixedWidth),
    centerBudget: Math.max(0, width - 2 * (navigationWidth + outerGap)),
    groupWidth: (tagWidth: number) => fixedWidth + tagWidth,
  }
}
