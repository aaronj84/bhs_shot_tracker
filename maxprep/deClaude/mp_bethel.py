"""
mp_bethel.py -- exact implementation of Roy Bethel, "A Solution to the
Unequal Strength of Schedule Problem" (MITRE, August 2005), plus the
degree-of-win generalization Bethel proposes in his own Section 8.

This replaces the hand-rolled Bradley-Terry stand-in in mp_rating.py with
the real thing. Equation numbers below refer to the paper.

THE MODEL
    Each team t has a positive scalar strength s_t. For a game between
    t and t', the win probability is                                 (8)

        p_tt' = s_t / (s_t + s_t')

    The defining requirement is that actual wins equal predicted wins
    for every team                                                (4)/(18)

        W_t = What_t = sum over t's games of s_t / (s_t + s_opp)

    Bethel shows (Sections 4-5) that the heuristic derivation from
    winning-percentage compatibility and the maximum-likelihood
    derivation give the identical condition. So this is the
    Bradley-Terry / Ford (1957) MLE, arrived at from a fairness
    argument rather than a statistical one.

THE SOLVER                                                           (20)
        s_t  <-  W_t / sum over t's games of 1/(s_t + s_opp)

    Initialize every s_t = 1. After each sweep, rescale so that
    sum_t log(s_t) = 0. Iterate. Bethel runs 200 iterations.

WHAT THE PAPER EXPLICITLY EXCLUDES
    - Margin of victory. "Margins of victory have no influence." (Sec 3)
    - Ties. Discounted entirely: a tie carries no won-lost information.
    - Home advantage. Argued to cancel over a fair schedule; a bivariate
      home/away strength extension is left as future work, eq (24).
    - Recency. "Strengths are computed as an aggregate over the entire
      season. That is, all games count equally." (Sec 3)
    - Any subjective input.

KNOWN FAILURE MODES, named by Bethel (Sec 8)
    - A winless team gets strength 0; an undefeated team gets infinite
      strength. Two or more of either cannot be ranked against each
      other: the ratio is indeterminate.
    - Fix 1 (his preferred): the degree-of-win generalization with
      0 < w < 1 strictly, which prevents the condition arising.
    - Fix 2 (attributed to Colley, ref [7]): add one virtual win and one
      virtual loss to every team, acting as a Bayesian prior. Bethel
      notes this does NOT preserve the winning-percentage properties
      that motivate the whole method.
    - Connectivity. Strengths of two teams with no path of shared
      opponents between them are meaningless relative to each other.

THE DEGREE-OF-WIN GENERALIZATION (Sec 8, "Future work")
    Bethel proposes replacing the 0/1 outcome with a degree of win
    w_t,g per team per game, subject to

        0 <= w_t,g <= 1        and        w_t,g + w_t',g = 1

    A tie is w = 0.5 for both sides. W_t becomes the sum of degrees of
    win. Everything else is unchanged.

    This matters for reconstructing MaxPreps. The AIA says MaxPreps
    added "an additional loop where a tie tells us those two teams are
    very similar in strength" -- that is precisely w = 0.5. And a capped
    goal margin mapped into (0,1) is the natural way to fold in the
    5-goal soccer cap while staying inside Bethel's framework. So the
    published algorithm and the margin-aware behaviour MaxPreps
    describes are not two different models; they are one model with
    different degree-of-win functions. See degree_of_win() below.

ASCII only. Python 3.9+. Requires numpy.
"""

from __future__ import annotations

import math
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from mp_rating import Game, drop_forfeits, team_index


# ----------------------------------------------------------------------
# Degree-of-win functions
# ----------------------------------------------------------------------

def dow_bethel_strict(margin: int) -> Optional[float]:
    """
    The paper as written. Win = 1, loss = 0, tie discarded entirely
    (return None). Margin ignored.
    """
    if margin > 0:
        return 1.0
    if margin < 0:
        return 0.0
    return None


def dow_tie_half(margin: int) -> float:
    """
    Bethel's Section 8 minimum extension, and what MaxPreps says it
    added: a tie is half a win for each side.
    """
    if margin > 0:
        return 1.0
    if margin < 0:
        return 0.0
    return 0.5


