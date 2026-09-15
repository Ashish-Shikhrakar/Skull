// Every line the game says. Dry, short, never chirpy.
//
// Reveal lines are picked from a pool, but the pick has to be DETERMINISTIC: all six
// players are looking at the same table, so they must all read the same sentence.
// The seed is state everyone already shares.

const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
const pick = (lines, seed) => lines[hash(String(seed)) % lines.length]

export const you = (name, isYou) => isYou ? 'you' : name
const Cap = s => s[0].toUpperCase() + s.slice(1)

export const lobby = {
  tagline: 'Three roses and one skull each. The skull ends everything, and nobody has to tell the truth.',
  code: 'Anyone with this code can sit down',
  waiting: n => n === 1 ? 'One more and you can deal.' : `${n} more and you can deal.`,
  ready: n => `Deal ${n} in`,
  notHost: host => `${host} deals when everyone is here.`,
  seated: '(you)',
  host: 'deals',
}

export const turn = {
  // Opening placement: everyone lays one disc, and the leader goes last.
  anteYours: 'Lay one face down. Rose or skull — nobody sees which.',
  anteWaitLeader: (n, isYou) => isYou
    ? 'You lay last. Everyone else first.'
    : `${n} lays last.`,
  anteWaitOthers: names => names.length === 1
    ? `Waiting on ${names[0]}.`
    : `Waiting on ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`,

  decideYours: 'Add another disc, or open the bidding.',
  decideYoursForced: 'Nothing left in hand. You have to bid.',
  decideTheirs: n => `${n} is adding a disc or opening the bidding.`,

  bidYours: b => `Beat ${b}, or step back.`,
  bidTheirs: (n, b) => `${n} has to beat ${b} or step back.`,

  revealOwn: 'Your own mat first, all of it, before you touch anyone else.',
  revealFree: 'Any mat you like now. Top disc only.',
  revealTheirs: n => `${n} is turning discs over.`,
}

export const bidNote = (bid, inPlay) =>
  bid === inPlay ? 'Every disc on the table. Nobody can raise that.'
  : bid === 1 ? 'The smallest bet there is.'
  : ''

// ── the reveal ──────────────────────────────────────────────────────────────
const SUCCESS = {
  timid: [                       // bid of 1
    '{W} turned one rose. It counts, and it was never going to be hard.',
    'One disc, one rose. {W} took the safe road and it paid.',
  ],
  plain: [                       // 2–3
    '{W} called {B} and found {B} roses. No drama.',
    '{B} discs, not a skull among them. {W} read the table.',
    '{W} said {B} and meant it.',
  ],
  bold: [                        // 4–5
    '{B} discs turned, every one a rose. {W} was not guessing.',
    '{W} walked across {B} mats and nothing bit.',
    '{B} for {W}. That was a lot of trust in a room full of liars.',
  ],
  huge: [                        // 6+
    '{B} discs. Not one skull. {W} is either reading minds or very lucky.',
    '{W} emptied {B} mats and came back with flowers. Insufferable.',
    '{B} turned, {B} roses. Somebody at this table is too honest.',
  ],
}

const OWN_SKULL = [
  '{W} buried a skull and then walked straight into it.',
  '{W} forgot which mat was theirs. It was that one.',
  'The skull was {W}’s own. It had been sitting there the whole time.',
]

const THEIR_SKULL = [
  '{O} left a skull. {W} found it the hard way.',
  '{W} reached across to {O} and pulled out a skull.',
  '{O} was lying. {W} paid for believing them.',
]

export function reveal (outcome, { bid, winner, owner, seed }) {
  const fill = s => s.replace(/\{W\}/g, Cap(winner)).replace(/\{B\}/g, bid).replace(/\{O\}/g, owner)
  if (outcome === 'success') {
    const tier = bid === 1 ? 'timid' : bid <= 3 ? 'plain' : bid <= 5 ? 'bold' : 'huge'
    return fill(pick(SUCCESS[tier], seed))
  }
  return fill(pick(owner === winner ? OWN_SKULL : THEIR_SKULL, seed))
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
  blind: (o, isYou) => isYou
    ? `${o} took one of your discs without looking. You saw which.`
    : 'A disc was taken at random. Only its owner knows what it was.',
}

export const kingmaker = {
  ask: 'You are out. Last call: who leads the next round?',
  note: 'No rules about this. Reward a friend or ruin someone.',
}

export const result = {
  matWon: 'One round won. One more takes it.',
  next: r => `Deal round ${r}`,
  waitingLeader: n => `${n} leads the next round.`,
  waitingOn: n => `Waiting on ${n}.`,
  eliminated: n => `${n} is out of discs, and out.`,
}

export const over = {
  wonTwo: (n, isYou) => isYou ? 'Two rounds. The table is yours.' : `${n} won twice. That's the game.`,
  lastStanding: (n, isYou) => isYou ? 'Everyone else ran out. You win by still being here.' : `${n} is the only one left holding discs.`,
  again: 'New table',
}

export const leaving = {
  button: 'Leave',
  confirmLobby: 'Leave the table? Your seat opens up for someone else.',
  confirmGame: 'Leave mid-game? Your discs go with you and the round is scrapped.',
  unload: 'Leaving now forfeits your discs and scraps the round.',
  gone: 'You left the table.',
  spectating: 'You can watch, but you are not holding anything.',
  seatOut: 'left',
  seatEliminated: 'out',
}
