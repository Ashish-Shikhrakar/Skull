import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const app = document.getElementById('app')
const toastEl = document.getElementById('toast')
const SEAT_INK = ['#D8A94A', '#6FB2C9', '#C98BB8', '#8FC08A', '#E08A5A', '#9B93D6']

const sb = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null

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

let G = null          // { id, code, me, state, hand, stack, lost }
let chan = null
let busy = false
let lastFlip = null   // seat whose disc just turned over, for the flip animation

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ink = pid => SEAT_INK[(G.state.seats.indexOf(pid) + 6) % 6]
const nameOf = pid => G.state.players[pid]?.name ?? pid

function toast (msg) {
  toastEl.textContent = msg
  toastEl.className = 'show'
  clearTimeout(toast.t)
  toast.t = setTimeout(() => { toastEl.className = '' }, 3600)
}

async function call (fn, args) {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(error.message || 'Something went wrong. Try again.')
  return data
}

// ── data ────────────────────────────────────────────────────────────────────
let seq = 0
async function refresh () {
  const n = ++seq, gid = G.id
  const v = await call('skull_view', { p_game: gid, p_token: ls.token })
  if (n !== seq || G?.id !== gid) return        // a newer refresh already landed; don't roll it back
  if (!v.me) { ls.game = ''; G = null; return render() }
  if (G.state) {                                   // note which mat just turned a disc over
    for (const pid of v.state.seats) {
      const was = G.state.players[pid]?.stack ?? [], now = v.state.players[pid].stack
      if (now.some((face, i) => face && !was[i])) lastFlip = pid
    }
  }
  Object.assign(G, v)
  render()
}

async function send (action) {
  if (busy) return
  busy = true
  try { await call('skull_act', { p_game: G.id, p_token: ls.token, p_act: action }); await refresh() }
  catch (e) { toast(e.message) }
  finally { busy = false }
}

let live = false
function watch (id) {
  chan?.unsubscribe()
  live = false
  chan = sb.channel('skull:' + id)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + id },
        () => { if (!busy) refresh().catch(() => {}) })
    .subscribe(status => { live = status === 'SUBSCRIBED' })
}
// Realtime does the work. Polling is the fallback for a dropped socket, or for a project
// where `games` never made it into the supabase_realtime publication — without it the
// table would just sit there looking broken.
let beat = 0
setInterval(() => {
  if (!G || busy || document.hidden) return
  if (live && ++beat % 5) return          // 5s when pushed to, ~1s when not
  beat = 0
  refresh().catch(() => {})
}, 1100)

async function enter (data) {
  G = { id: data.id, code: data.code, me: data.me, state: data.state, hand: [], stack: [], lost: [] }
  ls.game = data.id
  watch(data.id)
  await refresh()
}

// ── pieces ──────────────────────────────────────────────────────────────────
function disc (face, { seat, ghost, cls = '' } = {}) {
  if (face === 'rose' || face === 'skull') {
    return `<span class="disc face-${face}${ghost ? ' ghost' : ''} ${cls}"><svg viewBox="0 0 100 100"><use href="#i-${face}"/></svg></span>`
  }
  return `<span class="disc face-back ${cls}" style="--seat:${seat}"><svg viewBox="0 0 100 100"><use href="#i-back"/></svg></span>`
}

function stack (pid, p, mine) {
  if (!p.stack.length) return `<span class="empty-mat" aria-hidden="true"></span>`
  return p.stack.map((face, i) => {
    const known = face ?? (mine ? G.stack[i] ?? null : null)
    const flip = face && pid === lastFlip && i === p.stack.findIndex(f => f)
    return `<span class="slot" style="--i:${i}">${disc(known, {
      seat: ink(pid), ghost: !face && mine, cls: flip ? 'just-flipped' : '',
    })}</span>`
  }).join('')
}

function pips (p) {
  return `<span class="pips" aria-label="${p.owned} discs left">` +
    Array.from({ length: 4 }, (_, i) => `<i class="${i < p.owned ? 'on' : ''}"></i>`).join('') + `</span>`
}