def make_dow_capped_margin(cap: float = 5.0, floor: float = 0.05) -> Callable[[int], float]:
    """
    Degree of win from a capped goal margin, staying inside Bethel's
    constraints (0 < w < 1, w_t + w_t' = 1).

        w = 0.5 + 0.5 * clip(margin, -cap, cap) / cap

    then squeezed away from the 0/1 endpoints by `floor` so that no team
    can reach strength 0 or infinity. With floor > 0 the winless and
    undefeated pathologies in Section 8 cannot occur at all, which is
    Bethel's own preferred remedy.

    cap = 5.0 is the soccer margin cap the AIA publishes for MaxPreps.
    floor is a free parameter; calibrate it.
    """
    def f(margin: int) -> float:
        w = 0.5 + 0.5 * float(np.clip(margin, -cap, cap)) / cap
        return float(np.clip(w, floor, 1.0 - floor))
    return f


def make_dow_result_dominant(cap: float = 5.0, margin_share: float = 0.25,
                             floor: float = 0.05) -> Callable[[int], float]:
    """
    UHSAA's description: "score differential is a factor but has a much
    smaller impact on the rating system than the actual result."

    A win is worth a base of (1 - margin_share) toward 1.0 regardless of
    score, with the remaining margin_share allocated by capped margin.
    margin_share = 0 reduces to dow_tie_half; margin_share = 1 reduces to
    make_dow_capped_margin.
    """
    def f(margin: int) -> float:
        if margin == 0:
            return 0.5
        base = 0.5 + 0.5 * (1.0 - margin_share) * (1.0 if margin > 0 else -1.0)
        extra = 0.5 * margin_share * float(np.clip(margin, -cap, cap)) / cap
        return float(np.clip(base + extra, floor, 1.0 - floor))
    return f


# ----------------------------------------------------------------------
# The solver
# ----------------------------------------------------------------------

def bethel_strengths(
    games: Sequence[Game],
    degree_of_win: Callable[[int], Optional[float]] = dow_tie_half,
    iterations: int = 200,
    virtual_games: float = 0.0,
    tol: float = 1e-12,
    verbose: bool = False,
) -> Tuple[Dict[str, float], List[dict]]:
    """
    Solve eq (20) by Bethel's iteration. Returns (strengths, diagnostics).

    strengths: team -> s_t, scaled so sum of log(s_t) is 0. A team at
    exactly 1.0 is the geometric-mean team.

    diagnostics: one row per recorded iteration with the same three
    columns as the paper's Table 1 -- maximum games difference, RMS games
    difference across all T teams, and the log likelihood function (13).
    Both differences must fall to zero; LLF must rise to a maximum.

    virtual_games: Colley-style prior from Section 8. virtual_games=1.0
    adds one win and one loss against a notional average opponent to
    every team. Use it only if you are NOT using a degree-of-win function
    with a floor, since the two solve the same problem and stacking them
    over-shrinks. Bethel warns this breaks winning-percentage
    equivalence.
    """
    games = drop_forfeits(games)

    # build the game list with degrees of win, dropping games the
    # degree-of-win function rejects (strict Bethel drops ties)
    entries: List[Tuple[str, str, float]] = []
    for g in games:
        w = degree_of_win(g.margin)
        if w is None:
            continue
        entries.append((g.home, g.away, float(w)))

    if not entries:
        return {}, []

    names = sorted({h for h, _, _ in entries} | {a for _, a, _ in entries})
    idx = {n: i for i, n in enumerate(names)}
    T = len(names)

    hi = np.array([idx[h] for h, _, _ in entries], dtype=int)
    ai = np.array([idx[a] for _, a, _ in entries], dtype=int)
    wh = np.array([w for _, _, w in entries], dtype=float)
    wa = 1.0 - wh

    # actual (generalized) wins W_t, eq (1)/(2)
    W = np.zeros(T)
    np.add.at(W, hi, wh)
    np.add.at(W, ai, wa)
    if virtual_games:
        W = W + virtual_games  # one virtual win each; the virtual loss
        # enters through the games-count term below

    s = np.ones(T)

    def diagnostics(s_vec: np.ndarray) -> dict:
        d = s_vec[hi] + s_vec[ai]
        p_home = s_vec[hi] / d
        What = np.zeros(T)
        np.add.at(What, hi, p_home)
        np.add.at(What, ai, 1.0 - p_home)
        diff = W - What
        # LLF, eq (13): sum over games of ln(p of the observed outcome).
        # With fractional degrees of win this generalizes to the
        # cross-entropy form; for 0/1 outcomes it is exactly eq (13).
        eps = 1e-15
        pc = np.clip(p_home, eps, 1.0 - eps)
        ll = float(np.sum(wh * np.log(pc) + wa * np.log(1.0 - pc)))
        return {
            "max_games_difference": float(np.max(np.abs(diff))),
            "rms_games_difference": float(np.sqrt(np.mean(diff ** 2))),
            "log_likelihood": ll,
        }

    record_at = {0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
                 60, 70, 80, 90, 100, 120, 140, 160, 180, 200}
    diags: List[dict] = []
    row = diagnostics(s)
    row["iteration"] = 0
    diags.append(row)
    if verbose:
        print("%5s %18s %18s %20s" % ("iter", "max games diff", "rms games diff", "log likelihood"))
        print("%5d %18.8f %18.8f %20.11f" % (0, row["max_games_difference"],
                                             row["rms_games_difference"], row["log_likelihood"]))

    for it in range(1, iterations + 1):
        denom = np.zeros(T)
        inv = 1.0 / (s[hi] + s[ai])
        np.add.at(denom, hi, inv)
        np.add.at(denom, ai, inv)
        if virtual_games:
            # virtual win + virtual loss against a strength-1 opponent
            denom = denom + 2.0 * virtual_games / (s + 1.0)

        with np.errstate(divide="ignore", invalid="ignore"):
            new_s = np.where(denom > 0, W / denom, s)
        new_s = np.clip(new_s, 1e-300, 1e300)

        # rescale so sum of log(s) = 0, per Section 6
        new_s = new_s / math.exp(float(np.mean(np.log(new_s))))

        delta = float(np.max(np.abs(np.log(new_s) - np.log(s))))
        s = new_s

        if it in record_at or it == iterations:
            row = diagnostics(s)
            row["iteration"] = it
            diags.append(row)
            if verbose:
                print("%5d %18.8f %18.8f %20.11f" % (it, row["max_games_difference"],
                                                     row["rms_games_difference"], row["log_likelihood"]))
        if delta < tol:
            break

    if diags[-1]["iteration"] != it:
        row = diagnostics(s)
        row["iteration"] = it
        diags.append(row)
        if verbose:
            print("%5d %18.8f %18.8f %20.11f" % (it, row["max_games_difference"],
                                                 row["rms_games_difference"], row["log_likelihood"]))

    return {n: float(s[i]) for n, i in idx.items()}, diags


