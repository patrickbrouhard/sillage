import { test, expect } from '@playwright/test'
import { PlaybackProgress, PlaybackWrites } from '../src/playbackProgress'
import type { PlaybackObservation } from '../src/playbackProgress'

/** Produit une observation sans confondre horloge réelle et temps du média. */
function observation(positionMs: number, state: PlaybackObservation['state'] = 'playing', rate = 1, durationMs: number | null = null): PlaybackObservation {
  return { positionMs, state, rate, durationMs }
}

/** Fait avancer une lecture observée à chaque seconde, à vitesse choisie. */
function play(policy: PlaybackProgress, from: number, seconds: number, startAt = 0, rate = 1) {
  const results = []
  policy.observe(observation(from, 'playing', rate), startAt)
  for (let i = 1; i <= seconds; i++) {
    results.push(policy.observe(observation(from + i * 1000 * rate, 'playing', rate), startAt + i * 1000))
  }
  return results
}

test('première écriture à dix secondes, pause qualifiée à cinq, zéro préparé sans écriture', () => {
  const policy = new PlaybackProgress()
  expect(policy.flush()).toBeUndefined()
  expect(play(policy, 0, 4).filter(x => x !== undefined)).toEqual([])
  expect(policy.observe(observation(4000, 'paused'), 4000)).toBeUndefined()
  expect(play(policy, 4000, 1, 5000)).toEqual([undefined])
  expect(policy.observe(observation(5000, 'paused'), 6000)).toBe(5000)
  expect(play(policy, 5000, 10, 7000).filter(x => x !== undefined)).toEqual([15000])
})

for (const rate of [0.5, 1, 2]) {
  test('les seuils suivent le temps réel à vitesse ' + rate, () => {
    const policy = new PlaybackProgress()
    expect(play(policy, 0, 4, 0, rate).filter(x => x !== undefined)).toEqual([])
    expect(policy.flush()).toBeUndefined()
    expect(policy.observe(observation(5000 * rate, 'playing', rate), 5000)).toBeUndefined()
    expect(policy.flush()).toBe(5000 * rate)
  })
}

test('seeks explicites répétés et pause avant qualification conservent le point précédent', () => {
  const policy = new PlaybackProgress()
  play(policy, 0, 6)
  expect(policy.flush()).toBe(6000)
  policy.seek()
  play(policy, 60000, 3, 7000)
  expect(policy.observe(observation(63000, 'paused'), 10000)).toBeUndefined()
  policy.seek()
  play(policy, 20000, 3, 11000)
  expect(policy.flush()).toBeUndefined()
  expect(policy.observe(observation(24000), 15000)).toBeUndefined()
  expect(policy.observe(observation(25000), 16000)).toBeUndefined()
  expect(policy.flush()).toBe(25000)
})

test('pause et buffering suspendent la qualification et ne créditent pas leur durée', () => {
  const policy = new PlaybackProgress()
  play(policy, 0, 2)
  policy.observe(observation(2000, 'waiting'), 2000)
  for (let t = 3000; t <= 10000; t += 1000) policy.observe(observation(2000, 'waiting'), t)
  expect(policy.flush()).toBeUndefined()
  play(policy, 2000, 3, 10000)
  expect(policy.flush()).toBe(5000)
})

