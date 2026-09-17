# MaxPreps rating reconstruction kit

Read `COACH_BRIEF.md` first if you just want the answers. Everything else
is the machinery behind it.

| File | What it is |
|---|---|
| `COACH_BRIEF.md` | The findings in coach language. What's in our control, what isn't. |
| `maxpreps_ranking_research.md` | The research. Two MaxPreps formulas, the published algorithm, sources. |
| `mp_bethel.py` | Exact implementation of Bethel 2005, verified against the paper's own figures. |
| `mp_rating.py` | Margin-based rival model (Freeman/CalPreps shape) plus a calibration harness. |
| `mp_whatif.py` | **The decision tool.** Scheduling grid, mercy curve, remaining-schedule swing. |
| `mp_collect.py` | Scraper. MaxPreps date-indexed scoreboards -> games CSV. |
| `mp_snapshot.py` | Captures the published rank order, dated. The calibration target. |
| `sample_ut_girls_2026-09-10.csv` | 44 real Utah results from one day. Format example and smoke test. |

## Is this feasible to run yourself?

Yes. Three inputs, in descending order of effort.

### 1. Games (automated, ~20 minutes of wall clock per state per season)

```bash
pip install requests beautifulsoup4 numpy

# check the parser against the two known days (8/3 and 9/9)
python3 mp_collect.py --self-test

# Utah girls 2026: Aug 3 through today, skip Sundays and empty
# calendar days, plus class + region for every UHSAA team
python3 mp_collect.py --season --out ../data/ut_girls_soccer_2026.csv

# backfill contests the day board dropped (deleted-but-scored)
python3 mp_collect.py --schedules-only --out ../data/ut_girls_soccer_2026.csv

# then load DEV (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY),
# or write SQL and apply it:
python3 mp_to_supabase.py \
    --games ../data/ut_girls_soccer_2026.csv \
    --teams ../data/ut_girls_soccer_2026_teams.csv \
    --snapshots ../data/ut_girls_rankings_2026-09-13.csv \
    --sql-out ../data/ut_girls_soccer_2026.sql
```

About 90 requests per state per season at a 1.5s delay. Bethel names
connectivity as the major failure mode for this whole family of methods,
so if any Utah team plays out of state, add the bordering states:

```bash
python3 mp_collect.py --states ut id nv az co nm wy \
    --start 2026-08-01 --end 2026-10-31 --out games_region.csv
```

Check the MaxPreps terms of use before running at volume.

### 2. Classifications (manual, once, ~10 minutes)

A CSV with columns `team,classification`. Get it from the Class filter on
the MaxPreps Utah scoreboard, or from the UHSAA alignment PDF. Only used
for *ranking within 5A* -- classification never enters the rating itself.

```csv
team,classification
Brighton,5A
Bountiful,5A
Crimson Cliffs,4A
```

### 3. Published rank order (10 minutes a week, and this is the one that matters)

Without dated snapshots you have models with nothing to fit them to, and
**old snapshots cannot be recovered later** -- MaxPreps shows only current
values and re-ranks the whole list every run. Start this week.

The rankings pages are client-rendered, so a plain GET returns nothing.
Three routes, easiest first:

```bash
# paste: select the table in the browser, copy into a text file
python3 mp_snapshot.py paste --in pasted.txt --date 2026-09-14 --out snapshots.csv

# json: F12 -> Network -> XHR -> reload -> copy the URL of the team-list call
python3 mp_snapshot.py json --url '<that url>' --date 2026-09-14 --out snapshots.csv

# headless browser
pip install playwright && playwright install chromium
python3 mp_snapshot.py render --url '<rankings page>' --date 2026-09-14 --out snapshots.csv
```

## Using it

```bash
# see it work with no data at all
python3 mp_whatif.py --mode demo

# verify the Bethel implementation reproduces the paper
python3 mp_bethel.py

# the scheduling grid: what does adding one game do to our seed
python3 mp_whatif.py --games games_ut.csv --team "Brighton" \
    --pool teams.csv --mode grid

# does running up the score do anything (spoiler: not past 5)
python3 mp_whatif.py --games games_ut.csv --team "Brighton" \
    --pool teams.csv --mode mercy --opponent "Some Weak Team"

# which remaining games actually swing the seed
python3 mp_whatif.py --games games_ut.csv --team "Brighton" \
    --pool teams.csv --mode remaining --upcoming "Olympus" "Alta" "Skyline"
```

Once a few snapshots are banked, fit the free parameters:

```python
from mp_rating import load_games, calibrate
from mp_snapshot import load_snapshot
games = load_games("games_ut.csv")
target = load_snapshot("snapshots.csv", classification="5A")
for row in calibrate(games, target)[:10]:
    print(row)
```

Report Spearman **and** top-16 seed overlap. A model can win on Spearman
while scrambling exactly the seeds you care about.

## Which model

`mp_bethel.py` is the published algorithm. Its `degree_of_win` argument is
the single knob spanning strict win/loss (the paper), tie-as-half (what
MaxPreps says it added), and capped margin (what the 5-goal soccer cap
implies). `mp_rating.py`'s `margin_power_rating` is a different functional
form and a genuine rival, since the maxpreps.com rating Utah now seeds off
is Freeman, not Bethel. `mp_whatif.py` runs both and shows you both.

Where the two models agree on a decision, act on it. Where they disagree,
that disagreement is the part of the real formula still unknown.
