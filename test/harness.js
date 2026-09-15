import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

export async function freshDb() {
  const db = await PGlite.create()
  await db.exec(`create role anon; create role authenticated;`)   // Supabase provides these
  await db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'))
  return db
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0].v

export const token = n => `tok-0000-1111-2222-3333-${n}`
export const create = (db, name, tok) => one(db, 'select public.skull_create($1,$2) as v', [name, tok])
export const join = (db, code, name, tok) => one(db, 'select public.skull_join($1,$2,$3) as v', [code, name, tok])
export const act = (db, id, tok, a) =>
  one(db, 'select public.skull_act($1::uuid,$2,$3::jsonb) as v', [id, tok, JSON.stringify(a)])
export const view = (db, id, tok) => one(db, 'select public.skull_view($1::uuid,$2) as v', [id, tok])

export const getState = (db, id) => one(db, 'select state as v from public.games where id=$1::uuid', [id])
export const getSecret = (db, id) =>
  one(db, 'select secret as v from public.game_secrets where game_id=$1::uuid', [id])

export const setState = (db, id, s) =>
  db.query('update public.games set state=$2::jsonb where id=$1::uuid', [id, JSON.stringify(s)])
export const setSecret = (db, id, s) =>
  db.query('update public.game_secrets set secret=$2::jsonb where game_id=$1::uuid', [id, JSON.stringify(s)])

/** Seat `n` players and start. Returns { id, code, toks, state }. */
export async function table(n = 3) {
  const db = await freshDb()
  const toks = Array.from({ length: n }, (_, i) => token(i))
  const names = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay']
  const g = await create(db, names[0], toks[0])
  for (let i = 1; i < n; i++) await join(db, g.code, names[i], toks[i])
  await act(db, g.id, toks[0], { kind: 'start' })
  return { db, id: g.id, code: g.code, toks }
}

/**
 * Force an exact position. spec maps seat -> {hand, place, mat, out, passed}.
 * Public stack/owned are derived so the two halves of the state stay consistent.
 */
export async function arrange(db, id, spec, extra = {}) {
  const state = await getState(db, id)
  const secret = await getSecret(db, id)
  for (const [pid, v] of Object.entries(spec)) {
    const hand = v.hand ?? [], place = v.place ?? []
    secret.hand[pid] = hand
    secret.place[pid] = place
    const p = state.players[pid]
    p.stack = place.map((f, i) => (v.revealed ?? 0) > place.length - 1 - i ? f : null)
    p.owned = hand.length + place.length
    p.mat = v.mat ?? 0
    p.out = v.out ?? false
    p.passed = v.passed ?? false
  }
  Object.assign(state, extra)
  await setState(db, id, state)
  await setSecret(db, id, secret)
  return state
}

export const fails = async (fn, re) => {
  try { await fn() } catch (e) { 
    if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`)
    return e.message 
  }
  throw new Error('expected the move to be rejected, but it was allowed')
}
