import { test } from 'node:test'
import assert from 'node:assert/strict'
import { table, arrange, act, view, getState, getSecret, fails, create, join, token, freshDb } from './harness.js'

const R = 'rose', S = 'skull'

test('lobby: 3 to 6 players, host starts', async () => {
  const db = await freshDb()
  const g = await create(db, 'Ada', token(0))
  await fails(() => act(db, g.id, token(0), { kind: 'start' }), /3 to 6/)
  await join(db, g.code, 'Bo', token(1))
  await join(db, g.code, 'Cy', token(2))
  await fails(() => act(db, g.id, token(1), { kind: 'start' }), /host/)
  const s = await act(db, g.id, token(0), { kind: 'start' })
  assert.equal(s.phase, 'ante')
  assert.equal(s.players.p1.owned, 4)
  assert.deepEqual((await view(db, g.id, token(0))).hand.sort(), [R, R, R, S].sort())
})

test('rejoining with the same token returns your seat', async () => {
  const db = await freshDb()
  const g = await create(db, 'Ada', token(0))
  await join(db, g.code, 'Bo', token(1))
  assert.equal((await join(db, g.code, 'Bo again', token(1))).me, 'p2')
  assert.equal((await getState(db, g.id)).seats.length, 2)
})

test('ante: everyone places one, the first player places last', async () => {
  const { db, id, toks } = await table(3)
  const st = await getState(db, id)
  const first = st.first
  const others = st.seats.filter(p => p !== first)
  const tokOf = p => toks[st.seats.indexOf(p)]

  await fails(() => act(db, id, tokOf(first), { kind: 'ante', disc: R }), /first player places last/)
  await act(db, id, tokOf(others[0]), { kind: 'ante', disc: R })
  await fails(() => act(db, id, tokOf(others[0]), { kind: 'ante', disc: R }), /already placed/)
  await act(db, id, tokOf(others[1]), { kind: 'ante', disc: S })
  const mid = await getState(db, id)
  assert.equal(mid.phase, 'ante')
  const after = await act(db, id, tokOf(first), { kind: 'ante', disc: R })
  assert.equal(after.phase, 'decide')
  assert.equal(after.turn, first)
  assert.deepEqual(after.players[others[1]].stack, [null])   // a skull looks like anything else
})

// T1 — the headline rule: you flip exactly your bid, and stop.
test('T1 bidding under your own stack stops early and never reveals the rest', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R], place: [S, R, R] },   // skull at the bottom
    p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await act(db, id, toks[0], { kind: 'bid', n: 2 })
  await act(db, id, toks[1], { kind: 'pass' })
  const rev = await act(db, id, toks[2], { kind: 'pass' })
  assert.equal(rev.phase, 'reveal')
  assert.equal(rev.challenger, 'p1')

  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const done = await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  assert.equal(done.outcome.result, 'success')
  assert.equal(done.players.p1.mat, 1)
  assert.deepEqual(done.players.p1.stack, [null, R, R])       // the bottom skull stays hidden
  assert.deepEqual(done.players.p2.stack, [null])             // nobody else was touched
  assert.equal(done.first, 'p1')
})

// T2 — ordering gate.
test('T2 you cannot touch another mat until your own is empty', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [R, S], place: [R, R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 4, bidder: 'p1', flipped: 0 })

  await fails(() => act(db, id, toks[0], { kind: 'flip', target: 'p2' }), /your own discs first/)
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await fails(() => act(db, id, toks[0], { kind: 'flip', target: 'p2' }), /your own discs first/)
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const ok = await act(db, id, toks[0], { kind: 'flip', target: 'p3' })   // now free to choose
  assert.equal(ok.flipped, 3)
})

// T3 — the most commonly mis-implemented rule.
test('T3 a challenger who fails but survives keeps the lead', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [R, S], place: [R, R] }, p2: { hand: [R, R, S], place: [S] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 3, bidder: 'p1', flipped: 0 })

  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p2' })

  assert.equal(st.outcome.result, 'failure')
  assert.equal(st.skullOwner, 'p2')
  assert.equal(st.players.p1.owned, 3)          // lost exactly one, from all four
  assert.equal(st.players.p1.out, false)
  assert.equal(st.first, 'p1')                  // NOT p2
  assert.equal(st.phase, 'result')
  assert.equal(st.pending, null)
  assert.equal((await view(db, id, toks[0])).lost.length, 1)   // only they know which
})

