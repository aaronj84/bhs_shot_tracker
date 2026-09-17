# MaxPreps rating: what's actually in our control

For Ryan. Written 2026-09-13.

Starting point: UHSAA changed the system this year. As of the 2026-27
rankings FAQ, soccer seeds off **MaxPreps Rankings**, not RPI. RPI is
football only now. So the thing that sets our bracket position is a
formula MaxPreps does not publish. Everything below is either (A) stated
publicly by MaxPreps or UHSAA, (B) a structural consequence of how this
family of rating systems works, or (C) not yet known and needing
calibration. Each item is tagged.

---

## The one-paragraph version

Beating weak teams is close to worthless and beating them badly is
worthless past five goals. Playing strong teams is what raises the
ceiling, and a competitive loss to a genuinely stronger team costs very
little. Losing to a weak team is the single most expensive thing that can
happen to us. Classification is irrelevant; only the opponent's own rating
matters, and some 4A teams are rated above most of 5A.

---

## In-season: between now and the bracket

**1. Win. The result dominates the margin.** [A]
UHSAA: "Score differential is a factor but has a much smaller impact on
the rating system than the actual result."

**2. Five goals is the ceiling. Running it up does nothing.** [A]
The AIA publishes the sport-by-sport caps for the MaxPreps formula:
soccer is capped at 5 goals. UHSAA says it outright: "Schools should never
attempt to run up scores as it will not improve their rating." A 9-0 win
and a 5-0 win are the same number. Everything past the fifth goal is pure
downside: injury exposure, goodwill with other programs we have to
schedule again, and how our kids get talked about.

The `mercy` mode in `mp_whatif.py` draws this curve. It goes flat at 5
under both candidate models.

**3. Score entry is a real lever and it is free.** [A]
The rating is only as good as what is in MaxPreps. Three specific things:

- Enter every result promptly and correctly.
- Games against non-varsity opponents must be entered by selecting
  "Non-Varsity Opponent." If we enter them as a normal team, the result
  lands on that school's varsity schedule and pollutes the graph.
- **Out-of-state opponents are our responsibility.** UHSAA explicitly puts
  the burden on coaches and ADs to monitor out-of-state opponents'
  schedules weekly and chase them if scores are not being entered. An
  out-of-state opponent with missing games is an opponent whose rating is
  wrong, which makes our strength of schedule wrong.

**4. Never take a forfeit if we can help it.** [A]
Forfeits are thrown out of the rating entirely. We get no credit and we
lose the strength-of-schedule value the game would have carried.

**5. Expect the rating to move in weeks we don't play.** [A]
Every update is a complete re-rank from scratch on the whole season. When
teams we beat in August win or lose in October, our number moves. This is
not an error and there is nothing to do about it.

**6. Losing to a weak team is disproportionately expensive.** [B]
In the demo run, a one-goal loss to a bottom-tier team cost about nine
times what a one-goal loss to a top-tier team cost. This is structural:
the model is trying to find the strength that makes our predicted wins
match our actual wins, and an unexpected loss is much harder to explain
away than an expected one.

---

## Preseason scheduling: the actual question

Ryan's three options, in order.

### "Should we schedule even weaker teams?"

No. This is the clearest answer in the whole document. [B]

Two mechanisms, both pointing the same way. First, strength of schedule is
computed from opponents' ratings, so weak opponents drag our number down
directly. Second and less obvious: going undefeated against weak teams is
*satisfied* by a modest strength, because the model already predicts we
beat them. Going undefeated against strong teams requires a large strength
to explain. A perfect record against a soft schedule is a cheap record and
the math treats it that way.

In the margin-based model, beating the weakest teams is often **actively
negative** even when we win by five, because the model expected more. That
is the same dynamic that makes CalPreps drop teams after narrow wins over
bad opponents.

### "Should we schedule potential losses to 6A teams?"

Probably yes, in moderation. This is the strongest case for scheduling up. [A + B]

MaxPreps' own FAQ says this directly: "If a team has a much lower rating
than an opponent, but loses in a close game, the losing team's rating may
increase while the winning team's may decrease."

In the demo grid, against a clearly stronger opponent:
- a 5-0 win was worth more than any other single result available
- a **draw was still positive**
- a one-goal loss was roughly one-ninth as costly as a one-goal loss to a
  weak team

So the risk profile of scheduling up is asymmetric in our favour. The
upside of beating a good 6A side is large; the downside of losing to them
narrowly is small. What it does *not* survive is getting beaten badly and
repeatedly -- a three-goal loss still costs real ground, and a schedule
stacked with games we lose 4-0 is not a rating strategy, it is just a bad
season.

Practical shape: two or three genuinely tough non-region games, spread
early enough that we can absorb a result, not five.

### "We're 5A and scheduled 4A teams. Is that bad?"

Wrong frame. [A]

Classification is never used in the rating. MaxPreps and UHSAA both say
this. What matters is the opponent's actual rating, and the classification
label is a poor proxy for it. As of mid-September, the #1 and #3 teams in
Utah girls soccer are 4A programs. A game against the top of 4A is a
better rating asset than a game against the bottom of 6A.

So the question is never "what class are they." It is "where do they sit
in the state rating." Schedule by rating.

---

## The honest caveats

**Magnitudes are not calibrated yet.** [C]
The directions above are well supported. The *sizes* -- how many seed spots
a given game is actually worth -- come out of the models, and the models
are not yet fitted to real published MaxPreps output. That requires weekly
snapshots (see the README). Until then, treat the numbers as ordinal, not
literal.

**Two models, one unknown.** [C]
The tool runs a result-dominant model and a margin-based model side by
side. Where they agree, act. Where they disagree -- and they do disagree,
notably on whether a 5-0 win over a bad team is slightly positive or
slightly negative -- that disagreement *is* the unknown part of the real
formula. Don't make a scheduling decision that only works under one of
them.

**Seed is not the objective.** [B]
This is worth saying once. Optimising the schedule for rating means
playing fewer games we are likely to win comfortably, which is also the
soft schedule that leaves a team untested in November. A 1 seed that has
never been behind is not obviously better positioned than a 3 seed that
has played three real games. The rating is a means. If the two ever
conflict, the bracket is decided on the field, not in the formula.

**We cannot control the biggest input.** [A]
Roughly half of what moves our number is what our past opponents do from
here. That is a reason to schedule teams we think will be *good later*,
not just teams that are good now -- a September opponent who turns into a
November powerhouse gets that win re-credited to us at full value.
