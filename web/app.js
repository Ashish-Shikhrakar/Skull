import { h, render } from 'https://esm.sh/preact@10.29.8'
import { useEffect, useRef, useState } from 'https://esm.sh/preact@10.29.8/hooks'
import htm from 'https://esm.sh/htm@3.1.1'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'
import * as C from './copy.js?v=10'   // bump ?v= in index.html and here when you deploy a change

const html = htm.bind(h)
const sb = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null
const SEAT_INK = ['#E8B84B', '#6FB2C9', '#C98BB8', '#8FC08A', '#E08A5A', '#9B93D6']

const ls = {
  get token () {
    let t = localStorage.getItem('skull.token')
    if (!t) { t = crypto.randomUUID() + crypto.randomUUID(); localStorage.setItem('skull.token', t) }
    return t
  },
  get name () { return localStorage.getItem('skull.name') || '' },
  set name (v) { localStorage.setItem('skull.name', v) },
  get game () { return localStorage.getItem('skull.game') || '' },
  set game (v) { v ? localStorage.setItem('skull.game', v) : localStorage.removeItem('skull.game') },
}

// ── store ───────────────────────────────────────────────────────────────────
let G = null                 // { id, code, me, state, hand, stack, lost, losing }
let chan = null, live = false, busy = false, seq = 0
const subs = new Set()
const emit = () => subs.forEach(f => f())

function useGame () {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick(n => n + 1)
    subs.add(f)
    return () => subs.delete(f)
  }, [])
  return G
}

let toastMsg = ''
function toast (m) {
  toastMsg = m; emit()
  clearTimeout(toast.t)
  toast.t = setTimeout(() => { toastMsg = ''; emit() }, 4000)
}

async function call (fn, args) {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(error.message || 'That did not go through. Try again.')
  return data
}

async function refresh () {
  const n = ++seq, gid = G.id
  const v = await call('skull_view', { p_game: gid, p_token: ls.token })
  if (n !== seq || G?.id !== gid) return          // a newer refresh already landed
  if (!v.me) { ls.game = ''; G = null; return emit() }
  Object.assign(G, v)
  emit()
}

async function send (action) {
  if (busy) return
  busy = true
  try { await call('skull_act', { p_game: G.id, p_token: ls.token, p_act: action }); await refresh() }
  catch (e) { toast(e.message) }
  finally { busy = false }
}

function watch (id) {
  chan?.unsubscribe()
  live = false
  chan = sb.channel('skull:' + id)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + id },
        () => { if (!busy) refresh().catch(() => {}) })
    .subscribe(s => { live = s === 'SUBSCRIBED' })
}

// Realtime does the work. Polling is the fallback for a dropped socket, or a project
// where `games` never made it into the supabase_realtime publication.
let beat = 0
setInterval(() => {
  if (!G || busy || document.hidden) return
  if (live && ++beat % 5) return
  beat = 0
  refresh().catch(() => {})
}, 1100)

async function enter (data) {
  G = { id: data.id, code: data.code, me: data.me, state: data.state, hand: [], stack: [], lost: [] }
  ls.game = data.id
  watch(data.id)
  await refresh()
}

function quit () {
  chan?.unsubscribe(); chan = null
  ls.game = ''; G = null; emit()
}