// T4 — elimination by someone else's skull.
test('T4 empty hand forces a bid; elimination hands the lead to the skull owner', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [], place: [R] },              // one disc left, already placed
    p2: { hand: [R, S], place: [R, R] },
    p3: { hand: [R, R, S], place: [S] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await fails(() => act(db, id, toks[0], { kind: 'place', disc: R }), /no rose left/)
  await act(db, id, toks[0], { kind: 'bid', n: 3 })
  await act(db, id, toks[1], { kind: 'pass' })
  await act(db, id, toks[2], { kind: 'pass' })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p3' })

  assert.equal(st.players.p1.owned, 0)
  assert.equal(st.players.p1.out, true)
  assert.equal(st.first, 'p3')                  // the skull's owner
  assert.equal(st.phase, 'result')
})

// T5 / T6 — own skull is an informed choice, and self-elimination is kingmaking.
test('T5 self-elimination lets the eliminated player name the next leader', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [], place: [S] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await act(db, id, toks[0], { kind: 'bid', n: 1 })
  for (const t of [toks[1], toks[2], toks[3]]) await act(db, id, t, { kind: 'pass' })
  const hit = await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  assert.deepEqual(hit.pending, { kind: 'discard', by: 'p1' })   // not the random path

  const gone = await act(db, id, toks[0], { kind: 'discard', disc: S })
  assert.equal(gone.players.p1.out, true)
  assert.deepEqual(gone.pending, { kind: 'first', by: 'p1' })
  await fails(() => act(db, id, toks[1], { kind: 'next' }), /Waiting on a decision/)

  const named = await act(db, id, toks[0], { kind: 'choose_first', player: 'p3' })
  assert.equal(named.first, 'p3')
  const next = await act(db, id, toks[2], { kind: 'next' })
  assert.equal(next.phase, 'ante')
  assert.equal(next.round, 2)
})

test('T6 own skull: the challenger chooses, and may keep the skull', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R], place: [R, S] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 3, bidder: 'p1', flipped: 0 })

  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })     // top disc is their own skull
  await fails(() => act(db, id, toks[0], { kind: 'discard', disc: 'cat' }), /rose or a skull/)
  const st = await act(db, id, toks[0], { kind: 'discard', disc: R })   // keep the skull
  assert.equal(st.players.p1.owned, 3)
  const mine = await view(db, id, toks[0])
  assert.deepEqual(mine.lost, [R])
  assert.equal([...mine.hand, ...mine.stack].filter(d => d === S).length, 1)  // skull retained
  assert.equal(st.first, 'p1')
})

test('T6b the blind draw really can take the skull (~1 in 4)', async () => {
  const db = await freshDb()
  const { rows } = await db.query(`
    select count(*) filter (where lost = 'skull')::int as skulls, count(*)::int as n from (
      select skull.lose('{}'::jsonb,
        jsonb_build_object('hand',  jsonb_build_object('p1','["rose","rose","rose","skull"]'::jsonb),
                           'place', jsonb_build_object('p1','[]'::jsonb),
                           'lost',  jsonb_build_object('p1','[]'::jsonb)),
        'p1', null)->'s'->'pendingLoss'->>'disc' as lost
      from generate_series(1,4000)) t`)
  const { skulls, n } = rows[0]
  assert.ok(skulls / n > 0.2 && skulls / n < 0.3, `skull drawn ${skulls}/${n}`)
})

// T7 — burn out.
test('T7 the maximum bid ends the auction and forces a full reveal', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [R], place: [R, R, R] }, p2: { hand: [R, S], place: [R, R] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  const bid = await act(db, id, toks[0], { kind: 'bid', n: 7 })
  assert.equal(bid.phase, 'reveal')                       // nobody can raise, so nobody is asked
  assert.ok(['p2', 'p3', 'p4'].every(p => bid.players[p].passed))
  await fails(() => act(db, id, toks[1], { kind: 'pass' }), /no bid to pass on/i)

  for (const t of ['p1', 'p1', 'p1', 'p2', 'p2', 'p3']) await act(db, id, toks[0], { kind: 'flip', target: t })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p4' })
  assert.equal(st.outcome.result, 'success')
  assert.equal(st.players.p1.mat, 1)
})