# ----------------------------------------------------------------------
# Derived outputs from Section 6
# ----------------------------------------------------------------------

def projected_winning_percentage(strengths: Dict[str, float]) -> Dict[str, float]:
    """
    Eq (21): what each team's winning percentage would be against a
    hypothetical balanced schedule -- every other team, once.

        WPhat_t = (1/(T-1)) * sum over t' != t of s_t/(s_t + s_t')

    Bethel proves this is monotonic with strength, so it ranks teams
    identically. It is the more interpretable number: it lives on the
    familiar 0 to 1 winning-percentage scale instead of an arbitrary
    strength scale.
    """
    names = sorted(strengths)
    s = np.array([strengths[n] for n in names])
    T = len(names)
    if T < 2:
        return {n: 0.5 for n in names}
    out = {}
    for i, n in enumerate(names):
        p = s[i] / (s[i] + s)
        out[n] = float((p.sum() - 0.5) / (T - 1))  # remove the self term
    return out


def schedule_strength_indicator(
    games: Sequence[Game],
    strengths: Dict[str, float],
    degree_of_win: Callable[[int], Optional[float]] = dow_tie_half,
) -> Dict[str, float]:
    """
    Bethel's quantification of strength of schedule (Sections 1 and 4):
    projected winning percentage minus actual winning percentage.

    Positive means the schedule was harder than average -- the team would
    do BETTER against a balanced schedule than it actually did. Negative
    means the schedule was soft.

    This reproduces the paper's headline 1999 NFL finding: St. Louis went
    13-3 (.8125 actual) but projects to .6418, marked down for a weak NFC
    West; Buffalo went 11-5 (.6875) but projects to .7566, marked up for
    a strong AFC East.

    Note this is a DIFFERENT definition from CalPreps' schedule strength,
    which is just the mean of opponent ratings. Don't mix them.
    """
    proj = projected_winning_percentage(strengths)
    acc: Dict[str, List[float]] = {}
    for g in drop_forfeits(games):
        w = degree_of_win(g.margin)
        if w is None:
            continue
        acc.setdefault(g.home, []).append(w)
        acc.setdefault(g.away, []).append(1.0 - w)
    out = {}
    for t, vals in acc.items():
        actual = sum(vals) / len(vals)
        out[t] = proj.get(t, 0.5) - actual
    return out


