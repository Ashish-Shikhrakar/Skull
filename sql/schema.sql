-- Skull & Roses — complete backend. Paste this into the Supabase SQL editor and run it.
-- Safe to re-run: every object is create-or-replace / if-not-exists.
--
-- The engine lives in the `skull` schema, which PostgREST does not expose, so the only
-- things a client can call are the four entry points in `public` at the end of this file.
-- Public state and secret state are SEPARATE TABLES on purpose: Realtime ships whole
-- rows, so a secret column on `games` would be broadcast to every subscriber.

create schema if not exists skull;

create table if not exists public.games (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  state      jsonb not null,               -- public: safe for anyone at the table to see
  updated_at timestamptz not null default now()
);

create table if not exists public.game_secrets (
  game_id uuid primary key references public.games(id) on delete cascade,
  secret  jsonb not null                   -- disc faces, hands, player tokens. Never leaves the DB.
);

create index if not exists games_code_idx on public.games (code);

alter table public.games        enable row level security;
alter table public.game_secrets enable row level security;

drop policy if exists games_public_read on public.games;
create policy games_public_read on public.games for select using (true);
-- game_secrets deliberately has NO policy: RLS with zero policies denies everything.

-- Supabase default-grants everything in `public` to anon; RLS already blocks writes,
-- but there is no reason for the privilege to exist.
revoke all on public.games        from anon, authenticated;
revoke all on public.game_secrets from anon, authenticated;

-- Read access to public state only — Realtime needs it to deliver row changes.
-- Every write goes through the RPCs. game_secrets stays unreachable. `code` is left
-- out on purpose: it is the only thing gating a seat, so it must not be harvestable
-- from the anon key. Players get it from skull_create / skull_join / skull_view.
grant select (id, state, updated_at) on public.games to anon, authenticated;

-- Realtime pushes public state to subscribers.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end $$;


-- ── helpers ─────────────────────────────────────────────────────────────────
-- All pure; all operate on the public state jsonb.

create or replace function skull.arr(j jsonb) returns text[]
language sql immutable as $$ select coalesce(array(select jsonb_array_elements_text(j)), '{}'::text[]) $$;

-- Remove the first occurrence of v. Returns null when v is absent.
create or replace function skull.take(a text[], v text) returns text[]
language sql immutable as $$
  select case when i is null then null else a[1:i-1] || a[i+1:array_length(a,1)] end
  from (select array_position(a, v) as i) t
$$;

create or replace function skull.live(g jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(s order by ord), '{}'::text[])
  from jsonb_array_elements_text(g->'seats') with ordinality as x(s, ord)
  where not coalesce((g->'players'->s->>'out')::boolean, false)
$$;

-- Next live seat clockwise from pid, skipping eliminated players and optionally passed ones.
create or replace function skull.next(g jsonb, pid text, skip_passed boolean default false)
returns text language plpgsql immutable as $$
declare
  seats text[] := skull.arr(g->'seats');
  n int := array_length(seats, 1);
  start int := array_position(seats, pid);
  i int; c text;
begin
  if start is null then return null; end if;
  for i in 1..n loop
    c := seats[((start - 1 + i) % n) + 1];
    if c = pid then continue; end if;
    if coalesce((g->'players'->c->>'out')::boolean, false) then continue; end if;
    if skip_passed and coalesce((g->'players'->c->>'passed')::boolean, false) then continue; end if;
    return c;
  end loop;
  return null;
end $$;

-- Discs currently on the table (frozen the moment bidding opens, since placing then stops).
create or replace function skull.in_play(g jsonb) returns int
language sql immutable as $$
  select coalesce(sum(jsonb_array_length(g->'players'->s->'stack')), 0)::int
  from unnest(skull.live(g)) as s
$$;

-- Facedown discs left on a mat (revealed discs are always a contiguous run from the top).
create or replace function skull.facedown(g jsonb, pid text) returns int
language sql immutable as $$
  select count(*)::int from jsonb_array_elements(g->'players'->pid->'stack') e where e = 'null'::jsonb
$$;

create or replace function skull.log(g jsonb, msg text) returns jsonb
language sql immutable as $$
  -- `jsonb || NULL` is NULL, which would blank the whole log. Keep it instead.
  select case when msg is null then g else jsonb_set(g, '{log}',
    (select coalesce(jsonb_agg(e), '[]'::jsonb)
     from (select e from jsonb_array_elements((g->'log') || to_jsonb(msg)) with ordinality t(e, o)
           order by o offset greatest(0, jsonb_array_length((g->'log') || to_jsonb(msg)) - 40)) z)) end