test('bidding: raises only, passing is permanent, ceiling is the table', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await fails(() => act(db, id, toks[0], { kind: 'bid', n: 0 }), /between 1 and 3/)
  await fails(() => act(db, id, toks[0], { kind: 'bid', n: 4 }), /between 1 and 3/)
  await act(db, id, toks[0], { kind: 'bid', n: 1 })
  await fails(() => act(db, id, toks[2], { kind: 'bid', n: 2 }), /Not your turn/)
  await fails(() => act(db, id, toks[1], { kind: 'bid', n: 1 }), /more than 1/)
  await act(db, id, toks[1], { kind: 'bid', n: 2 })
  await act(db, id, toks[2], { kind: 'pass' })
  await fails(() => act(db, id, toks[2], { kind: 'bid', n: 3 }), /Not your turn/)
  const st = await act(db, id, toks[0], { kind: 'pass' })
  assert.equal(st.challenger, 'p2')
  assert.equal(st.phase, 'reveal')
})

test('placing stops the moment anyone opens the bidding', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })
  await act(db, id, toks[0], { kind: 'place', disc: R })
  await act(db, id, toks[1], { kind: 'bid', n: 2 })
  await fails(() => act(db, id, toks[2], { kind: 'place', disc: R }), /cannot place a disc now/)
})

test('two successful challenges win the game', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R], mat: 1 }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 1, bidder: 'p1', flipped: 0 })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  assert.equal(st.phase, 'over')
  assert.equal(st.winner, 'p1')
  assert.equal(st.players.p1.mat, 2)
})

test('last player standing wins', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [], place: [R] }, p2: { hand: [], place: [S] }, p3: { hand: [], place: [R], out: true },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 2, bidder: 'p1', flipped: 0 })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p2' })
  assert.equal(st.phase, 'over')
  assert.equal(st.winner, 'p2')
})

test('a new round returns every disc and clears the table', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R], place: [R, R] }, p2: { hand: [R, R], place: [S] }, p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 2, bidder: 'p1', flipped: 0 })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await fails(() => act(db, id, toks[1], { kind: 'next' }), /next leader/)
  const st = await act(db, id, toks[0], { kind: 'next' })

  assert.equal(st.phase, 'ante')
  assert.equal(st.bid, null)
  assert.equal(st.challenger, null)
  for (const p of ['p1', 'p2', 'p3']) {
    assert.deepEqual(st.players[p].stack, [])
    assert.equal(st.players[p].passed, false)
  }
  const sec = await getSecret(db, id)
  assert.equal(sec.hand.p2.length, 3)                     // skull came back
  assert.deepEqual(sec.place.p2, [])
})

test('eliminated players are skipped and cannot act', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R] }, p2: { hand: [], place: [], out: true },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })
  await fails(() => act(db, id, toks[1], { kind: 'place', disc: R }), /out of the game/)
  const st = await act(db, id, toks[0], { kind: 'place', disc: R })
  assert.equal(st.turn, 'p3')                             // p2 skipped
  await act(db, id, toks[2], { kind: 'bid', n: 4 })       // 4 discs in play, p2 has none
  assert.equal((await getState(db, id)).phase, 'reveal')
})

test('secrets never reach the public row', async () => {
  const { db, id, toks } = await table(3)
  const st = await getState(db, id)
  const json = JSON.stringify(st)
  assert.ok(!json.includes('tok-0000'), 'player tokens leaked into public state')
  assert.ok(!json.includes('"rose"'), 'disc faces leaked into public state')
  assert.equal((await view(db, id, 'tok-0000-1111-2222-3333-9')).me, null)  // unknown token sees no hand
})

test('as anon: only the four entry points are reachable', async () => {
  const { db, id, toks } = await table(3)
  const asAnon = async sql => { await db.exec('set role anon'); try { return await db.query(sql) } finally { await db.exec('reset role') } }
  const denied = async (sql, what) => {
    try { await asAnon(sql) } catch (e) { return e.message }
    throw new Error(`anon could ${what}`)
  }

  await denied(`select * from public.game_secrets`, 'read game_secrets')
  await denied(`update public.games set state='{}'::jsonb`, 'write games directly')
  await denied(`delete from public.games`, 'delete games')
  await denied(`select skull.arr('[]'::jsonb)`, 'call the engine internals')
  await denied(`select skull.apply('{}'::jsonb,'{}'::jsonb,'p1','{}'::jsonb)`, 'call the reducer')

  const r = await asAnon(`select state from public.games where id='${id}'`)   // public state is public
  assert.equal(r.rows.length, 1)
  await db.exec('set role anon')
  try {
    const v = await db.query(`select public.skull_view('${id}'::uuid,$1) as v`, [toks[1]])
    assert.equal(v.rows[0].v.me, 'p2')                    // the entry points still work
  } finally { await db.exec('reset role') }
})

