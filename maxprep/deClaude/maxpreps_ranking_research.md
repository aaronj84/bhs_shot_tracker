# Reverse-engineering the MaxPreps rating: what exists, what does not

Scope: high school girls soccer, with Utah / UHSAA as the working case.
Compiled 2026-09-13.

---

## 1. Short answer

Nobody has published a reverse-engineering of the MaxPreps computer rating.
Not a paper, not a repo, not a blog post. What exists:

- **Scrapers**, several. `maxpreps-scraper` on PyPI (Raghav Dhir, 2025) pulls
  rankings and contest data by state/sport/year. `daranzolin/maxprepsr` is an
  R scraper for team and player stats. Both get the *output* of the rating.
  Neither attempts the formula.
- **A named, fully published algorithm** for the *state-seeding* variant:
  Bethel (2005). Recovered and implemented exactly in `mp_bethel.py`.
  It is not the formula behind the maxpreps.com rating (section 3).
- **Alternative systems built because MaxPreps would not disclose its own.**
  The MIAA (Massachusetts) commissioned a replacement power rating from Jim
  Clark in 2020 after complaints about MaxPreps' opacity. That is a
  substitute, not a reconstruction.

So the honest framing: this is an open problem, and it is tractable, because
the inputs are public and the output is public. That is a fittable system.

---

## 2. The distinction that matters most

There are **two different MaxPreps-built rating systems**, and they are not
the same formula. Conflating them is the single biggest trap here.

| | MaxPreps.com computer rankings | State-seeding rating (e.g. AIA) |
|---|---|---|
| Nature | **Predictive** | **Retrodictive** |
| Basis | Freeman rating system (Ned Freeman, also behind CalPreps) | Bethel 2005 algorithm, MaxPreps-modified |
| Preseason input | Yes, editorial starting position, decays to zero | No |
| Margin of victory | Yes, capped | No for most sports; capped where used |
| Where you see it | maxpreps.com rankings pages | state association rankings pages |

Arizona's AIA states this outright: the MaxPreps.com ratings are predictive,
whereas the AIA's rankings run a retrodictive formula, and the AIA chose the
retrodictive one as more appropriate for postseason seeding.

**For Utah in 2026-27 the relevant system is the MaxPreps.com one.** Per the
UHSAA "Intro to Post Season Rankings" FAQ updated June 2026: football uses
RPI for all classifications; baseball, basketball, lacrosse, **soccer**,
softball and volleyball use **MaxPreps Rankings**. This is a change. In
2023-24 soccer used RPI for 5A/6A and MaxPreps for 1A-4A; in 2025 the UHSAA
still ran RPI for 6A/5A girls soccer. As of this season, RPI is gone from
soccer entirely.

Practical consequence: Brighton's seed is now set by a formula nobody outside
MaxPreps can compute exactly, where last year it was set by one you could
compute in a spreadsheet. That is the reason this exercise is worth doing.

---

## 3. The published spec, in hand

The Bethel paper is recovered (see Section 8 for where). It is 19 pages,
dated August 2005, author at MITRE. Everything below is from the paper
itself, and `mp_bethel.py` implements it exactly.

### The model

Each team t has a positive scalar **strength** s_t. For a game between t
and t', the win probability is, eq (8):

    p(t beats t') = s_t / (s_t + s_t')

The defining condition, eq (4) and again as eq (18), is that **actual wins
must equal predicted wins for every team**:

    W_t = sum over t's games of  s_t / (s_t + s_opp)

Bethel derives this twice: once heuristically from the requirement that
the method reduce exactly to winning percentage on a balanced schedule
(Section 4), and once as a maximum-likelihood estimate (Section 5), then
proves the two give the identical condition. So the engine is the
Bradley-Terry / Ford (1957) MLE, reached from a fairness argument rather
than a statistical one. That derivation of equivalence is the paper's
stated primary contribution.

### The solver, eq (20)

    s_t  <-  W_t / sum over t's games of  1 / (s_t + s_opp)

All strengths initialize to 1. After each sweep, rescale so that
sum_t log(s_t) = 0. Bethel runs 200 iterations. Ford (1957) supplies the
existence, uniqueness and convergence proofs; Bethel leans on them.

### What the paper explicitly rules out

