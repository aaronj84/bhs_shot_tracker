# CURSOR_SPEC.md -- build brief for the MaxPreps module

PAUSED 2026-09-13. Ryan does not need an app. Current deliverable is
the scheduling-priorities briefing (`../Brighton_scheduling_priorities.html`).
Next number he asked for (swap a #75 win for a #5 loss) waits on the
season game graph. Do not invent a seed delta. Resume this spec only
if a module is requested again.

You are adding a module to Aaron's existing webapp (GitHub Pages
frontend, Supabase backend with edge functions in Deno/TypeScript). You
are NOT starting a new app.

The reference math lives in this repo as Python:
`mp_bethel.py`, `mp_rating.py`, `mp_whatif.py`, `mp_collect.py`,
`mp_snapshot.py`. Read them for behaviour. The Bethel implementation is
verified against the published paper values to eleven decimal places.
Do not "improve" it.

## Who this is for

Ryan, the Brighton FS varsity girls soccer head coach. Not a
programmer. He wants to answer three questions in under 30 seconds:

1. If we schedule Team X, how does that move our seed under a
   plausible set of results?
2. Which games on the remaining schedule actually swing our seed?
3. Does running the score up in Thursday's game do anything?

He clicks. He does not type SQL or paste JSON.

## Architecture

Two-phase build. Phase 1 ships value without porting any math.

### Phase 1: offline compute, live serve

```
Aaron's laptop                 Supabase                    GitHub Pages
--------------                 --------                    ------------
python3 mp_collect.py    --->  games table
python3 mp_snapshot.py   --->  snapshots table
python3 precompute.py    --->  ratings, scheduling_grid,
                               remaining_swing,
                               mercy_curve tables

                               edge functions              frontend module
                               (thin read wrappers)  <---  fetches JSON
                                                          renders tables
```

Ryan interacts only with precomputed data. Aaron re-runs the Python
weekly (or nightly during the run-up to seeding). The math never runs
inside Supabase.

Trade-off: Ryan can only explore scenarios Aaron has precomputed. In
practice that covers 95% of what he asks -- the scheduling grid IS the
answer to question 1, the remaining-swing table IS the answer to
question 2, the mercy curve IS the answer to question 3. Novel
free-form scenarios wait for phase 2.

### Phase 2 (only if needed): live what-if in an edge function

Port `mp_bethel.bethel_strengths()` and `mp_whatif.what_if()` to a Deno
edge function. Pin the TS output to 20+ Python-generated fixtures to
six decimal places. Do not ship without those tests passing.

Do NOT do phase 2 until phase 1 is in Ryan's hands and he has actually
asked for a scenario the precomputed tables cannot answer.

## Supabase schema

Create these tables in a new migration. Use `mp_` prefixes so they
don't collide with existing app tables.