test('a lost disc leaves the game only when the round is cleared away', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, S], place: [R, R] }, p2: { hand: [R, R, S], place: [S] }, p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 3, bidder: 'p1', flipped: 0 })

  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p2' })
  assert.equal(st.players.p1.owned, 3)

  const during = await view(db, id, toks[0])
  assert.equal(during.hand.length + during.stack.length, 4)   // still on the table, still yours to see
  assert.equal(during.lost.length, 1)

  await act(db, id, toks[0], { kind: 'next' })
  const after = await view(db, id, toks[0])
  assert.equal(after.hand.length, 3)
  assert.deepEqual(after.stack, [])
  const sec = await getSecret(db, id)
  assert.equal(sec.pendingLoss, null)
})

// A forged action can omit any argument. Postgres three-valued logic makes every
// `if <guard> then raise` a no-op on NULL, so each of these once slipped through.
test('actions with a missing argument are rejected, not silently misread', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await fails(() => act(db, id, toks[0], { kind: 'bid' }), /number to bid/)
  await fails(() => act(db, id, toks[0], { kind: 'bid', n: 'lots' }), /number to bid/)
  await fails(() => act(db, id, toks[0], { kind: 'place' }), /rose or a skull/)
  const st = await getState(db, id)
  assert.equal(st.phase, 'decide')          // nothing was written
  assert.equal(st.bid, null)
  assert.ok(st.log.length > 0, 'the log survived')
})

test('a missing disc cannot turn the own-skull choice into a random draw', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R], place: [R, S] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 3, bidder: 'p1', flipped: 0 })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await fails(() => act(db, id, toks[0], { kind: 'discard' }), /rose or a skull/)
  assert.equal((await getSecret(db, id)).pendingLoss, null)   // no disc was drawn
})

test('a missing player cannot blank out the next leader', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [], place: [S] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })
  await act(db, id, toks[0], { kind: 'bid', n: 1 })
  for (const t of [toks[1], toks[2], toks[3]]) await act(db, id, t, { kind: 'pass' })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  await act(db, id, toks[0], { kind: 'discard', disc: S })

  await fails(() => act(db, id, toks[0], { kind: 'choose_first' }), /player who is still/)
  const st = await getState(db, id)
  assert.deepEqual(st.pending, { kind: 'first', by: 'p1' })  // still waiting, not wiped
  await fails(() => act(db, id, toks[3], { kind: 'next' }), /Waiting on a decision/)
})

test('the log survives a null message instead of being erased', async () => {
  const db = await freshDb()
  const r = await db.query(`select skull.log('{"log":["a","b"]}'::jsonb, null) as v`)
  assert.deepEqual(r.rows[0].v.log, ['a', 'b'])
})

test('a stranger with the anon key cannot harvest join codes', async () => {
  const { db, id, toks } = await table(3)
  assert.equal((await getState(db, id)).code, undefined)      // not published in the public row
  assert.match((await view(db, id, toks[0])).code, /^[A-Z0-9]{4}$/)   // your own table tells you

  await db.exec('set role anon')
  try {
    await db.query('select code from public.games')
    throw new Error('anon could read every join code')
  } catch (e) {
    assert.match(e.message, /permission denied/)
  } finally { await db.exec('reset role') }
})

test('the join code goes only to someone already holding a seat', async () => {
  const { db, id, toks } = await table(3)
  assert.match((await view(db, id, toks[1])).code, /^[A-Z0-9]{4}$/)
  const stranger = await view(db, id, 'stranger-0000-1111-2222-3333-zz')
  assert.equal(stranger.me, null)
  assert.equal(stranger.code, null)              // ids are enumerable; the code must not be
  await fails(() => view(db, id, 'short'), /Bad player token/)
})