$$;


-- ── round resolution ────────────────────────────────────────────────────────
-- Remove one disc from a player's holdings, permanently. disc = null means a blind
-- random draw (an opponent's skull); a named disc is the own-skull case, where the
-- challenger chooses knowingly. Either way only that player ever learns which it was.
create or replace function skull.lose(g jsonb, s jsonb, pid text, disc text)
returns jsonb language plpgsql as $$
declare pool text[] := skull.arr(s->'hand'->pid) || skull.arr(s->'place'->pid);
begin
  if coalesce(array_length(pool, 1), 0) = 0 then
    raise exception 'no discs to lose';
  end if;
  if disc is null then
    disc := pool[1 + floor(random() * array_length(pool, 1))::int];   -- uniform over placed and unplaced alike
  end if;
  if array_position(pool, disc) is null then raise exception 'You are not holding a %', disc; end if;

  -- Recorded now, removed when the round is cleared away, so the table (and the player)
  -- can still see how the challenge ended. Only this player ever learns which disc it was.
  s := jsonb_set(s, '{pendingLoss}', jsonb_build_object('pid', pid, 'disc', disc));
  s := jsonb_set(s, array['lost', pid], (s->'lost'->pid) || to_jsonb(disc));
  return jsonb_build_object('g', g, 's', s);
end $$;

-- Settle a finished challenge: elimination, game over, and who leads the next round.
create or replace function skull.finish(g jsonb, s jsonb)
returns jsonb language plpgsql as $$
declare
  ch    text   := g->>'challenger';
  so    text   := g->>'skullOwner';
  owned int;
  live  text[];
begin
  owned := coalesce(array_length(skull.arr(s->'hand'->ch), 1), 0)
         + coalesce(array_length(skull.arr(s->'place'->ch), 1), 0)
         - (case when s->'pendingLoss'->>'pid' = ch then 1 else 0 end);
  g := jsonb_set(g, array['players', ch, 'owned'], to_jsonb(owned));
  if owned = 0 then
    g := jsonb_set(g, array['players', ch, 'out'], 'true'::jsonb);
    g := skull.log(g, ch || ' lost their last disc and is out');
  end if;

  live := skull.live(g);

  if g->>'winner' is not null then
    g := jsonb_set(g, '{phase}', '"over"');
  elsif coalesce(array_length(live, 1), 0) <= 1 then
    g := jsonb_set(g, '{winner}', to_jsonb(live[1]));
    g := jsonb_set(g, '{phase}',  '"over"');
    g := skull.log(g, live[1] || ' is the last player standing');
  else
    if not coalesce((g->'players'->ch->>'out')::boolean, false) then
      g := jsonb_set(g, '{first}', to_jsonb(ch));            -- challenger keeps the lead, win or lose
    elsif so is not null and so <> ch then
      g := jsonb_set(g, '{first}', to_jsonb(so));            -- knocked out by someone else's skull
    else
      g := jsonb_set(g, '{pending}',                          -- self-eliminated: they name the next leader
             jsonb_build_object('kind', 'first', 'by', ch));
    end if;
    g := jsonb_set(g, '{phase}', '"result"');
    g := jsonb_set(g, '{turn}',
           to_jsonb(coalesce(g->'pending'->>'by', g->>'first')));
  end if;
  return jsonb_build_object('g', g, 's', s);
end $$;

-- Everyone takes their discs back; a fresh round begins.
create or replace function skull.next_round(g jsonb, s jsonb)
returns jsonb language plpgsql as $$
declare pid text; held text[];
begin
  foreach pid in array skull.arr(g->'seats') loop
    held := skull.arr(s->'hand'->pid) || skull.arr(s->'place'->pid);
    if s->'pendingLoss'->>'pid' = pid then
      held := skull.take(held, s->'pendingLoss'->>'disc');       -- the disc leaves the game now
    end if;
    s := jsonb_set(s, array['hand',  pid], to_jsonb(held));
    s := jsonb_set(s, array['place', pid], '[]'::jsonb);
    g := jsonb_set(g, array['players', pid, 'stack'],  '[]'::jsonb);
    g := jsonb_set(g, array['players', pid, 'passed'], 'false'::jsonb);
  end loop;
  s := jsonb_set(s, '{pendingLoss}', 'null'::jsonb);
  g := g || jsonb_build_object(
         'phase', 'ante', 'round', (g->>'round')::int + 1, 'turn', null,
         'bid', null, 'bidder', null, 'challenger', null, 'flipped', 0,
         'skullOwner', null, 'outcome', null, 'pending', null);
  return jsonb_build_object('g', g, 's', s);
end $$;


-- ── the reducer ─────────────────────────────────────────────────────────────
create or replace function skull.to_reveal(g jsonb) returns jsonb
language sql immutable as $$
  select skull.log(
    $1 || jsonb_build_object('phase','reveal','challenger',$1->>'bidder','flipped',0,'turn',$1->>'bidder'),
    ($1->>'bidder') || ' must flip ' || ($1->>'bid') || ' without a skull')
$$;

-- The whole game in one reducer. Raises on any illegal move; the message is shown to the player.
create or replace function skull.apply(g jsonb, s jsonb, me text, act jsonb)
returns jsonb language plpgsql as $$
declare
  kind   text := act->>'kind';
  ph     text := g->>'phase';
  disc   text; tgt text; nxt text; face text; pid text;
  n int; idx int; inplay int; mat int;
  rest text[]; live text[]; seats text[]; remaining text[];
  r jsonb;
begin
  if me is null then raise exception 'You are not in this game'; end if;
  if coalesce((g->'players'->me->>'out')::boolean, false) and kind <> 'choose_first' then
    raise exception 'You are out of the game';
  end if;

  -- Action arguments come from the client and may be missing or junk. Postgres
  -- three-valued logic would turn every `if <guard> then raise` below into a no-op
  -- on NULL, so nothing past here may read an unchecked argument.
  disc := act->>'disc';
  if kind in ('ante','place','discard') and coalesce(disc,'') not in ('rose','skull') then
    raise exception 'Pick a rose or a skull';
  end if;
  if kind = 'bid' and coalesce(act->>'n','') !~ '^[0-9]{1,3}$' then
    raise exception 'Pick a number to bid';
  end if;
  if kind = 'choose_first' and coalesce(act->>'player','') = '' then
    raise exception 'Pick a player who is still in the game';
  end if;

  -- ── start ────────────────────────────────────────────────────────────────
  if kind = 'start' then
    if ph <> 'lobby' then raise exception 'The game has already started'; end if;
    if me <> g->>'host' then raise exception 'Only the host can start the game'; end if;
    seats := skull.arr(g->'seats');
    if coalesce(array_length(seats,1),0) < 3 or array_length(seats,1) > 6 then
      raise exception 'Skull needs 3 to 6 players';
    end if;
    foreach pid in array seats loop
      s := jsonb_set(s, array['hand',  pid], '["rose","rose","rose","skull"]'::jsonb);
      s := jsonb_set(s, array['place', pid], '[]'::jsonb);
      s := jsonb_set(s, array['lost',  pid], '[]'::jsonb);
    end loop;
    g := g || jsonb_build_object('phase','ante','round',1,
           'first', seats[1 + floor(random()*array_length(seats,1))::int]);
    g := skull.log(g, 'Round 1 — ' || (g->>'first') || ' leads');

  -- ── place a disc (opening ante, or another disc on your turn) ─────────────
  elsif kind in ('ante','place') then
    if kind = 'ante' then
      if ph <> 'ante' then raise exception 'Not the opening placement'; end if;
      if jsonb_array_length(g->'players'->me->'stack') > 0 then
        raise exception 'You have already placed this round';
      end if;
      if me = g->>'first' then
        foreach pid in array skull.live(g) loop
          if pid <> me and jsonb_array_length(g->'players'->pid->'stack') = 0 then
            raise exception 'The first player places last';
          end if;
        end loop;
      end if;
    else
      if ph <> 'decide' then raise exception 'You cannot place a disc now'; end if;
      if g->>'turn' <> me then raise exception 'Not your turn'; end if;
    end if;

    rest := skull.take(skull.arr(s->'hand'->me), disc);
    if rest is null then raise exception 'You have no % left in hand', disc; end if;
    s := jsonb_set(s, array['hand',  me], to_jsonb(rest));
    s := jsonb_set(s, array['place', me], (s->'place'->me) || to_jsonb(disc));
    g := jsonb_set(g, array['players', me, 'stack'], (g->'players'->me->'stack') || 'null'::jsonb);

    if kind = 'ante' then
      live := skull.live(g);
      if (select count(*) from unnest(live) x
          where jsonb_array_length(g->'players'->x->'stack') = 0) = 0 then
        g := g || jsonb_build_object('phase','decide','turn', g->>'first');
      end if;
    else
      g := jsonb_set(g, '{turn}', to_jsonb(skull.next(g, me)));
    end if;

  -- ── bid ──────────────────────────────────────────────────────────────────
  elsif kind = 'bid' then
    n := (act->>'n')::int;
    inplay := skull.in_play(g);
    if g->>'turn' <> me then raise exception 'Not your turn'; end if;
    if ph = 'decide' then
      if n < 1 or n > inplay then raise exception 'Bid between 1 and %', inplay; end if;
      g := jsonb_set(g, '{phase}', '"bid"');
    elsif ph = 'bid' then
      if n <= (g->>'bid')::int then raise exception 'You must bid more than %', g->>'bid'; end if;
      if n > inplay then raise exception 'Only % discs are on the table', inplay; end if;
    else
      raise exception 'You cannot bid now';
    end if;
    g := g || jsonb_build_object('bid', n, 'bidder', me);
    g := skull.log(g, me || ' bids ' || n);

    if n = inplay then
      -- Nobody can raise a maximum bid, so the rest of the table passes by default.
      foreach pid in array skull.live(g) loop
        if pid <> me then g := jsonb_set(g, array['players',pid,'passed'], 'true'::jsonb); end if;
      end loop;
      g := skull.to_reveal(g);
    else
      nxt := skull.next(g, me, true);
      if nxt is null then g := skull.to_reveal(g);
      else g := jsonb_set(g, '{turn}', to_jsonb(nxt)); end if;
    end if;

  -- ── pass ─────────────────────────────────────────────────────────────────
  elsif kind = 'pass' then
    if ph <> 'bid' then raise exception 'There is no bid to pass on'; end if;
    if g->>'turn' <> me then raise exception 'Not your turn'; end if;
    g := jsonb_set(g, array['players', me, 'passed'], 'true'::jsonb);
    g := skull.log(g, me || ' passes');
    remaining := array(select x from unnest(skull.live(g)) x
                       where not coalesce((g->'players'->x->>'passed')::boolean, false));
    if coalesce(array_length(remaining,1),0) = 1 then
      g := skull.to_reveal(g);
    else
      g := jsonb_set(g, '{turn}', to_jsonb(skull.next(g, me, true)));
    end if;

  -- ── flip ─────────────────────────────────────────────────────────────────
  elsif kind = 'flip' then
    if ph <> 'reveal' then raise exception 'Nothing to flip'; end if;
    if g->>'challenger' <> me then raise exception 'Only the challenger flips'; end if;
    tgt := coalesce(act->>'target', me);
    if g->'players'->tgt is null or coalesce((g->'players'->tgt->>'out')::boolean, true) then
      raise exception 'No such player at the table';
    end if;
    if skull.facedown(g, tgt) = 0 then raise exception 'Nothing left to flip there'; end if;
    if skull.facedown(g, me) > 0 and tgt <> me then
      raise exception 'Flip all of your own discs first';
    end if;

    idx  := skull.facedown(g, tgt) - 1;      -- revealed discs run down from the top
    face := (skull.arr(s->'place'->tgt))[idx + 1];
    g := jsonb_set(g, array['players', tgt, 'stack', idx::text], to_jsonb(face));
    g := jsonb_set(g, '{flipped}', to_jsonb((g->>'flipped')::int + 1));

    if face = 'skull' then
      g := g || jsonb_build_object('skullOwner', tgt,
             'outcome', jsonb_build_object('result','failure','challenger',me,'skullOwner',tgt));
      g := skull.log(g, me || ' hit a skull');
      if tgt = me then
        g := g || jsonb_build_object('phase','result','turn',me,
               'pending', jsonb_build_object('kind','discard','by',me));
      else
        r := skull.lose(g, s, me, null);  g := r->'g'; s := r->'s';
        r := skull.finish(g, s);          g := r->'g'; s := r->'s';
      end if;
    elsif (g->>'flipped')::int = (g->>'bid')::int then
      mat := (g->'players'->me->>'mat')::int + 1;
      g := jsonb_set(g, array['players', me, 'mat'], to_jsonb(mat));
      g := jsonb_set(g, '{outcome}', jsonb_build_object('result','success','challenger',me));
      g := skull.log(g, me || ' made the bid');
      if mat >= 2 then g := jsonb_set(g, '{winner}', to_jsonb(me)); end if;
      r := skull.finish(g, s); g := r->'g'; s := r->'s';
    end if;

  -- ── own skull: choose which disc to bin ──────────────────────────────────
  elsif kind = 'discard' then
    if coalesce(g->'pending'->>'kind','') <> 'discard' or g->'pending'->>'by' <> me then
      raise exception 'You have nothing to discard';
    end if;
    r := skull.lose(g, s, me, disc); g := r->'g'; s := r->'s';
    g := jsonb_set(g, '{pending}', 'null'::jsonb);
    r := skull.finish(g, s); g := r->'g'; s := r->'s';

  -- ── self-eliminated challenger names the next leader ─────────────────────
  elsif kind = 'choose_first' then
    if coalesce(g->'pending'->>'kind','') <> 'first' or g->'pending'->>'by' <> me then
      raise exception 'That is not your choice to make';
    end if;
    tgt := act->>'player';
    if not (tgt = any(skull.live(g))) then raise exception 'That player is out'; end if;
    g := g || jsonb_build_object('first', tgt, 'pending', null, 'turn', tgt);
    g := skull.log(g, me || ' hands the lead to ' || tgt);

  -- ── start the next round ─────────────────────────────────────────────────
  elsif kind = 'next' then
    if ph <> 'result' then raise exception 'The round is not over'; end if;
    if coalesce(g->'pending', 'null'::jsonb) <> 'null'::jsonb then
      raise exception 'Waiting on a decision first';
    end if;
    if g->>'first' <> me then raise exception 'The next leader starts the round'; end if;
    r := skull.next_round(g, s); g := r->'g'; s := r->'s';
    g := skull.log(g, 'Round ' || (g->>'round') || ' — ' || (g->>'first') || ' leads');

  else
    raise exception 'Unknown action %', kind;
  end if;

  return jsonb_build_object('g', g, 's', s);
end $$;


-- ── RPC surface ─────────────────────────────────────────────────────────────
-- Everything a client can do. Tables are unreachable directly (RLS); these run as
-- definer so the engine, and only the engine, touches state. The player's identity
-- is an opaque token they generated locally and kept in their own browser.

create or replace function skull.seat(p_name text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'owned', 4, 'mat', 0,
                            'out', false, 'passed', false, 'stack', jsonb_build_array())
$$;

create or replace function skull.clean_name(p_name text) returns text
language plpgsql immutable as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if v = '' then raise exception 'Enter a name'; end if;
  return left(v, 16);
end $$;

create or replace function skull.check_token(p_token text) returns void
language plpgsql immutable as $$
begin
  if p_token is null or length(p_token) < 20 then raise exception 'Bad player token'; end if;
end $$;

-- Start a new table. Returns the join code and the caller's seat.
create or replace function public.skull_create(p_name text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_id uuid; g jsonb; s jsonb; i int;
begin
  perform skull.check_token(p_token);
  p_name := skull.clean_name(p_name);

  for i in 1..30 loop
    v_code := (select string_agg(substr('ACDEFGHJKLMNPQRTUVWXY34679',
                                        1 + floor(random() * 26)::int, 1), '')
               from generate_series(1, 4));
    exit when not exists (select 1 from public.games gm where gm.code = v_code);
    v_code := null;
  end loop;
  if v_code is null then raise exception 'Could not allocate a game code, try again'; end if;

  g := jsonb_build_object(
         'phase','lobby', 'round',0, 'seats', jsonb_build_array('p1'), 'host','p1',
         'first',null, 'turn',null, 'bid',null, 'bidder',null, 'challenger',null,
         'flipped',0, 'skullOwner',null, 'pending',null, 'outcome',null, 'winner',null,
         'players', jsonb_build_object('p1', skull.seat(p_name)),
         'log', jsonb_build_array());
  s := jsonb_build_object('tokens', jsonb_build_object(p_token, 'p1'), 'pendingLoss', null,
                          'hand', '{}'::jsonb, 'place', '{}'::jsonb, 'lost', '{}'::jsonb);

  insert into public.games (code, state) values (v_code, g) returning id into v_id;
  insert into public.game_secrets (game_id, secret) values (v_id, s);
  return jsonb_build_object('id', v_id, 'code', v_code, 'me', 'p1', 'state', g);
end $$;

-- Take a seat, or resume the one you already hold.
create or replace function public.skull_join(p_code text, p_name text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; g jsonb; s jsonb; me text; seats text[]; pid text;
begin
  perform skull.check_token(p_token);

  select gm.id, gm.state, gs.secret into v_id, g, s
    from public.games gm join public.game_secrets gs on gs.game_id = gm.id
   where gm.code = upper(btrim(p_code))
     for update of gm, gs;
  if v_id is null then raise exception 'No game with that code'; end if;

  me := s->'tokens'->>p_token;
  if me is not null then                                   -- already seated: this is a reconnect
    return jsonb_build_object('id', v_id, 'code', upper(btrim(p_code)), 'me', me, 'state', g);
  end if;

  if g->>'phase' <> 'lobby' then raise exception 'That game has already started'; end if;
  seats := skull.arr(g->'seats');
  if array_length(seats, 1) >= 6 then raise exception 'That game is full'; end if;

  p_name := skull.clean_name(p_name);
  pid := 'p' || (array_length(seats, 1) + 1);
  g := jsonb_set(g, '{seats}', (g->'seats') || to_jsonb(pid));
  g := jsonb_set(g, array['players', pid], skull.seat(p_name));
  s := jsonb_set(s, array['tokens', p_token], to_jsonb(pid));

  update public.games set state = g, updated_at = now() where id = v_id;
  update public.game_secrets set secret = s where game_id = v_id;
  return jsonb_build_object('id', v_id, 'code', upper(btrim(p_code)), 'me', pid, 'state', g);
end $$;

-- Every move goes through here.
create or replace function public.skull_act(p_game uuid, p_token text, p_act jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g jsonb; s jsonb; me text; r jsonb;
begin
  perform skull.check_token(p_token);

  select gm.state, gs.secret into g, s
    from public.games gm join public.game_secrets gs on gs.game_id = gm.id
   where gm.id = p_game
     for update of gm, gs;                                  -- serialises concurrent moves
  if g is null then raise exception 'No such game'; end if;

  me := s->'tokens'->>p_token;
  r  := skull.apply(g, s, me, p_act);

  update public.games        set state = r->'g', updated_at = now() where id = p_game;
  update public.game_secrets set secret = r->'s' where game_id = p_game;
  return r->'g';
end $$;

-- Public state plus the part only you may see: your hand, your own placed discs,
-- the discs you have lost, and which one is leaving the game this round.
create or replace function public.skull_view(p_game uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g jsonb; s jsonb; me text; v_code text;
begin
  perform skull.check_token(p_token);

  select gm.state, gm.code, gs.secret into g, v_code, s
    from public.games gm join public.game_secrets gs on gs.game_id = gm.id
   where gm.id = p_game;
  if g is null then raise exception 'No such game'; end if;

  me := s->'tokens'->>p_token;
  return jsonb_build_object(
    'state', g,
    'me',    me,
    -- Game ids are enumerable by anyone with the anon key, so the code goes only to
    -- someone already holding a seat. Otherwise it is not a gate at all.
    'code',  case when me is null then null else to_jsonb(v_code) end,
    'hand',  coalesce(s->'hand'->me,  '[]'::jsonb),
    'stack', coalesce(s->'place'->me, '[]'::jsonb),
    'lost',  coalesce(s->'lost'->me,  '[]'::jsonb),
    'losing', case when s->'pendingLoss'->>'pid' = me
                   then to_jsonb(s->'pendingLoss'->>'disc') else null end);
end $$;

-- Only these four are callable. Revoking from PUBLIC is not enough: Supabase grants
-- EXECUTE on public functions to anon/authenticated directly, so name them too.
revoke all on function public.skull_create(text,text)       from public, anon, authenticated;
revoke all on function public.skull_join(text,text,text)    from public, anon, authenticated;
revoke all on function public.skull_act(uuid,text,jsonb)    from public, anon, authenticated;
revoke all on function public.skull_view(uuid,text)         from public, anon, authenticated;
grant execute on function public.skull_create(text,text)    to anon, authenticated;
grant execute on function public.skull_join(text,text,text) to anon, authenticated;
grant execute on function public.skull_act(uuid,text,jsonb) to anon, authenticated;
grant execute on function public.skull_view(uuid,text)      to anon, authenticated;

-- The engine schema itself is not reachable, so nothing inside it is callable.
revoke all on schema skull from public, anon, authenticated;