function seat (pid, { mine = false } = {}) {
  const s = G.state, p = s.players[pid]
  const flags = [
    p.out && 'out', s.turn === pid && 'active', s.challenger === pid && 'challenger',
    s.first === pid && s.phase !== 'over' && 'leads', p.passed && 'passed',
  ].filter(Boolean)
  const target = canFlip() && !p.out && p.stack.some(f => !f) &&
    (facedown(G.me) === 0 || pid === G.me)
  const tag = target ? 'button' : 'div'
  const attrs = target ? ` data-act="flip" data-pid="${pid}"` : ''
  return `<${tag} class="seat ${flags.join(' ')}${target ? ' target' : ''}" style="--seat:${ink(pid)}"${attrs}>
      <div class="mat"><div class="stack">${stack(pid, p, mine)}</div></div>
      <div class="who">
        <span class="nm">${esc(p.name)}${mine ? ' <b>(you)</b>' : ''}</span>
        ${p.mat ? '<span class="won" title="Won a round">' + disc('rose', { cls: 'tiny' }) + '</span>' : ''}
      </div>
      ${pips(p)}
      ${p.out ? '<span class="tagline">out</span>'
        : p.passed ? '<span class="tagline">passed</span>'
        : s.bidder === pid ? `<span class="tagline bid">bid ${s.bid}</span>` : ''}
    </${tag}>`
}

const facedown = pid => (G.state.players[pid]?.stack ?? []).filter(f => !f).length
const mine = () => G.state.players[G.me]
const myTurn = () => G.state.turn === G.me && !mine().out
const canFlip = () => G.state.phase === 'reveal' && G.state.challenger === G.me
const canAnte = () => G.state.phase === 'ante' && !mine().out && mine().stack.length === 0 &&
  (G.me !== G.state.first || G.state.seats.every(p => G.state.players[p].out || p === G.me || G.state.players[p].stack.length))

// ── screens ─────────────────────────────────────────────────────────────────
function renderSetup () {
  app.innerHTML = `<div class="page narrow">
    <h1 class="title">Skull &amp; Roses</h1>
    <div class="card">
      <h2>Point it at your Supabase project</h2>
      <ol class="steps">
        <li>Run <code>sql/schema.sql</code> in your project's SQL editor.</li>
        <li>Copy the Project URL and anon key from Project Settings → API.</li>
        <li>Paste them into <code>web/config.js</code> and reload this page.</li>
      </ol>
    </div></div>`
}

function renderEntry () {
  app.innerHTML = `<div class="page narrow">
    <h1 class="title">Skull &amp; Roses</h1>
    <p class="lede">Three roses and one skull. Bet you can turn over more flowers than anyone else —
      and hope nobody buried a skull under yours.</p>
    <div class="card">
      <label class="field"><span>Your name</span>
        <input id="nm" maxlength="16" value="${esc(ls.name)}" placeholder="Ada" autocomplete="nickname"></label>
      <div class="split">
        <button class="primary" data-act="create">Start a table</button>
        <form class="joiner" data-act="join-form">
          <input id="code" maxlength="4" placeholder="CODE" aria-label="Game code"
                 autocapitalize="characters" spellcheck="false">
          <button type="submit">Join</button>
        </form>
      </div>
    </div>
    <div class="fan" aria-hidden="true">
      ${disc('rose')}${disc('rose')}${disc('rose')}${disc('skull')}
    </div></div>`
}

function renderLobby () {
  const s = G.state, host = s.host === G.me, n = s.seats.length
  app.innerHTML = `<div class="page narrow">
    <h1 class="title small">Skull &amp; Roses</h1>
    <div class="card">
      <p class="lede">Share this code:</p>
      <p class="code">${esc(G.code ?? '')}</p>
      <ul class="roster">${s.seats.map(pid => `<li style="--seat:${ink(pid)}">
        <span class="chip"></span>${esc(s.players[pid].name)}${pid === G.me ? ' <b>(you)</b>' : ''}
        ${pid === s.host ? '<span class="tagline">host</span>' : ''}</li>`).join('')}</ul>
      ${host
        ? `<button class="primary" data-act="start" ${n < 3 ? 'disabled' : ''}>
             ${n < 3 ? `Waiting for ${3 - n} more` : `Deal ${n} in`}</button>`
        : `<p class="muted">Waiting for ${esc(s.players[s.host].name)} to deal.</p>`}
      <button class="ghost" data-act="leave">Leave</button>
    </div></div>`
}