def bethel_table(games: Sequence[Game], strengths: Dict[str, float],
                 degree_of_win: Callable[[int], Optional[float]] = dow_tie_half) -> List[dict]:
    """Rows in the shape of the paper's Table 2."""
    proj = projected_winning_percentage(strengths)
    sos = schedule_strength_indicator(games, strengths, degree_of_win)
    rec: Dict[str, List[int]] = {}
    for g in drop_forfeits(games):
        for t, m in ((g.home, g.margin), (g.away, -g.margin)):
            r = rec.setdefault(t, [0, 0, 0])
            if m > 0:
                r[0] += 1
            elif m < 0:
                r[1] += 1
            else:
                r[2] += 1
    rows = []
    for t, s in sorted(strengths.items(), key=lambda kv: -kv[1]):
        w, l, d = rec.get(t, [0, 0, 0])
        n = w + l + d
        rows.append({
            "team": t,
            "strength": round(s, 4),
            "log2_strength": round(math.log2(s), 4) if s > 0 else float("-inf"),
            "record": "%d-%d-%d" % (w, l, d),
            "actual_wp": round((w + 0.5 * d) / n, 4) if n else 0.0,
            "projected_wp": round(proj.get(t, 0.5), 4),
            "sched_strength": round(sos.get(t, 0.0), 4),
        })
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


# ----------------------------------------------------------------------
# Verification against the paper
# ----------------------------------------------------------------------

def _verify_iteration_zero() -> None:
    """
    The paper's Table 1 reports, for the 1999 NFL regular season at
    iteration 0 (all strengths equal to 1):

        max games difference   6.00000000
        rms games difference   2.94026551
        log likelihood      -171.90050077887

    With every strength equal, every win probability is 0.5, so
    What_t = 8 for all 31 teams (16 games each) and the LLF is just
    G * ln(0.5). Both published figures are recoverable from Table 2's
    won-lost records alone, without the 1999 schedule. This checks that
    our W_t accounting, our RMS convention (over T teams, not G games),
    and our LLF match the paper.
    """
    wins_1999 = [13, 14, 11, 13, 9, 11, 8, 13, 10, 9, 10, 8, 9, 8, 8, 8,
                 8, 6, 8, 7, 6, 8, 6, 5, 8, 6, 5, 4, 4, 3, 2]
    T = len(wins_1999)
    assert T == 31, T
    G = T * 16 // 2
    diffs = np.array(wins_1999, dtype=float) - 8.0
    max_d = float(np.max(np.abs(diffs)))
    rms_d = float(np.sqrt(np.mean(diffs ** 2)))
    llf = G * math.log(0.5)

    print("Table 1, iteration 0 -- paper vs recomputed")
    print("  max games difference  paper 6.00000000        ours %.8f" % max_d)
    print("  rms games difference  paper 2.94026551        ours %.8f" % rms_d)
    print("  log likelihood        paper -171.90050077887  ours %.11f" % llf)
    assert abs(max_d - 6.0) < 1e-9
    assert abs(rms_d - 2.94026551) < 1e-7
    assert abs(llf - (-171.90050077887)) < 1e-8
    print("  all three match. G = %d games, T = %d teams.\n" % (G, T))


def _verify_balanced_schedule_equals_winning_percentage() -> None:
    """
    Section 3's required property: for a balanced schedule (every team
    plays every other team the same number of times), the ranking by
    strength must be identical to the ranking by winning percentage.
    """
    rng = np.random.default_rng(11)
    names = ["T%d" % i for i in range(12)]
    quality = {n: rng.normal() for n in names}
    games = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            for rep in range(2):  # each pair twice, fully balanced
                a, b = names[i], names[j]
                if rep:
                    a, b = b, a
                home_wins = quality[a] + rng.normal(0, 1.0) > quality[b]
                games.append(Game("2026-01-01", a, b, 1 if home_wins else 0, 0 if home_wins else 1))

    s, _ = bethel_strengths(games, degree_of_win=dow_bethel_strict)
    wins: Dict[str, int] = {n: 0 for n in names}
    played: Dict[str, int] = {n: 0 for n in names}
    for g in games:
        wins[g.home] += 1 if g.margin > 0 else 0
        wins[g.away] += 1 if g.margin < 0 else 0
        played[g.home] += 1
        played[g.away] += 1

    by_strength = [n for n in sorted(names, key=lambda n: -s[n])]
    by_wp = [n for n in sorted(names, key=lambda n: -(wins[n] / played[n]))]
    ok = [wins[n] for n in by_strength] == sorted([wins[n] for n in names], reverse=True)
    print("Balanced schedule: strength order matches winning-percentage order:", ok)
    assert ok, (by_strength, by_wp)

    logs = sum(math.log(v) for v in s.values())
    print("  scaling constraint sum(log s) = %.2e (must be 0)\n" % logs)
    assert abs(logs) < 1e-9


