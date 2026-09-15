# Skull & Roses

The bluffing game by Hervé Marly, for 3–6 players, over the web. Everyone puts discs face
down, somebody bets they can turn over that many flowers without hitting a skull, and the
whole game is whether you believe them.

Rules follow the official English rulebooks (2011 "Skull & Roses" and 2023 "Skull",
Space Cowboys), including the three that most implementations get wrong:

- You flip **exactly your bid**. Your own mat comes first and must be exhausted before you
  touch anyone else's, but a bid smaller than your own stack stops early — the discs under
  it are never revealed.
- A challenger who fails **keeps the lead** for the next round. The skull's owner only takes
  it if the challenger was eliminated; a challenger who eliminated themselves *names* the
  next leader as their last act.
- The first player places their opening disc **last**.

## Play it right now, with no account

```bash
npm install && npm run dev
```

Open http://localhost:5179. This runs the real schema inside [PGlite](https://pglite.dev)
(Postgres compiled to WASM) — same SQL, same rules, no Docker, no Supabase project. State
lives in memory and disappears when you stop the server. Good for one machine; for playing
with other people, set up Supabase below.

## Play it with other people

1. **Create a Supabase project**, open the SQL editor, paste in [`sql/schema.sql`](sql/schema.sql)
   and run it. That is the entire backend — tables, rules engine, and API.
2. **Copy your keys** from Project Settings → API into [`web/config.js`](web/config.js):

   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co'
   export const SUPABASE_ANON_KEY = 'eyJ...'
   ```
3. **Serve `web/`** as static files — anything will do (`npx serve web`, Netlify, Vercel,
   GitHub Pages, S3). There is no build step.

Then one player starts a table and reads out the four-letter code.

## How the hidden information stays hidden

A bluffing game is only worth playing if the client genuinely cannot see the discs, so no
disc face is ever sent to a browser that shouldn't have it.

- **The rules run in the database.** `skull.apply` is the whole state machine. Clients send
  intents (`bid 3`, `flip p2`); they never send state. An illegal move is rejected by
  Postgres, not by the UI.
- **Two tables.** `games` holds public state only. `game_secrets` holds disc faces, hands,
  and player tokens, has RLS enabled with **no policies** (which denies everything), and is
  not in the Realtime publication. This split is load-bearing: Realtime ships whole rows and
  redacts columns per *role*, not per *user*, so a secret column on `games` would be
  broadcast to every subscriber.
- **The engine is not reachable.** Everything except four entry points lives in the `skull`
  schema, which PostgREST does not expose. The four RPCs are `SECURITY DEFINER` with a pinned
  empty `search_path`, and EXECUTE is revoked from `anon`/`authenticated` before being granted
  back only to them — revoking from `PUBLIC` alone is not enough, because Supabase grants
  those roles EXECUTE on `public` functions directly.
- **The join code is a credential.** It is the only thing gating a seat, so it is kept out of
  the public row and out of the `anon` column grant — otherwise anyone holding the anon key
  could list every open lobby and walk into it. You get your own table's code from the RPC.
- **You are a token.** Each browser generates a random identifier and keeps it in
  `localStorage`; it is the only thing that proves a seat is yours. No signup, no email, no
  dashboard settings to enable. To lose a disc secretly, the server picks it and tells nobody
  but you — `skull_view` returns your hand, your own face-down discs, and what you just lost.

Concurrent moves are serialised by `SELECT … FOR UPDATE` on the game row; PostgREST runs each
RPC in its own transaction, so the lock covers the whole move.

## Tests

```bash
npm test
```

Scenario tests plus a property-based fuzz pass, all against the real schema in PGlite. The
scenarios cover the rules above, elimination and kingmaking, the maximum-bid burn-out, both
win conditions, and that `anon` cannot read
`game_secrets`, write `games`, harvest join codes, or call the engine directly. There is also
a check that the blind draw really can take your skull — a real bug in at least one published
implementation makes it unreachable — and a set of forged-action tests, because Postgres
three-valued logic quietly turns `if <guard> then raise` into a no-op when an argument is
NULL, which is how a client omitting one field could once deadlock a game.

`test/invariants.test.js` then plays whole games by picking a legal action at random and
asserts after every single move that the public row and the secret still agree: stacks the
same length, every revealed disc the one actually placed, revealed discs contiguous from the
top, disc counts matching what each player holds, and nobody out while still holding
anything. Anything it catches is a real bug rather than a broken expectation.

## Files

| | |
|---|---|
| `sql/schema.sql` | the whole backend: tables, RLS, rules engine, four RPCs |
| `web/index.html` | markup and the rose/skull/disc-back artwork |
| `web/app.js` | client: rendering, input, Realtime subscription |
| `web/style.css` | the felt, the discs, the layout |
| `web/config.js` | your Supabase URL and anon key |
| `test/engine.test.js` | rules scenarios |
| `test/invariants.test.js` | random full games, checking public and secret agree |
| `test/devserver.mjs` | local Postgres-in-WASM server, dev only |

## Deliberate shortcuts

- **Realtime plus a poll.** The client subscribes to `games`, and also refreshes every ~5s
  (faster when the socket is down). Without it, a project where `games` never made it into
  the `supabase_realtime` publication just looks broken.
- **No reconnection or turn timers.** If somebody closes their laptop mid-round, the table
  waits for them. They can rejoin from the same browser; the token is in `localStorage`.
- **The Last Chance disc** (a variant in the 2023 rulebook, off by default and unimplemented
  everywhere I looked) is not implemented.