function promptLine () {
  const s = G.state
  const who = pid => pid === G.me ? 'You' : nameOf(pid)
  switch (s.phase) {
    case 'ante': {
      const waiting = s.seats.filter(p => !s.players[p].out && !s.players[p].stack.length)
      if (canAnte()) return 'Place a disc face down.'
      if (waiting.length === 1 && waiting[0] === s.first) return `${who(s.first)} place${s.first === G.me ? '' : 's'} last.`
      return `Waiting on ${waiting.filter(p => p !== G.me).map(nameOf).join(', ')}.`
    }
    case 'decide': return myTurn() ? 'Place another disc, or open the bidding.'
      : `${nameOf(s.turn)} is placing or bidding.`
    case 'bid': return myTurn() ? `Raise above ${s.bid}, or pass.` : `${nameOf(s.turn)} is deciding.`
    case 'reveal': return canFlip()
      ? (facedown(G.me) ? 'Turn over your own discs first.' : 'Choose a mat to turn over.')
      : `${nameOf(s.challenger)} is turning discs over.`
    case 'result': return resultLine()
    case 'over': return s.winner === G.me ? 'You win.' : `${nameOf(s.winner)} wins.`
  }
  return ''
}

function resultLine () {
  const s = G.state, o = s.outcome
  if (!o) return ''
  const who = o.challenger === G.me ? 'You' : nameOf(o.challenger)
  if (o.result === 'success') return `${who} made ${s.bid}.`
  const owner = o.skullOwner === o.challenger ? 'their own' : `${nameOf(o.skullOwner)}'s`
  return `${who} hit ${o.skullOwner === G.me ? 'your' : owner} skull.`
}

function actionBar () {
  const s = G.state, out = []
  if (s.phase === 'over') {
    out.push(`<button class="primary" data-act="leave">New game</button>`)
    return out.join('')
  }
  if (s.pending?.kind === 'discard' && s.pending.by === G.me) {
    const held = [...G.hand, ...G.stack]
    out.push(`<p class="ask">One disc leaves the game. Only you will know which.</p>`)
    for (const d of ['rose', 'skull']) {
      if (held.includes(d)) out.push(`<button class="coin-btn" data-act="discard" data-disc="${d}">
        ${disc(d)}<span>Lose the ${d}</span></button>`)
    }
    return out.join('')
  }
  if (s.pending?.kind === 'first' && s.pending.by === G.me) {
    out.push(`<p class="ask">You're out. Name who leads next.</p>`)
    for (const pid of s.seats.filter(p => !s.players[p].out)) {
      out.push(`<button data-act="choose" data-pid="${pid}">${esc(nameOf(pid))}</button>`)
    }
    return out.join('')
  }
  if (s.phase === 'result') {
    if (s.pending) return `<p class="muted">Waiting on ${esc(nameOf(s.pending.by))}.</p>`
    return s.first === G.me
      ? `<button class="primary" data-act="next">Start round ${s.round + 1}</button>`
      : `<p class="muted">${esc(nameOf(s.first))} leads the next round.</p>`
  }
  if ((s.phase === 'decide' || s.phase === 'bid') && myTurn()) {
    const inPlay = s.seats.filter(p => !s.players[p].out)
      .reduce((n, p) => n + s.players[p].stack.length, 0)
    const from = (s.bid ?? 0) + 1
    if (from <= inPlay) {
      out.push(`<div class="bids"><span class="ask">Bid</span>` +
        Array.from({ length: inPlay - from + 1 }, (_, i) =>
          `<button class="num" data-act="bid" data-n="${from + i}">${from + i}</button>`).join('') + `</div>`)
    }
    if (s.phase === 'bid') out.push(`<button data-act="pass">Pass</button>`)
  }
  return out.join('')
}

function say (msg) {
  const el = document.getElementById('say')
  if (el.textContent !== msg) el.textContent = msg     // a region rebuilt each render never announces
}