// Closing the tab really does leave, so it has to survive the page going away:
// supabase-js can't send during unload, but fetch with keepalive can.
function leaveBeacon () {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/skull_act`, {
    method: 'POST', keepalive: true,
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_game: G.id, p_token: ls.token, p_act: { kind: 'leave' } }),
  }).catch(() => {})
}

// ── helpers over state ──────────────────────────────────────────────────────
const ink = pid => SEAT_INK[Math.max(0, G.state.seats.indexOf(pid)) % 6]
const nameOf = pid => G.state.players[pid]?.name ?? pid
const mine = () => G.state.players[G.me] ?? {}
const liveSeats = s => s.seats.filter(p => !s.players[p].out)
const facedown = pid => (G.state.players[pid]?.stack ?? []).filter(f => !f).length
const inPlay = s => liveSeats(s).reduce((n, p) => n + s.players[p].stack.length, 0)
const myTurn = () => G.state.turn === G.me && !mine().out
const canFlip = () => G.state.phase === 'reveal' && G.state.challenger === G.me
const canAnte = () => G.state.phase === 'ante' && !mine().out && !mine().stack.length &&
  (G.me !== G.state.first || G.state.seats.every(p => G.state.players[p].out || p === G.me || G.state.players[p].stack.length))

// ── pieces ──────────────────────────────────────────────────────────────────
// `revealed` is the trigger, not `face`: your own face-down discs already show their
// face to you as a ghost, so only their reveal state changes when they are turned over.
function Disc ({ face, seat, ghost, small, revealed }) {
  const ref = useRef(null)
  const was = useRef(revealed)
  useEffect(() => {
    if (!was.current && revealed && ref.current) {
      ref.current.animate(
        [{ transform: 'rotateY(-92deg) scale(1.08)', offset: 0 },
         { transform: 'rotateY(-30deg) scale(1.08)', offset: .45 },
         { transform: 'rotateY(0) scale(1)', offset: 1 }],
        { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)' })
    }
    was.current = revealed
  }, [revealed])

  const kind = face === 'rose' || face === 'skull' ? face : 'back'
  return html`<span ref=${ref}
    class=${`disc face-${kind}${ghost ? ' ghost' : ''}${small ? ' small' : ''}`}
    style=${kind === 'back' ? { '--seat': seat } : null}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><use href=${'#i-' + (kind === 'back' ? 'back' : kind)}/></svg>
  </span>`
}

function Stack ({ pid, player, mineSeat }) {
  if (!player.stack.length) return html`<span class="empty-mat"/>`
  return player.stack.map((face, i) => html`
    <span class="slot" key=${pid + ':' + i} style=${{ '--i': i }}>
      <${Disc} face=${face ?? (mineSeat ? G.stack[i] ?? null : null)}
               ghost=${!face && mineSeat} revealed=${!!face} seat=${ink(pid)}/>
    </span>`)
}

function Seat ({ pid, mineSeat, style }) {
  const s = G.state, p = s.players[pid]
  const targetable = canFlip() && !p.out && p.stack.some(f => !f) && (facedown(G.me) === 0 || pid === G.me)
  const cls = ['seat',
    p.out && 'out', s.turn === pid && !p.out && 'active', s.challenger === pid && 'challenger',
    s.first === pid && s.phase !== 'over' && 'leads', p.passed && 'passed',
    targetable && 'target', mineSeat && 'is-me'].filter(Boolean).join(' ')

  const body = html`
    <div class="mat" style=${{ '--n': Math.max(1, p.stack.length) }}>
      <div class="stack"><${Stack} pid=${pid} player=${p} mineSeat=${mineSeat}/></div>
    </div>
    <div class="who">
      <span class="nm">${p.name}</span>
      ${p.mat ? html`<span class="won" title=${C.result.matWon}><${Disc} face="rose" small/></span>` : null}
    </div>
    <div class="pips" aria-label=${`${p.owned} discs`}>
      ${[0, 1, 2, 3].map(i => html`<i key=${i} class=${i < p.owned ? 'on' : ''}/>`)}
    </div>
    ${p.out ? html`<span class="tagline">${C.leaving.seatEliminated}</span>`
      : p.passed ? html`<span class="tagline">stepped back</span>`
      : s.bidder === pid ? html`<span class="tagline bid">bid ${s.bid}</span>` : null}`

  // Always a button, even when it is not a target: swapping the element type would
  // make Preact tear down the discs inside and the flip animation would never play.
  return html`<button class=${cls} style=${{ ...style, '--seat': ink(pid) }}
      disabled=${!targetable} onClick=${() => send({ kind: 'flip', target: pid })}>${body}</button>`
}

// ── screens ─────────────────────────────────────────────────────────────────
function Setup () {
  return html`<div class="page narrow">
    <h1 class="title">Skull & Roses</h1>
    <div class="card">
      <h2>Point it at a Supabase project</h2>
      <ol class="steps">
        <li>Run <code>sql/schema.sql</code> in the SQL editor.</li>
        <li>Copy the project URL and anon key from Project Settings → API.</li>
        <li>Paste them into <code>web/config.js</code> and reload.</li>
      </ol>
    </div></div>`
}

function Entry () {
  const [name, setName] = useState(ls.name)
  const [code, setCode] = useState('')
  const go = async fn => { try { ls.name = name.trim(); await fn() } catch (e) { toast(e.message) } }

  return html`<div class="page narrow">
    <h1 class="title">Skull & Roses</h1>
    <p class="lede">${C.lobby.tagline}</p>
    <div class="card">
      <label class="field"><span>Your name</span>
        <input value=${name} maxLength=${16} placeholder="Ada" autocomplete="nickname"
               onInput=${e => setName(e.target.value)}/></label>
      <button class="primary" disabled=${!name.trim()}
        onClick=${() => go(async () => enter(await call('skull_create', { p_name: name.trim(), p_token: ls.token })))}>
        Start a table</button>
      <form class="joiner" onSubmit=${e => { e.preventDefault(); go(async () =>
          enter(await call('skull_join', { p_code: code.trim().toUpperCase(), p_name: name.trim(), p_token: ls.token }))) }}>
        <input value=${code} maxLength=${4} placeholder="CODE" aria-label="Table code"
               spellcheck=${false} onInput=${e => setCode(e.target.value)}/>
        <button disabled=${!name.trim() || code.trim().length < 4}>Join</button>
      </form>
    </div>
    <div class="fan" aria-hidden="true">
      <${Disc} face="rose"/><${Disc} face="rose"/><${Disc} face="rose"/><${Disc} face="skull"/>
    </div></div>`
}

function Lobby () {
  const s = G.state, host = s.host === G.me, n = s.seats.length
  return html`<div class="page narrow">
    <h1 class="title small">Skull & Roses</h1>
    <div class="card">
      <p class="muted">${C.lobby.code}</p>
      <p class="code">${G.code ?? ''}</p>
      <ul class="roster">${s.seats.map(pid => html`
        <li key=${pid} style=${{ '--seat': ink(pid) }}>
          <span class="chip"/><span class="nm">${s.players[pid].name}</span>
          ${pid === G.me ? html`<b>${C.lobby.seated}</b>` : null}
          ${pid === s.host ? html`<span class="tagline">${C.lobby.host}</span>` : null}
        </li>`)}</ul>
      ${host
        ? html`<button class="primary" disabled=${n < 3}
            onClick=${() => send({ kind: 'start' })}>
            ${n < 3 ? C.lobby.waiting(3 - n) : C.lobby.ready(n)}</button>`
        : html`<p class="muted">${C.lobby.notHost(s.players[s.host].name)}</p>`}
      <button class="ghost" onClick=${async () => {
        if (!confirm(C.leaving.confirmLobby)) return
        await send({ kind: 'leave' }); quit()
      }}>${C.leaving.button}</button>
    </div></div>`
}

function prompt () {
  const s = G.state
  switch (s.phase) {
    case 'ante': {
      if (canAnte()) return C.turn.anteYours
      const waiting = liveSeats(s).filter(p => !s.players[p].stack.length)
      if (waiting.length === 1 && waiting[0] === s.first)
        return C.turn.anteWaitLeader(nameOf(s.first), s.first === G.me)
      return C.turn.anteWaitOthers(waiting.filter(p => p !== G.me).map(nameOf))
    }
    case 'decide': return myTurn()
      ? (G.hand.length ? C.turn.decideYours : C.turn.decideYoursForced)
      : C.turn.decideTheirs(nameOf(s.turn))
    case 'bid': return myTurn() ? C.turn.bidYours(s.bid) : C.turn.bidTheirs(nameOf(s.turn), s.bid)
    case 'reveal': return canFlip()
      ? (facedown(G.me) ? C.turn.revealOwn : C.turn.revealFree)
      : C.turn.revealTheirs(nameOf(s.challenger))
    case 'result': {
      const o = s.outcome
      if (!o) return ''
      return C.reveal(o.result, {
        bid: s.bid,
        winner: C.you(nameOf(o.challenger), o.challenger === G.me),
        owner: C.you(nameOf(o.skullOwner), o.skullOwner === G.me),
        seed: `${s.round}:${o.challenger}:${s.bid}:${o.result}`,
      })
    }
    case 'over': return s.winner === G.me || liveSeats(s).length === 1
      ? C.over.lastStanding(nameOf(s.winner), s.winner === G.me)
      : C.over.wonTwo(nameOf(s.winner), s.winner === G.me)
  }
  return ''
}

function Actions () {
  const s = G.state
  if (s.phase === 'over') return html`<button class="primary" onClick=${quit}>${C.over.again}</button>`

  if (s.pending?.kind === 'discard' && s.pending.by === G.me) {
    const held = [...G.hand, ...G.stack]
    return html`<div class="choice">
      <p class="ask">${C.penalty.ask}</p>
      <div class="row">
        ${held.includes('rose') ? html`<button class="coin-btn" onClick=${() => send({ kind: 'discard', disc: 'rose' })}>
          <${Disc} face="rose" small/><span><b>${C.penalty.keepSkull}</b>${C.penalty.keepSkullNote}</span></button>` : null}
        ${held.includes('skull') ? html`<button class="coin-btn" onClick=${() => send({ kind: 'discard', disc: 'skull' })}>
          <${Disc} face="skull" small/><span><b>${C.penalty.binSkull}</b>${C.penalty.binSkullNote}</span></button>` : null}
      </div></div>`
  }

  if (s.pending?.kind === 'first' && s.pending.by === G.me) {
    return html`<div class="choice">
      <p class="ask">${C.kingmaker.ask}<i>${C.kingmaker.note}</i></p>
      <div class="row">${liveSeats(s).map(pid => html`
        <button key=${pid} onClick=${() => send({ kind: 'choose_first', player: pid })}>${nameOf(pid)}</button>`)}</div></div>`
  }

  if (s.phase === 'result') {
    if (s.pending) return html`<p class="muted">${C.result.waitingOn(nameOf(s.pending.by))}</p>`
    return s.first === G.me
      ? html`<button class="primary" onClick=${() => send({ kind: 'next' })}>${C.result.next(s.round + 1)}</button>`
      : html`<p class="muted">${C.result.waitingLeader(nameOf(s.first))}</p>`
  }

  if ((s.phase === 'decide' || s.phase === 'bid') && myTurn()) {
    const from = (s.bid ?? 0) + 1, max = inPlay(s)
    return html`<div class="bidrow">
      ${from <= max ? html`<div class="bids"><span class="ask">Bid</span>
        ${Array.from({ length: max - from + 1 }, (_, i) => html`
          <button class="num" key=${from + i} onClick=${() => send({ kind: 'bid', n: from + i })}>${from + i}</button>`)}
      </div>` : null}
      ${s.phase === 'bid' ? html`<button onClick=${() => send({ kind: 'pass' })}>Step back</button>` : null}
    </div>`
  }
  return null
}

function Table () {
  const s = G.state
  const i = s.seats.indexOf(G.me)
  const others = [...s.seats.slice(i + 1), ...s.seats.slice(0, i)]
  const playable = canAnte() || (s.phase === 'decide' && myTurn())
  const kind = s.phase === 'ante' ? 'ante' : 'place'
  const counts = G.hand.reduce((m, d) => (m[d] = (m[d] || 0) + 1, m), {})
  let leaving = G.losing
  const mark = d => (leaving === d && !(leaving = null))

  // Opponents ring the far arc, you sit at the near edge — one table, not two rows.
  const place = (k, n) => {
    const t = n === 1 ? 0.5 : k / (n - 1)
    const a = (200 + 140 * t) * Math.PI / 180
    return { left: `${50 + 38 * Math.cos(a)}%`, top: `${48 + 30 * Math.sin(a)}%` }
  }

  return html`<div class="page table">
    <header class="rail">
      <span class="brand">Skull & Roses</span>
      <span class="muted">Round ${s.round} · ${G.code ?? ''}</span>
      <button class="ghost" onClick=${async () => {
        if (!confirm(s.phase === 'over' ? C.leaving.confirmLobby : C.leaving.confirmGame)) return
        await send({ kind: 'leave' }); quit()
      }}>${C.leaving.button}</button>
    </header>

    <section class="felt">
      ${others.map((pid, k) => html`<${Seat} key=${pid} pid=${pid} style=${place(k, others.length)}/>`)}
      <${Seat} key=${G.me} pid=${G.me} mineSeat=${true} style=${{ left: '50%', top: '86%' }}/>
      <div class=${`call ${s.outcome?.result ?? ''}`}>
        ${s.phase === 'reveal'
          ? html`<span class="big">${s.flipped}<i>/${s.bid}</i></span>`
          : s.bid ? html`<span class="big">${s.bid}</span>`
          : html`<span class="big quiet">${s.phase === 'over' ? '★' : '·'}</span>`}
        <span class="sub">${s.phase === 'reveal' ? 'turned over'
          : s.bid ? `${nameOf(s.bidder)}’s bid` : s.phase === 'ante' ? 'lay one down' : 'no bid yet'}</span>
      </div>
    </section>

    <p class="prompt">${prompt()}</p>

    <section class="you">
      <div class="hand">
        ${mine().out
          ? html`<p class="muted">${C.leaving.spectating}</p>`
          : ['rose', 'skull'].flatMap(d => Array.from({ length: counts[d] || 0 }, (_, k) => {
              const out = mark(d)
              return playable && !out
                ? html`<button class="coin-btn bare" key=${d + k} title=${`Lay a ${d}`}
                    onClick=${() => send({ kind, disc: d })}><${Disc} face=${d}/></button>`
                : html`<span class=${'coin-btn bare idle' + (out ? ' leaving' : '')} key=${d + k}><${Disc} face=${d}/></span>`
            }))}
      </div>
      ${G.losing ? html`<p class="losing">${C.penalty.losing(G.losing)}</p>` : null}
      <div class="actions"><${Actions}/></div>
    </section>
  </div>`
}

function App () {
  const g = useGame()

  useEffect(() => {
    const warn = e => {
      if (!G || G.state.phase === 'over' || mine().out) return
      e.preventDefault(); e.returnValue = C.leaving.unload; return e.returnValue
    }
    const gone = () => { if (G && G.state.phase !== 'over' && !mine().out) leaveBeacon() }
    addEventListener('beforeunload', warn)
    addEventListener('pagehide', gone)
    return () => { removeEventListener('beforeunload', warn); removeEventListener('pagehide', gone) }
  }, [])

  const screen = !sb ? html`<${Setup}/>` : !g ? html`<${Entry}/>`
    : g.state.phase === 'lobby' ? html`<${Lobby}/>` : html`<${Table}/>`
  return html`<${'div'}>
    ${screen}
    <p id="say" class="sr-only" role="status" aria-live="polite">${g && g.state.phase !== 'lobby' ? prompt() : ''}</p>
    <div id="toast" class=${toastMsg ? 'show' : ''} role="status" aria-live="assertive">${toastMsg}</div>
  <//>`
}

;(async () => {
  render(html`<${App}/>`, document.getElementById('app'))
  if (!sb || !ls.game) return
  try { G = { id: ls.game }; watch(ls.game); await refresh() }
  catch { ls.game = ''; G = null; emit() }
})()
