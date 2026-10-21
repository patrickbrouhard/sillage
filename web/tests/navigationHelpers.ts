import type { Page } from '@playwright/test'

/** Change le thème par son accès public puis rend la page de nouveau interactive. */
export async function selectTheme(page: Page, theme: string) {
  await page.getByRole('button', { name: 'Ouvrir la navigation', exact: true }).click()
  await page.getByLabel('Thème', { exact: true }).selectOption(theme)
  await page.getByRole('button', { name: 'Fermer la navigation', exact: true }).click()
}