```sql
create table mp_teams (
    team_id        text primary key,        -- normalized team name
    display_name   text not null,
    state          text not null,
    classification text,                    -- '6A' | '5A' | ... | null
    maxpreps_slug  text,                    -- for scraping / linking back
    is_our_team    boolean default false,   -- flag Brighton FS
    updated_at     timestamptz default now()
);

create table mp_games (
    game_id       text primary key,         -- stable hash of date+teams
    played_on     date not null,
    home_team_id  text references mp_teams on delete cascade,
    away_team_id  text references mp_teams on delete cascade,
    home_score    int,
    away_score    int,
    neutral       boolean default false,
    is_forfeit    boolean default false,
    source_url    text,
    ingested_at   timestamptz default now()
);
create index on mp_games (played_on);
create index on mp_games (home_team_id);
create index on mp_games (away_team_id);

create table mp_snapshots (
    snapshot_id    uuid primary key default gen_random_uuid(),
    taken_on       date not null,
    state          text not null,
    sport          text not null,
    classification text,
    rank           int,
    team_id        text references mp_teams,
    rating         numeric,
    record         text,
    unique (taken_on, state, sport, classification, team_id)
);

create table mp_ratings (              -- current model output
    computed_at   timestamptz not null,
    model         text not null,       -- 'bethel' | 'margin'
    team_id       text references mp_teams,
    rating        numeric not null,
    projected_wp  numeric,             -- Bethel eq (21)
    sos           numeric,
    rank_in_class int,
    primary key (computed_at, model, team_id)
);

create table mp_scheduling_grid (      -- precomputed answers to Q1
    computed_at   timestamptz not null,
    for_team_id   text references mp_teams,
    opponent_id   text references mp_teams,
    result_label  text not null,        -- 'win by 5+' | ...
    goals_for     int, goals_against int,
    model         text not null,
    rating_delta  numeric,
    rank_delta    int,
    primary key (computed_at, for_team_id, opponent_id, result_label, model)
);

create table mp_remaining_swing (      -- precomputed answers to Q2
    computed_at   timestamptz not null,
    for_team_id   text references mp_teams,
    opponent_id   text references mp_teams,
    model         text not null,
    best_case_rank_delta  int,
    worst_case_rank_delta int,
    swing         int,
    primary key (computed_at, for_team_id, opponent_id, model)
);

create table mp_mercy_curve (          -- precomputed answers to Q3
    computed_at   timestamptz not null,
    for_team_id   text references mp_teams,
    opponent_id   text references mp_teams,
    model         text not null,
    margin        int,
    rating_delta  numeric,
    primary key (computed_at, for_team_id, opponent_id, model, margin)
);

create table mp_calibration (          -- Aaron-only, phase 1.5
    computed_at   timestamptz primary key,
    model         text not null,
    parameters    jsonb not null,
    spearman      numeric,
    top16_overlap int,
    n_teams       int,
    is_current    boolean default false
);
```

RLS: enable on all `mp_` tables. Read-open to authenticated users.
Writes restricted to a service role that Aaron's Python job uses. Ryan
never writes.

## Python side: what to add

One new file: `precompute.py`. It:

1. Loads games + snapshots from Supabase using the service key.
2. Computes ratings under both models via the existing Python code.
3. For each configured "our team", computes the scheduling grid, the
   remaining-swing table, and the mercy curve for each still-unplayed
   opponent.
4. Writes all of that back to Supabase in a single transaction, keyed
   by a fresh `computed_at` timestamp. Old rows stay (audit trail).
5. Marks the newest `mp_calibration` row `is_current = true` and clears
   the flag on older rows.

`mp_collect.py` and `mp_snapshot.py` already write CSVs; add a
`--supabase` flag that pushes to the tables instead. Do this by
importing the existing functions and adding a thin uploader, not by
rewriting them.

Run it via `cron` or a GitHub Action. Nightly is fine; twice-weekly
matches MaxPreps' own update cadence.

## Edge functions

Four thin read wrappers. All in TypeScript. None of them compute a
rating; they only SELECT and shape.

```
GET  /mp/status
     -> { last_computed_at, games_count, teams_count,
          snapshot_taken_on, days_since_snapshot,
          current_calibration }

GET  /mp/team/:team_id
     -> { display_name, classification, rating, projected_wp,
          rank_in_class, record, next_game }

GET  /mp/scheduling-grid/:team_id
     ?model=bethel|margin|both
     -> rows of { opponent, opp_rating, opp_class,
                  result_label, rating_delta, rank_delta,
                  models: { bethel: {...}, margin: {...} } }

GET  /mp/remaining-swing/:team_id
     -> sorted-by-swing rows

GET  /mp/mercy-curve/:team_id?opponent_id=...
     -> ordered by margin
```

They all read from the newest `computed_at`. If `mp_ratings` is empty
or older than 14 days, return HTTP 200 with a `stale: true` flag and
an empty payload. The frontend handles the empty state (see below).

## Frontend module

You have latitude on structure but obey these:

- Ryan's landing view is a **single page** with the three tables one
  above the other, no navigation clicks required to see them. He
  should see all three answers on load.
- Above them, a status banner: "Ratings computed 3 hours ago. Snapshot
  from Sept 14 (5 days ago)." Yellow if snapshot is 7-13 days old, red
  if 14+.
