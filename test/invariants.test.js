// Plays whole games by picking a legal action at random, and checks after every move
// that the public row and the secret still agree. Anything this catches is a real bug:
// these are properties, not scripted expectations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { table, act, getState, getSecret } from './harness.js'

const pick = a => a[Math.floor(Math.random() * a.length)]
const live = s => s.seats.filter(p => !s.players[p].out)

function check (s, sec, where) {
  for (const pid of s.seats) {
    const pub = s.players[pid].stack, place = sec.place[pid] ?? []
    const at = m => `${where}: ${pid} ${m}`

    assert.equal(pub.length, place.length, at('secret placements do not match the board'))
    pub.forEach((face, i) => {
      if (face) assert.equal(face, place[i], at(`revealed disc ${i} is not the one placed`))
    })
    // Revealed discs must be a contiguous run down from the top of the stack.
    const firstFace = pub.findIndex(f => f)
    if (firstFace !== -1) assert.ok(pub.slice(firstFace).every(f => f), at('revealed discs are not contiguous'))

    const pending = sec.pendingLoss?.pid === pid ? 1 : 0
    assert.equal(s.players[pid].owned, (sec.hand[pid] ?? []).length + place.length - pending,
      at('disc count disagrees with what they hold'))
    if (s.players[pid].out) {
      assert.equal(s.players[pid].owned, 0, at('is out but still counted as holding discs'))
      assert.deepEqual(sec.hand[pid] ?? [], [], at('is out but still has discs in hand'))
    }
  }
  if (s.phase === 'reveal') {
    assert.ok(s.bid >= 1 && s.flipped < s.bid, `${where}: reveal with a nonsense bid`)
    assert.equal(s.challenger, s.bidder, `${where}: challenger is not the high bidder`)
  }
}

async function playOut (db, id, toks) {
  const tokOf = pid => toks[+pid.slice(1) - 1]
  for (let move = 0; move < 600; move++) {
    const s = await getState(db, id)
    const sec = await getSecret(db, id)
    check(s, sec, `move ${move} / ${s.phase}`)
    if (s.phase === 'over') return move

    const hand = pid => sec.hand[pid] ?? []
    if (s.phase === 'ante') {
      const yet = live(s).filter(p => !s.players[p].stack.length)
      const who = yet.length === 1 ? yet[0] : pick(yet.filter(p => p !== s.first))
      await act(db, id, tokOf(who), { kind: 'ante', disc: pick(hand(who)) })
    } else if (s.phase === 'decide') {
      const me = s.turn, inPlay = live(s).reduce((n, p) => n + s.players[p].stack.length, 0)
      if (hand(me).length && Math.random() < 0.55) {
        await act(db, id, tokOf(me), { kind: 'place', disc: pick(hand(me)) })
      } else {
        await act(db, id, tokOf(me), { kind: 'bid', n: 1 + Math.floor(Math.random() * inPlay) })
      }
    } else if (s.phase === 'bid') {
      const me = s.turn, inPlay = live(s).reduce((n, p) => n + s.players[p].stack.length, 0)
      if (s.bid < inPlay && Math.random() < 0.4) {
        await act(db, id, tokOf(me), { kind: 'bid', n: s.bid + 1 + Math.floor(Math.random() * (inPlay - s.bid)) })
      } else {
        await act(db, id, tokOf(me), { kind: 'pass' })
      }
    } else if (s.phase === 'reveal') {
      const me = s.challenger
      const mine = s.players[me].stack.some(f => !f)
      const target = mine ? me : pick(live(s).filter(p => s.players[p].stack.some(f => !f)))
      await act(db, id, tokOf(me), { kind: 'flip', target })
    } else if (s.phase === 'result') {
      if (s.pending?.kind === 'discard') {
        const held = [...hand(s.pending.by), ...(sec.place[s.pending.by] ?? [])]
        await act(db, id, tokOf(s.pending.by), { kind: 'discard', disc: pick(held) })
      } else if (s.pending?.kind === 'first') {
        await act(db, id, tokOf(s.pending.by), { kind: 'choose_first', player: pick(live(s)) })
      } else {
        await act(db, id, tokOf(s.first), { kind: 'next' })
      }
    }
  }
  assert.fail('a game ran 600 moves without ending')
}

for (const n of [3, 4, 6]) {
  test(`random ${n}-player games stay self-consistent and terminate`, async () => {
    for (let game = 0; game < 3; game++) {
      const { db, id, toks } = await table(n)
      const moves = await playOut(db, id, toks)
      const s = await getState(db, id)
      assert.ok(s.winner, 'the game ended without a winner')
      assert.ok(moves > 3, 'suspiciously short game')
    }
  })
}