This is the part that matters most, and it corrects what I told you
earlier from the secondhand FAQ descriptions:

- **Margin of victory has no influence.** Stated flatly in Section 3.
- **Ties are discarded entirely.** No won-lost information in them.
- **No home advantage.** Argued to cancel over a fair schedule. A
  bivariate home/away strength attribute is sketched as future work,
  eq (24), and not implemented.
- **No recency weighting.** "Strengths are computed as an aggregate over
  the entire season. That is, all games count equally."
- No enrollment, no injuries, no subjective input of any kind.

**So the Bethel paper cannot be the maxpreps.com rating.** That rating
uses margin with a cap, which Bethel deliberately excludes. It is the
ancestor of the retrodictive state-seeding variant only, exactly as the
AIA describes it. Treat it as a model family, not a spec for what Utah
now uses.

### The pathologies Bethel names himself, Section 8

- A **winless team gets strength 0**, an **undefeated team gets infinite
  strength**, and two of either cannot be ranked against each other. This
  is not a numerical artifact; it falls directly out of requiring
  predicted wins to equal actual wins. Verified in
  `mp_bethel.py`: strict Bethel on an undefeated team does not converge,
  it climbs from 89.6 at 200 iterations to 503.1 at 2000.
- **Connectivity** is called the major issue for this and any earned
  method. Two teams with no chain of shared opponents between them have
  meaningless relative strengths. Directly relevant to a Utah-only scrape.

### The bridge to margin: degree of win, Section 8

Bethel's own proposed generalization replaces the 0/1 outcome with a
**degree of win** w per team per game, subject only to

    0 <= w <= 1     and     w_t + w_t' = 1

A tie becomes w = 0.5 for both sides. W_t becomes the sum of degrees of
win. Nothing else in the derivation changes.

Two consequences worth having:

1. The "additional loop for ties" MaxPreps told the AIA it added **is
   exactly this**, at its minimum setting. MaxPreps implemented Bethel's
   own future-work suggestion.
2. A capped goal margin mapped into (0,1) is the natural way to fold the
   5-goal soccer cap into the same fixed point. The published algorithm
   and the margin-aware behaviour MaxPreps describes are therefore not
   two different models. They are one model under different degree-of-win
   functions, which collapses much of the parameter search into a single
   family. `mp_bethel.py` ships three: strict, tie-as-half, and a
   result-dominant capped-margin version with a tunable margin share,
   which is what UHSAA's "score differential matters much less than the
   result" describes.

Restricting w strictly inside (0,1) also removes the winless/undefeated
blow-up without needing the Colley-style virtual win-and-loss prior
(ref [7] in the paper), which Bethel notes breaks the
winning-percentage equivalence the whole method is built on.

### Derived outputs

Section 6 gives **projected winning percentage** over a hypothetical
balanced schedule, eq (21):

    WPhat_t = (1/(T-1)) * sum over t' != t of  s_t / (s_t + s_t')

Proven monotonic with strength, so it ranks identically, but it lives on
the familiar 0-to-1 scale instead of an arbitrary strength scale. Better
for anything you show a parent or an AD.

**Strength of schedule** is then projected WP minus actual WP. Positive
means the schedule was harder than average. The paper's 1999 NFL example:
St. Louis went 13-3 (.8125) but projects to .6418, marked down for a weak
NFC West; Buffalo went 11-5 (.6875) but projects to .7566, marked up for a
strong AFC East. Note this is a **different definition** from CalPreps'
schedule strength, which is just the mean of opponent ratings. Don't mix
the two.

### Verification

The paper's Table 1 reports three figures for the 1999 NFL at iteration 0:
max games difference 6.00000000, RMS games difference 2.94026551, and log
likelihood -171.90050077887. All three are recoverable from Table 2's
won-lost records alone, without the 1999 schedule, because at iteration 0
every strength is 1 and so every win probability is 0.5.
`mp_bethel.py` reproduces all three to the last published digit, which
pins down the W_t accounting, the RMS convention (over the 31 teams, not
the 248 games), and the LLF form. The test suite also confirms balanced
schedule equals winning percentage, the sum-of-logs scaling constraint,
monotonic LLF increase, and games differences driven to zero.

## 4. What MaxPreps and the states have confirmed in public

