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

## Play it right now

```bash
npm install && npm run dev
```

Open http://localhost:5179. This runs the real schema inside [PGlite](https://pglite.dev)
(Postgres compiled to WASM) — same SQL, same rules, no Docker, no Supabase project needed.
State lives in memory and disappears when you stop the server.

`web/config.js` already points at a live Supabase project, so serving `web/` as static files
plays online with other people right now. `SKULL_REAL_CONFIG=1 npm run dev` uses that live
project instead of the in-memory one.

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

The anon key in `config.js` is public by design: it ships to every browser that loads the
game, so committing it leaks nothing that deploying would not. Rotate it in the dashboard if
you would rather not have strangers able to create tables in your project.

Asset URLs carry a `?v=` stamp (`index.html`, and the `copy.js` import in `app.js`). Bump it
when you deploy a change, or browsers will keep running the JS they already cached.

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

## Putting it online

`web/` is a folder of static files with no build step, so any static host works. The only
setting that matters anywhere is **publish the `web` directory, with no build command**.

**Cloudflare Pages** — Workers & Pages → Create → Pages → connect to Git → pick this repo.
Framework preset *None*, build command empty, **build output directory `web`**. Every push to
`main` redeploys.

**Netlify** — Add new site → Import an existing project → pick the repo. Build command empty,
**publish directory `web`**.

**Vercel** — free on the Hobby plan for personal, non-commercial projects. Import the repo,
framework preset *Other*, and set **Root Directory to `web`**. Vercel ignores `web/_headers`;
if you want the same cache rules, add a `vercel.json` with a `headers` block.

**GitHub Pages** — free and the repo is already there, but Pages serves from the repo root, a
`/docs` folder, or a branch, not from `web/`. You would need a small Actions workflow to
publish the folder. The other three are less work.

There is no server to run and no environment variable to set: `web/config.js` already points
at the Supabase project, and the anon key in it is meant to be public.

Two things to know once it is live. Anyone with the URL can create tables in your Supabase
project, which is the free tier's quota to spend — rotate the anon key in the dashboard if
that becomes a problem. And when you change `app.js`, `copy.js` or `style.css`, bump the `?v=`
number in `index.html` and in the `copy.js` import, or returning players keep the JS their
browser already cached.

## Leaving

A game of Skull cannot continue around a missing player — everyone has to lay a disc every
round, and the absent one might be the challenger or the high bidder. So:

- **In the lobby**, leaving just frees the seat, and the seat number is reused by the next
  person to join. If the host leaves, the deal passes to whoever is left.
- **Mid-game**, leaving takes your discs out of the game and **voids the round**. Everyone
  else takes their discs back and the next player clockwise leads. Dropping to one player
  ends the game.
- **Closing the tab really leaves.** The browser warns first; if you go anyway, a
  `keepalive` fetch forfeits the seat on the way out, because supabase-js cannot send during
  unload. Note that a refresh counts as closing — the warning is the only guard.

Someone who left looks exactly like someone eliminated: dimmed seat, no discs, and their own
screen says they can watch but are not holding anything.

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
| `web/copy.js` | every line the game says, and the reveal-line pools |
| `web/style.css` | the felt, the discs, the layout |
| `web/config.js` | your Supabase URL and anon key |
| `test/engine.test.js` | rules scenarios |
| `test/invariants.test.js` | random full games, checking public and secret agree |
| `test/devserver.mjs` | local Postgres-in-WASM server, dev only |

The client is [Preact](https://preactjs.com) + [htm](https://github.com/developit/htm) loaded
straight from a CDN — about 4KB, and still no build step. It is there for one reason: the
previous version rebuilt the whole table on every update, which destroyed the disc elements
mid-animation. Keyed components let each disc keep its identity so it can actually flip.

Reveal lines are picked from a pool, seeded by state every player already shares (round,
challenger, bid, outcome), so all six people read the same sentence rather than six different
ones.

## Deliberate shortcuts

- **Realtime plus a poll.** The client subscribes to `games`, and also refreshes every ~5s
  (faster when the socket is down). Without it, a project where `games` never made it into
  the `supabase_realtime` publication just looks broken.
- **No reconnection or turn timers.** If somebody closes their laptop mid-round, the table
  waits for them. They can rejoin from the same browser; the token is in `localStorage`.
- **The Last Chance disc** (a variant in the 2023 rulebook, off by default and unimplemented
  everywhere I looked) is not implemented.