// Elimination needs you down to one disc, and every live player antes one, so an
// eliminated player's hand is always already empty — the disc that leaves is one on
// the board, which stays there because the final table is left standing.
test('an eliminated player holds nothing in hand, on the final move or any other', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [], place: [R] }, p2: { hand: [], place: [S] }, p3: { hand: [], place: [R], out: true },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 2, bidder: 'p1', flipped: 0 })
  await act(db, id, toks[0], { kind: 'flip', target: 'p1' })
  const st = await act(db, id, toks[0], { kind: 'flip', target: 'p2' })

  assert.equal(st.phase, 'over')
  assert.equal(st.players.p1.out, true)
  assert.equal(st.players.p1.owned, 0)
  const mine = await view(db, id, toks[0])
  assert.deepEqual(mine.hand, [])
  assert.deepEqual(mine.stack, [R])                       // still on the frozen board
  assert.equal(mine.stack.length, st.players.p1.stack.length)   // secret mirrors the board
})

test('leaving the lobby frees the seat and the seat id can be reused', async () => {
  const db = await freshDb()
  const g = await create(db, 'Ada', token(0))
  await join(db, g.code, 'Bo', token(1))
  await join(db, g.code, 'Cy', token(2))

  await act(db, g.id, token(1), { kind: 'leave' })
  let st = await getState(db, g.id)
  assert.deepEqual(st.seats, ['p1', 'p3'])
  assert.equal(st.players.p2, undefined)
  assert.equal((await view(db, g.id, token(1))).me, null)      // token released

  const back = await join(db, g.code, 'Di', token(3))
  assert.equal(back.me, 'p2')                                   // the gap is reused, not p3 again
  st = await getState(db, g.id)
  assert.equal(st.players.p2.name, 'Di')
  assert.equal((await act(db, g.id, token(0), { kind: 'start' })).phase, 'ante')
})

test('the host leaving hands the deal to someone else', async () => {
  const db = await freshDb()
  const g = await create(db, 'Ada', token(0))
  await join(db, g.code, 'Bo', token(1))
  await join(db, g.code, 'Cy', token(2))
  await act(db, g.id, token(0), { kind: 'leave' })
  const st = await getState(db, g.id)
  assert.equal(st.host, 'p2')
  await fails(() => act(db, g.id, token(2), { kind: 'start' }), /Only the host/)
})

test('leaving mid-round voids the round and takes your discs out of the game', async () => {
  const { db, id, toks } = await table(4)
  await arrange(db, id, {
    p1: { hand: [R, S], place: [R, R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] }, p4: { hand: [R, R, S], place: [R] },
  }, { phase: 'reveal', first: 'p1', turn: 'p1', challenger: 'p1', bid: 4, bidder: 'p1', flipped: 0 })

  const st = await act(db, id, toks[0], { kind: 'leave' })   // the challenger walks out
  assert.equal(st.players.p1.out, true)
  assert.equal(st.players.p1.owned, 0)
  assert.equal(st.phase, 'ante')                              // round voided, fresh one begins
  assert.equal(st.first, 'p2')                                // next live player clockwise
  assert.equal(st.challenger, null)
  assert.equal(st.bid, null)
  for (const p of ['p2', 'p3', 'p4']) {
    assert.deepEqual(st.players[p].stack, [])
    assert.equal(st.players[p].owned, 4)                      // everyone else is made whole
  }
  assert.deepEqual((await view(db, id, toks[0])).hand, [])
  await fails(() => act(db, id, toks[0], { kind: 'ante', disc: R }), /out of the game/)
})

test('leaving is harmless once you are out, and the last one standing wins', async () => {
  const { db, id, toks } = await table(3)
  await arrange(db, id, {
    p1: { hand: [R, R, S], place: [R] }, p2: { hand: [R, R, S], place: [R] },
    p3: { hand: [R, R, S], place: [R] },
  }, { phase: 'decide', first: 'p1', turn: 'p1' })

  await act(db, id, toks[1], { kind: 'leave' })
  const again = await act(db, id, toks[1], { kind: 'leave' })   // e.g. a second tab closing
  assert.equal(again.phase, 'ante')
  assert.equal(again.round, 2)                                  // not voided twice

  const over = await act(db, id, toks[2], { kind: 'leave' })
  assert.equal(over.phase, 'over')
  assert.equal(over.winner, 'p1')
  await act(db, id, toks[0], { kind: 'leave' })                 // leaving a finished game is a no-op
  assert.equal((await getState(db, id)).winner, 'p1')
})