test('discontinuités natives et gel du navigateur repartent sans crédit fictif', () => {
  const policy = new PlaybackProgress()
  play(policy, 0, 6)
  expect(policy.observe(observation(60000), 7000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
  play(policy, 60000, 3, 7000)
  expect(policy.observe(observation(90000), 40000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
  play(policy, 90000, 5, 40000)
  expect(policy.flush()).toBe(95000)
})

test('transfert fiable préserve une qualification incomplète, transfert incertain la perd', () => {
  const policy = new PlaybackProgress()
  play(policy, 40000, 2)
  policy.transfer(42000)
  policy.observe({ ...observation(42000), positionMs: null, state: 'unavailable' }, 3000)
  play(policy, 42000, 3, 10000)
  expect(policy.flush()).toBe(45000)
  policy.transfer()
  play(policy, 0, 3, 20000)
  expect(policy.flush()).toBeUndefined()
})

test('transfert borné ou réactivation demandent une nouvelle qualification', () => {
  const policy = new PlaybackProgress()
  play(policy, 40000, 6)
  policy.transfer(46000)
  policy.observe(observation(20000, 'paused'), 7000)
  expect(policy.flush()).toBeUndefined()
  play(policy, 20000, 5, 8000)
  expect(policy.flush()).toBe(25000)
  policy.reset()
  expect(policy.flush()).toBeUndefined()
  play(policy, 25000, 4, 14000)
  expect(policy.flush()).toBeUndefined()
})

test('fin qualifiée et marge, sans recréation lors des événements suivants', () => {
  const policy = new PlaybackProgress()
  play(policy, 100000, 5)
  expect(policy.observe(observation(106000, 'playing', 1, 110000), 6000)).toBeNull()
  expect(policy.observe(observation(110000, 'ended', 1, 110000), 7000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
  policy.seek()
  play(policy, 0, 5, 8000)
  expect(policy.flush()).toBe(5000)
})

test('fin après seek non qualifié ne supprime rien ; reprise naturelle courte autorisée', () => {
  const policy = new PlaybackProgress()
  policy.restore(97000)
  policy.observe(observation(97000, 'paused', 1, 100000), 0)
  play(policy, 97000, 2, 1000)
  expect(policy.observe(observation(100000, 'ended', 1, 100000), 4000)).toBeNull()
  const sought = new PlaybackProgress()
  sought.restore(97000)
  sought.seek()
  play(sought, 97000, 2)
  expect(sought.observe(observation(100000, 'ended', 1, 100000), 3000)).toBeUndefined()
})

test('ended sans avance et préparation près de la fin ne suffisent pas', () => {
  const policy = new PlaybackProgress()
  policy.restore(100000)
  expect(policy.observe(observation(100000, 'ended', 1, 100000), 0)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
})

test('durée inconnue ne déclenche pas la marge mais accepte ended qualifié', () => {
  const policy = new PlaybackProgress()
  play(policy, 0, 6)
  expect(policy.observe(observation(6500, 'ended'), 6500)).toBeNull()
})

test('une seule écriture normale en vol et le dernier instantané remplace les intermédiaires', async () => {
  const calls: Array<number | null> = []
  let release!: () => void
  const writer = new PlaybackWrites(async value => {
    calls.push(value)
    await new Promise<void>(resolve => { release = resolve })
  }, () => {})
  writer.submit(10000)
  writer.submit(11000)
  writer.submit(12000)
  expect(calls).toEqual([10000])
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toEqual([10000, 12000])
  writer.enable(false)
  writer.submit(null)
  release()
  await Promise.resolve()
  expect(calls).toEqual([10000, 12000])
})

test('une réponse perdue ne rejoue ni le même instantané ni le lot en attente', async () => {
  const calls: Array<number | null> = []
  let reject!: () => void
  const errors: boolean[] = []
  const writer = new PlaybackWrites(value => {
    calls.push(value)
    return new Promise<void>((_, fail) => { reject = () => fail(new Error('network')) })
  }, failed => errors.push(failed))
  writer.submit(10000)
  writer.submit(12000)
  reject()
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toEqual([10000])
  expect(errors).toEqual([true])
  writer.submit(12000)
  expect(calls).toEqual([10000])
  writer.submit(20000)
  expect(calls).toEqual([10000, 20000])
  reject()
  await Promise.resolve()
})

test('sortie opportuniste dédupliquée, jamais envoyée lorsque le suivi est coupé', async () => {
  const calls: unknown[] = []
  const writer = new PlaybackWrites(async (position, keepalive) => { calls.push({ position, keepalive }) }, () => {})
  writer.submit(6000, true)
  writer.submit(6000, true)
  writer.enable(false)
  writer.submit(null, true)
  expect(calls).toEqual([{ position: 6000, keepalive: true }])
})

test('un transfert qualifié ne sauvegarde pas sa nouvelle position préparée sans avance', () => {
  const policy = new PlaybackProgress()
  play(policy, 40000, 6)
  expect(policy.flush()).toBe(46000)
  policy.transfer(46000)
  expect(policy.observe(observation(46100, 'paused'), 7000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
  play(policy, 46100, 1, 8000)
  expect(policy.flush()).toBe(47100)
})

test('la sortie tente aussi un effacement en attente derrière une écriture normale', async () => {
  const calls: unknown[] = []
  let release!: () => void
  const writer = new PlaybackWrites((position, keepalive) => {
    calls.push({ position, keepalive })
    return keepalive ? Promise.resolve() : new Promise<void>(resolve => { release = resolve })
  }, () => {})
  writer.submit(10000)
  writer.submit(null)
  writer.finish()
  writer.finish()
  writer.enable(false)
  release()
  await Promise.resolve()
  expect(calls).toEqual([{ position: 10000, keepalive: false }, { position: null, keepalive: true }])
})

test('la pause constate aussi une arrivée qualifiée dans la marge de fin', () => {
  const policy = new PlaybackProgress()
  play(policy, 89000, 5)
  expect(policy.observe(observation(95000, 'paused', 1, 100000), 6000)).toBeNull()
  expect(policy.flush()).toBeUndefined()
})

test('une vidéo très courte sans point ne crée rien avant qualification', () => {
  const policy = new PlaybackProgress()
  play(policy, 0, 2)
  expect(policy.observe(observation(3000, 'ended', 1, 3000), 3000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
})

for (const state of ['paused', 'ended'] as const) {
  test('position inconnue puis saut en ' + state + ' exige une nouvelle qualification', () => {
    const policy = new PlaybackProgress()
    policy.restore(40000)
    play(policy, 40000, 6)
    expect(policy.flush()).toBe(46000)
    policy.observe({ ...observation(0, 'waiting'), positionMs: null }, 7000)
    policy.observe({ ...observation(0, 'waiting'), positionMs: null }, 8000)
    expect(policy.flush()).toBeUndefined()
    expect(policy.observe(observation(100000, state, 1, state === 'ended' ? 100000 : 200000), 9000)).toBeUndefined()
    expect(policy.flush()).toBeUndefined()
    play(policy, 100000, 4, 10000)
    expect(policy.flush()).toBeUndefined()
    play(policy, 104000, 1, 14000)
    expect(policy.flush()).toBe(105000)
  })
}

test('buffering sans position puis retour au même temps conserve seulement le crédit acquis', () => {
  const policy = new PlaybackProgress()
  play(policy, 40000, 2)
  for (let at = 3000; at <= 10000; at += 1000) {
    policy.observe({ ...observation(0, 'waiting'), positionMs: null }, at)
    expect(policy.flush()).toBeUndefined()
  }
  expect(policy.observe(observation(42000, 'paused'), 11000)).toBeUndefined()
  play(policy, 42000, 2, 12000)
  expect(policy.flush()).toBeUndefined()
  play(policy, 44000, 1, 14000)
  expect(policy.flush()).toBe(45000)
})

test('un saut après position inconnue invalide aussi l’exception de fin après restauration', () => {
  const policy = new PlaybackProgress()
  policy.restore(40000)
  play(policy, 40000, 2)
  policy.observe({ ...observation(0, 'waiting'), positionMs: null }, 3000)
  expect(policy.observe(observation(100000, 'ended', 1, 100000), 4000)).toBeUndefined()
  expect(policy.flush()).toBeUndefined()
})