function renderTable () {
  const s = G.state
  const i = s.seats.indexOf(G.me)
  const others = [...s.seats.slice(i + 1), ...s.seats.slice(0, i)]
  const handPlayable = canAnte() || (s.phase === 'decide' && myTurn())
  const kind = s.phase === 'ante' ? 'ante' : 'place'
  const counts = G.hand.reduce((m, d) => (m[d] = (m[d] || 0) + 1, m), {})
  let leaving = G.losing            // one of these discs is being binned this round
  const mark = d => (leaving === d && !(leaving = null)) ? ' leaving' : ''

  app.innerHTML = `<div class="page table">
    <header class="rail">
      <span class="brand">Skull &amp; Roses</span>
      <span class="muted">Round ${s.round} · table ${esc(G.code ?? '')}</span>
    </header>

    <section class="seats">${others.map(pid => seat(pid)).join('')}</section>

    <section class="call ${s.phase}">
      <div class="ring ${s.outcome?.result ?? ''}">
        ${s.phase === 'reveal' ? `<span class="big">${s.flipped}<i>/${s.bid}</i></span>`
          : s.bid ? `<span class="big">${s.bid}</span>`
          : `<span class="big quiet">${s.phase === 'over' ? '★' : '·'}</span>`}
        <span class="sub">${s.phase === 'reveal' ? 'turned over'
          : s.bid ? `${esc(nameOf(s.bidder))}'s bid` : s.phase === 'ante' ? 'place one' : 'no bid yet'}</span>
      </div>
      <p class="prompt">${esc(promptLine())}</p>
    </section>

    <section class="you">
      ${seat(G.me, { mine: true })}
      <div class="hand">
        ${['rose', 'skull'].flatMap(d => Array.from({ length: counts[d] || 0 }, () => {
          const out = mark(d)
          return handPlayable && !out
            ? `<button class="coin-btn" data-act="${kind}" data-disc="${d}" title="Place a ${d}">${disc(d)}</button>`
            : `<span class="coin-btn idle${out}">${disc(d)}</span>`
        })).join('') || '<span class="muted">No discs in hand.</span>'}
        ${G.losing ? `<p class="losing">This ${G.losing} leaves the game. Only you know that.</p>` : ''}
      </div>
      <div class="actions">${actionBar()}</div>
    </section>

    <footer class="log">${s.log.slice(-3).reverse()
      .map(l => `<span>${esc(String(l).replace(/\bp[1-6]\b/g, m => nameOf(m)))}</span>`).join('')}</footer>
  </div>`
}

let painted = ''
function render () {
  if (!sb) return renderSetup()
  const key = G ? JSON.stringify([G.state, G.hand, G.stack, G.losing, lastFlip]) : 'entry'
  if (key === painted) return          // polling must not steal focus or kill a hover
  painted = key
  if (!G) return renderEntry()
  if (G.state.phase === 'lobby') return renderLobby()
  renderTable()
  say(promptLine())
}

// ── input ───────────────────────────────────────────────────────────────────
app.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]')
  if (!el || el.tagName === 'FORM') return
  const a = el.dataset.act
  const nm = () => (document.getElementById('nm')?.value || '').trim()

  if (a === 'create') {
    if (!nm()) return toast('Enter a name first.')
    ls.name = nm()
    try { await enter(await call('skull_create', { p_name: nm(), p_token: ls.token })) }
    catch (err) { toast(err.message) }
  } else if (a === 'leave') {
    chan?.unsubscribe(); chan = null; ls.game = ''; G = null; render()
  } else if (a === 'start')   await send({ kind: 'start' })
  else if (a === 'ante')      await send({ kind: 'ante',  disc: el.dataset.disc })
  else if (a === 'place')     await send({ kind: 'place', disc: el.dataset.disc })
  else if (a === 'bid')       await send({ kind: 'bid', n: +el.dataset.n })
  else if (a === 'pass')      await send({ kind: 'pass' })
  else if (a === 'flip')      await send({ kind: 'flip', target: el.dataset.pid })
  else if (a === 'discard')   await send({ kind: 'discard', disc: el.dataset.disc })
  else if (a === 'choose')    await send({ kind: 'choose_first', player: el.dataset.pid })
  else if (a === 'next')      await send({ kind: 'next' })
})

app.addEventListener('submit', async e => {
  if (e.target.dataset.act !== 'join-form') return
  e.preventDefault()
  const name = (document.getElementById('nm')?.value || '').trim()
  const code = (document.getElementById('code')?.value || '').trim().toUpperCase()
  if (!name) return toast('Enter a name first.')
  if (!code) return toast('Enter the table code.')
  ls.name = name
  try { await enter(await call('skull_join', { p_code: code, p_name: name, p_token: ls.token })) }
  catch (err) { toast(err.message) }
})

// ── boot ────────────────────────────────────────────────────────────────────
;(async () => {
  if (!sb) return render()
  const id = ls.game
  if (!id) return render()
  try {
    G = { id }
    watch(id)
    await refresh()
  } catch { ls.game = ''; G = null; render() }
})()
