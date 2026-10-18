import { expect, test } from './fixtures'

test('le favicon distribué est une image, y compris via HEAD', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.ico')
  const icon = await request.get('/favicon.ico')
  expect(icon.status()).toBe(200)
  expect(icon.headers()['content-type']).toMatch(/^image\//)
  const body = await icon.body()
  expect([...body.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0])
  const head = await request.head('/favicon.ico')
  expect(head.status()).toBe(200)
  expect(head.headers()['content-length']).toBe(String(body.length))
  expect((await head.body()).length).toBe(0)
  expect((await request.get('/missing-icon.ico')).status()).toBe(404)
  // Décoder les octets réellement reçus, indépendamment du chargement spécial des favicons.
  expect(await page.evaluate(async data => {
    const image = new Image()
    image.src = 'data:image/x-icon;base64,' + data
    await image.decode()
    return image.naturalWidth > 0
  }, body.toString('base64'))).toBe(true)
})