- Both models rendered side by side by default. `bethel` and `margin`
  in adjacent columns. Never collapse to one.
- Where the two models disagree on the sign of `rank_delta`, mark that
  row with a small "!" and a tooltip: "Models disagree. This scenario
  is in the uncalibrated region -- treat as unclear."
- Green for positive `rank_delta`, red for negative, grey for zero.
  Colour-blind safe pairing (blue/orange is fine; red/green alone is
  not).
- Below each table, a plain-English one-liner takeaway derived by
  simple rules in TS, NOT by an LLM. Example rule: "the row with the
  biggest swing is the game that matters most." Deterministic.
- Team names everywhere link to the MaxPreps team page via
  `maxpreps_slug`.
- No CSV export in phase 1. Ryan is not moving this data anywhere.

Suggested structure inside the app's existing module layout:

```
src/modules/maxpreps/
    index.html      -- or the framework equivalent
    api.ts          -- the four edge function wrappers, typed
    types.ts        -- Row / Model / etc.
    grid.ts         -- renders scheduling grid
    swing.ts        -- renders remaining swing
    mercy.ts        -- renders mercy curve
    status.ts       -- the top banner
    styles.css
```

## Where the LLM stays out

Explicitly:

- Not in the rating math. Ever.
- Not in the parameter fitting. Grid search over the space in
  `mp_rating.calibrate()`, no LLM in the loop.
- Not in the takeaway one-liners. Those are deterministic string
  templates over the same numbers Ryan sees. If you find yourself
  wanting the LLM to "explain the table", write the rules by hand
  instead.
- Not in team name resolution. Fuzzy-match with `difflib` on the
  Python side, not with a model.

The app's existing LLM integrations are for other modules. Do not
import them here.

## Team name normalization

Happens once, in Python, before writes:

1. Strip city parentheticals: "Brighton (Cottonwood Heights, UT)" -> "Brighton"
2. Strip leading rank markers: "#3 Brighton" -> "Brighton"
3. Collapse whitespace, strip edge punctuation
4. Lowercase for the `team_id`; keep the original for `display_name`

`team_id` is the join key everywhere. Bad normalization means missing
teams, which means silently wrong ratings. Log the raw->normalized
mapping to a file Aaron can eyeball.

If MaxPreps changes a display name mid-season, the `team_id` stays
stable (they do not change the URL slug). Prefer `maxpreps_slug` as the
canonical id if you have it.

## Testing

Reference outputs come from Python. For anything that touches math on
the TS side (nothing in phase 1, some in phase 2), pin its output to
Python's:

```
python3 mp_bethel.py > tests/fixtures/bethel_reference.json
python3 mp_whatif.py --mode demo > tests/fixtures/whatif_reference.json
```

Then TS tests read those fixtures and assert equality to six decimal
places. If you break parity, the tests break, and the change is not
allowed to ship.

For the edge functions themselves, standard supabase-js integration
tests: seed the DB, hit the function, assert the response shape.

## What NOT to do

- Do not compute ratings in the browser.
- Do not compute ratings in an edge function in phase 1.
- Do not rewrite the Python. Import it.
- Do not build a scraper UI. `mp_collect.py` is CLI on Aaron's laptop.
- Do not project the final seed by iterating what_if 15 times. The
  primitive holds the world fixed; iterating compounds error. If it
  ever ships, it ships behind a warning labelled "back of envelope".
- Do not silently pick a model when they disagree.
- Do not let the LLM near the math.
- Do not add auth flows -- the app already has them.

## Definition of done for phase 1

- Migrations apply cleanly on a fresh Supabase project.
- `precompute.py` writes a full snapshot end-to-end from real data.
- All four edge functions return real payloads.
- Ryan can open the app on his phone and see all three tables
  populated within 3 seconds of load.
- The status banner correctly turns yellow when the last snapshot is
  8 days old (test with a manual DB update).
- The Python verification suite (`python3 mp_bethel.py`) still prints
  "all three match" after any TS work.
