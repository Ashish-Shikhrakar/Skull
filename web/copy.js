// Every line the game says. Dry, short, never chirpy.
//
// Lines are written once and read from two sides: "Cy was lying" for the table, "you were
// lying" for Cy. So templates carry grammar, not just names:
//   {W}          the challenger        -> "Cy"      / "you"
//   {Ws}         possessive            -> "Cy's"    / "your"
//   {Wv:was|were} verb agreeing with W -> "was"     / "were"
//   {O} {Os} {Ov:..} the same, for whoever owned the skull
//   {B}          the bid
//
// Reveal lines come from a pool, but the pick must be DETERMINISTIC: six people are looking
// at one table and must read the same sentence. The seed is state they all share.

export const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
const pick = (lines, seed) => lines[hash(String(seed)) % lines.length]
// 'you' can land at the start of any sentence in a template, not just the first
const cap = s => s.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, c) => lead + c.toUpperCase())

export const who = (name, isYou) => ({ name, isYou })

function fill (tpl, { W, O, B }) {
  const subj = p => p.isYou ? 'you' : p.name
  const poss = p => p.isYou ? 'your' : `${p.name}’s`
  return cap(tpl
    .replace(/\{(W|O)v:([^|]+)\|([^}]+)\}/g, (_, k, third, second) => (k === 'W' ? W : O).isYou ? second : third)
    .replace(/\{(W|O)s\}/g, (_, k) => poss(k === 'W' ? W : O))
    .replace(/\{(W|O)\}/g,  (_, k) => subj(k === 'W' ? W : O))
    .replace(/\{B\}/g, B))
}

export const lobby = {
  tagline: 'Three roses and one skull each. The skull ends everything, and nobody has to tell the truth.',
  code: 'Share this code to fill the table',
  copy: 'Copy code',
  copied: 'Copied',
  share: 'Share invite',
  shared: 'Link copied',
  waiting: n => n === 1 ? 'One more player and you can start.' : `${n} more players and you can start.`,
  ready: 'Start the game',
  notHost: host => `${host} starts the game once everyone is in.`,
  seated: '(you)',
  host: 'starts',
  joinedVia: 'You were invited to this table.',
}

export const turn = {
  anteYours: 'Lay one disc face down. Rose or skull — nobody sees which.',
  anteWaitLeader: (n, isYou) => isYou ? 'You lay last. Everyone else goes first.' : `${n} lays last.`,
  anteWaitOthers: names => names.length === 0 ? 'Waiting for the last disc.'
    : names.length === 1 ? `Waiting on ${names[0]}.`
    : `Waiting on ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`,

  decideYours: 'Add another disc, or open the bidding.',
  decideYoursForced: 'Nothing left in hand. You have to bid.',
  decideTheirs: n => `${n} is adding a disc or opening the bidding.`,

  bidYours: b => `Beat ${b}, or pass.`,
  bidTheirs: (n, b) => `${n} has to beat ${b} or pass.`,

  revealOwn: 'Your own mat first, all of it, before you touch anyone else.',
  revealFree: 'Any mat you like now. Top disc only.',
  revealTheirs: n => `${n} is turning discs over.`,
}

// ── the reveal ──────────────────────────────────────────────────────────────
const SUCCESS = {
  timid: [
    '{W} turned one rose. It counts, and it was never in doubt.',
    'One disc, one rose. {W} took the safe road and it paid.',
  ],
  plain: [
    '{W} called {B} and found {B} roses. No drama.',
    '{B} discs, not a skull among them. {W} read the table.',
    '{W} said {B} and meant it.',
  ],
  bold: [
    '{B} discs turned, every one a rose. {W} {Wv:was|were} not guessing.',
    '{W} walked across {B} mats and nothing bit.',
    '{B} for {W}. That was a lot of trust in a room full of liars.',
  ],
  huge: [
    '{B} discs. Not one skull. {W} {Wv:is|are} either reading minds or very lucky.',
    '{W} emptied {B} mats and came back holding flowers. Insufferable.',
    '{B} turned, {B} roses. Somebody at this table is far too honest.',
  ],
}

const OWN_SKULL = [
  '{W} buried a skull and walked straight back into it.',
  '{W} forgot which mat was {Ws}. It was that one.',
  'The skull {W} turned was {Ws} own. It had been sitting there all along.',
]

const THEIR_SKULL = [
  '{O} left a skull, and {W} found it the hard way.',
  '{W} reached across to {O} and came back with a skull.',
  '{O} {Ov:was|were} lying, and {W} paid for believing it.',
]

export function reveal (outcome, { bid, W, O, seed }) {
  const args = { W, O: O ?? W, B: bid }
  if (outcome === 'success') {
    const tier = bid === 1 ? 'timid' : bid <= 3 ? 'plain' : bid <= 5 ? 'bold' : 'huge'
    return fill(pick(SUCCESS[tier], seed), args)
  }
  return fill(pick(args.O.name === W.name ? OWN_SKULL : THEIR_SKULL, seed), args)
}

// The banner that marks the end of a round — two or three words, read at a glance.
export const verdict = {
  success: bid => bid >= 6 ? 'Clean sweep' : bid === 1 ? 'Called it' : 'Made it',
  ownSkull: 'Own skull',
  theirSkull: 'Skull',
  out: 'Knocked out',
  win: 'Wins',
}

export const penalty = {
  ask: 'One disc leaves the game for good. Only you will ever know which.',
  keepSkull: 'Bin a rose',
  keepSkullNote: 'Stay dangerous, carry fewer discs',
  binSkull: 'Bin the skull',
  binSkullNote: 'Safe from now on, and everyone will wonder',
  losing: d => d === 'skull'
    ? 'Your skull is out of the game. Nobody else knows that.'
    : 'A rose is out of the game. As far as anyone knows, it was the skull.',
}

export const kingmaker = {
  ask: 'You are out. Last call: who leads the next round?',
  note: 'No rules about this one. Reward a friend or ruin someone.',
}

export const result = {
  matWon: 'One round won. One more takes it.',
  next: r => `Start round ${r}`,
  waitingLeader: n => `${n} leads the next round.`,
  waitingOn: n => `Waiting on ${n}.`,
}

export const over = {
  wonTwo: (n, isYou) => isYou ? 'Two rounds. The table is yours.' : `${n} won twice. That is the game.`,
  lastStanding: (n, isYou) => isYou ? 'Everyone else ran out. You win by still being here.' : `${n} is the only one left holding discs.`,
  again: 'New table',
}

export const leaving = {
  button: 'Leave',
  confirmLobby: 'Leave the table? Your seat opens up for someone else.',
  confirmGame: 'Leave mid-game? Your discs go with you and the round is scrapped.',
  unload: 'Leaving now forfeits your discs and scraps the round.',
  spectating: 'You can watch, but you are not holding anything.',
  seatEliminated: 'out',
}

export const actions = { pass: 'Pass', bid: 'Bid' }