Assembled from the MaxPreps football rankings FAQ (rewritten 2026), MaxPreps
Support, the AIA rankings FAQ, the UHSAA 2026-27 FAQ, and the NMAA/NCHSAA
MaxPreps overviews. These are the constraints any reconstruction must satisfy.

**Confirmed in:**
- Game results: who played whom, who won, final score.
- Margin of victory, **capped**. AIA names the caps by sport:
  **soccer 5 goals**, basketball 20, flag football 14. UHSAA confirms soccer
  has a cap and that score differential matters "much less than the actual
  result."
- Strength of schedule, computed from opponents' *ratings*, not their records.
- Out-of-state games, treated identically to in-state ones. No delineation.
- Playoff results, including bracket placement and how far a team advanced.
- A preseason editorial starting position, whose weight decays to zero.

**Confirmed out:**
- Enrollment, classification, region, division, state association.
- Polls, votes, committees, reputation, program history, geography.
- Forfeits. Excluded from ratings on both sides. Note the AIA game-count
  quirk: a forfeit does not reduce the game count for the team forfeited
  against, but does for the team issuing it.
- Scrimmages, junior-varsity opponents, out-of-country opponents.
- Head-to-head as an override. MaxPreps explicitly says a team can rank below
  a team it beat.

**Confirmed mechanics:**
- Every update is a **full re-rank from scratch** on all games to date, not
  an incremental adjustment. A team's rating can move in a week it did not
  play, purely because past opponents played.
- Ratings recalculate twice weekly in season (Sundays and Thursdays for
  soccer per MaxPreps Support; UHSAA publishes daily).
- Minimum 3 games to appear, rising through the season.
- The system "accounts for the timing and context of each result (regular
  season vs. playoff, early-season vs. late-season)." That is a recency
  and/or game-importance weight, and it is a real free parameter.

**Unknown and therefore the parameters to fit:**
- The functional form (logistic on results vs least squares on margin).
- The exact margin cap shape: hard clip at 5, or diminishing returns curve.
- The relative weight of result vs margin.
- The prior/regularization strength that keeps undefeated teams finite.
- The recency weight and the playoff bonus.
- Home-field advantage, if any. Never mentioned in any FAQ.
- Preseason seed magnitude and its decay rate.

---

## 5. Data required to compute it

Minimum viable table, one row per game:

```
date, home_team, away_team, home_score, away_score, neutral, is_forfeit
```

Everything else is derived. You do **not** need opponent or
opponent-of-opponent columns: those are a property of the graph, and any
whole-graph method recovers them by construction. Building explicit
opponent-of-opponent columns is the RPI way of thinking and is exactly what
MaxPreps says its method does not do.

Scope of the graph, in increasing order of fidelity:

1. **Utah only.** ~95 girls soccer teams, ~700-900 games. Enough to rank
   Utah teams *relative to each other* provided the in-state graph is
   connected, which it is via region crossover. Fast to collect.
2. **Utah plus bordering states** (ID, NV, AZ, CO, NM, WY). Captures the
   out-of-state games that actually connect Utah to the national pool. This
   is the honest minimum if any Utah team plays out of state.
3. **National.** What MaxPreps actually does. Tens of thousands of games.
   Realistically out of reach for a scrape, and mostly unnecessary: the
   marginal effect of an Indiana result on a Utah seed runs through a very
   long chain.

Additional columns worth capturing even though the core models do not use
them yet, because they let you test the "timing and context" claim:
`game_type` (regular / region tournament / state playoff), `round`, and
`classification` (for reporting, never as a model input).

**Calibration target.** This is the piece most people forget. To fit
anything you need snapshots of the published MaxPreps ratings, or at minimum
the published rank order, on the same dates. Pull and archive it weekly from
now to the bracket reveal. You cannot reconstruct old snapshots later - the
site shows only current values, and the whole list re-ranks every run.

---

## 6. Scraping notes, verified 2026-09-13

- **Scoreboard pages are server-rendered and scrapeable:**
  `https://www.maxpreps.com/ut/soccer/girls/scores/?date=M/D/YYYY`
  One page per date. Each match row reads, in order:
  away score, optional `(#rank)`, away name, home score, optional `(#rank)`,
  home name, then `Final`. Verified against the page's own prose: the row
  "0 Hurricane 2 (#1) Crimson Cliffs Final" corresponds to the described
  fixture "Hurricane @ #1 Crimson Cliffs". **Away is listed first.**