def _verify_convergence_and_fixed_point() -> None:
    """
    At convergence, actual wins must equal predicted wins for every team,
    eq (18), and the log likelihood must rise monotonically to a maximum.

    The schedule below is a single round robin, so it is fully connected
    and, with these draws, contains no winless or undefeated team. Both
    conditions are required: Section 8 says the iteration does not
    converge to a finite solution otherwise.
    """
    rng = np.random.default_rng(5)
    names = ["T%02d" % i for i in range(20)]
    q = {n: rng.normal(0, 1.0) for n in names}
    games = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            an, bn = names[i], names[j]
            home_wins = (q[an] - q[bn] + rng.normal(0, 1.6)) > 0
            games.append(Game("2026-09-01", an, bn, 1 if home_wins else 0, 0 if home_wins else 1))

    wins = {n: 0 for n in names}
    for g in games:
        wins[g.home if g.margin > 0 else g.away] += 1
    n_games = len(names) - 1
    assert all(0 < w < n_games for w in wins.values()), "test data must have no winless/undefeated team"

    s, diags = bethel_strengths(games, degree_of_win=dow_bethel_strict, iterations=2000)
    first, last = diags[0], diags[-1]
    print("Convergence on a connected 20-team single round robin (190 games):")
    print("  iteration %3d: max games diff %.8f, LLF %.8f" %
          (first["iteration"], first["max_games_difference"], first["log_likelihood"]))
    print("  iteration %3d: max games diff %.8f, LLF %.8f" %
          (last["iteration"], last["max_games_difference"], last["log_likelihood"]))
    assert last["max_games_difference"] < 1e-8, last
    lls = [d["log_likelihood"] for d in diags]
    assert all(lls[i] <= lls[i + 1] + 1e-9 for i in range(len(lls) - 1)), "LLF must increase monotonically"
    print("  games differences driven to zero, LLF rose monotonically to a maximum.\n")


def _verify_undefeated_pathology() -> None:
    """
    Section 8: an undefeated team is assigned infinite strength and a
    winless team zero strength, and two undefeated teams cannot be ranked
    relative to each other. Show the blow-up, then show the degree-of-win
    floor fixing it.
    """
    games = [
        Game("2026-09-01", "Perfect", "A", 1, 0),
        Game("2026-09-02", "Perfect", "B", 1, 0),
        Game("2026-09-03", "Perfect", "C", 1, 0),
        Game("2026-09-04", "A", "B", 1, 0),
        Game("2026-09-05", "B", "C", 1, 0),
        Game("2026-09-06", "C", "A", 1, 0),
    ]
    s_200, _ = bethel_strengths(games, degree_of_win=dow_bethel_strict, iterations=200, tol=0.0)
    s_2000, _ = bethel_strengths(games, degree_of_win=dow_bethel_strict, iterations=2000, tol=0.0)
    s_fix, _ = bethel_strengths(games, degree_of_win=make_dow_capped_margin(cap=5.0, floor=0.05),
                                iterations=2000)
    print("Undefeated-team pathology (Section 8):")
    print("  strict Bethel, undefeated strength at   200 iterations: %12.4f" % s_200["Perfect"])
    print("  strict Bethel, undefeated strength at  2000 iterations: %12.4f" % s_2000["Perfect"])
    print("  it does not converge -- it diverges toward infinity, as the paper states")
    print("  with a degree-of-win floor instead:                     %12.4f" % s_fix["Perfect"])
    assert s_2000["Perfect"] > 5 * s_200["Perfect"]
    assert s_fix["Perfect"] < 1e3
    print("  the floor keeps it finite, which is Bethel's own preferred remedy.\n")


if __name__ == "__main__":
    _verify_iteration_zero()
    _verify_balanced_schedule_equals_winning_percentage()
    _verify_convergence_and_fixed_point()
    _verify_undefeated_pathology()

    from mp_rating import load_games
    try:
        games = load_games("sample_ut_girls_2026-09-10.csv")
    except OSError:
        raise SystemExit(0)
    s, _ = bethel_strengths(games, degree_of_win=make_dow_result_dominant(cap=5.0, margin_share=0.25))
    print("Sample file (one day, disconnected graph -- numbers are meaningless):")
    for row in bethel_table(games, s)[:5]:
        print("  %2d %-24s s=%.4f  projWP=%.4f  sched=%+.4f  %s" % (
            row["rank"], row["team"], row["strength"], row["projected_wp"],
            row["sched_strength"], row["record"]))