- Unreported games render as `Missing score` with the two names run together
  and no delimiter; fall back to the URL slug pair for those.
  Games entered against `Non Varsity Opponent` appear and must be dropped.
- **Rankings pages are client-rendered.** A plain GET of
  `https://www.maxpreps.com/ut/soccer/girls/rankings/1/` returns "No Data".
  Collecting the published ratings needs either a headless browser or the
  underlying JSON endpoint. This is the one part of the pipeline that needs
  extra work.
- Utah girls soccer 2026-27 spans roughly Aug 3 to late Oct, so a full
  season is about 90 page requests per state.
- Check the MaxPreps terms of use before running this at volume.

---

## 7. What to expect from a reconstruction

Calibrate on rank correlation, not on reproducing rating values. The rating
scale is arbitrary and MaxPreps has changed it before; the ordering is what
determines seeds.

Realistic expectation from a well-specified capped-margin model fit on a
complete state graph: Spearman in the 0.95+ range against the published
order, with the top of the list noisier than the middle because that is
where the preseason decay and playoff weighting bite. Report top-16 seed
overlap alongside Spearman - a model can score well on Spearman while
scrambling the seeds you actually care about.

You will not get an exact match. The preseason editorial seed alone
guarantees a residual you cannot reconstruct from game data, and MaxPreps
does not publish it.

---

## 8. Sources

- MaxPreps, "How the MaxPreps football rankings work" (FAQ rewritten 2026):
  https://www.maxpreps.com/news/9dcOAHwkaEu7lGDog_eRtg/how-the-maxpreps-football-rankings-work.htm
- MaxPreps Support, "MaxPreps Rankings":
  https://support.maxpreps.com/hc/en-us/articles/202097104-MaxPreps-Rankings
- AZPreps365 / AIA rankings FAQ (names Bethel 2005, lists sport-by-sport
  margin caps, states the predictive vs retrodictive split):
  https://azpreps365.com/rankings/faq
- AZPreps365, "MaxPreps reveals crux of seedings formula" (2012), with the
  original paper URL:
  https://azpreps365.com/articles/2009-maxpreps-reveals-crux-of-seedings-formula-answers-questions
- Bethel, R. E., "A Solution To The Unequal Strength Of Schedule Problem",
  MITRE, August 2005, 19pp. Originally at
  http://homepages.cae.wisc.edu/~dwilson/rsfc/rate/papers/BethelRank.pdf
  (that host now blocks or has dropped it). Live mirror:
  https://fliphtml5.com/sdyu/suvz/basic
  Formal citation as Bethel, R.E. (2005), Mimeo, MITRE Corporation.
  Key internal references: Bradley and Terry (1952) Biometrika 39:324-45;
  Ford (1957) American Mathematical Monthly 64(8):28-33 (existence,
  uniqueness and convergence proofs); Keener (1993) SIAM Review 35(1):80-93;
  Colley, colleyrankings.com (the virtual win-and-loss prior).
- UHSAA, "Intro to Post Season Rankings (PSR)", updated June 2026:
  https://uhsaa.org/RankingsFAQ26-27.pdf
- UHSAA girls soccer rankings hub: https://uhsaa.org/uhsaa-girls-soccer-rpi/
- NMAA rankings overview: https://www.nmact.org/file/NM_Rankings_FAQ.pdf
- NCHSAA MaxPreps ranking FAQ:
  https://www.nchsaa.org/wp-content/uploads/2017/10/NCMaxPrepsRanking_FAQ.pdf
- CalPreps national ratings notes (Freeman system, 0 = average, schedule
  strength = mean opponent rating):
  https://calpreps.com/2023/ratings/index.html
- CalPreps projections page (projection variant removes the margin cutoff):
  https://www.calpreps.com/2024/projections.htm
- Boston Globe, "Amid MaxPreps criticism, MIAA considers new in-house power
  ratings proposal" (2020-12-16)
- maxpreps-scraper (PyPI): https://pypi.org/project/maxpreps-scraper/
- maxprepsr (R): https://github.com/daranzolin/maxprepsr
