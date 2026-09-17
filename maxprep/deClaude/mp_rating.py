"""
mp_rating.py -- candidate reconstructions of the MaxPreps computer rating,
plus the UHSAA RPI (exact, documented) as a baseline.

Input for every model is one flat table of games:
    date, home_team, away_team, home_score, away_score, neutral, is_forfeit

Nothing here is the real MaxPreps formula. MaxPreps has never published it.
These are the three model families that are consistent with everything
MaxPreps and the state associations have said in public, plus a calibration
harness so you can grid-search the free parameters against the published
ratings and see how close you actually get.

ASCII only. Python 3.9+. Requires numpy; scipy optional.
"""

from __future__ import annotations

import csv
import itertools
import math
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np


# ----------------------------------------------------------------------
# Data model
# ----------------------------------------------------------------------

@dataclass
class Game:
    date: str
    home: str
    away: str
    home_score: int
    away_score: int
    neutral: bool = False
    is_forfeit: bool = False

    @property
    def margin(self) -> int:
        """Goal margin from the home team's point of view."""
        return self.home_score - self.away_score

    @property
    def result(self) -> float:
        """1.0 home win, 0.5 draw, 0.0 home loss."""
        if self.home_score > self.away_score:
            return 1.0
        if self.home_score < self.away_score:
            return 0.0
        return 0.5


def load_games(path: str) -> List[Game]:
    """Read the games CSV produced by mp_collect.py (or hand-built)."""
    out: List[Game] = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row.get("home_score") in (None, "", "None") or row.get("away_score") in (None, "", "None"):
                continue  # unplayed
            out.append(
                Game(
                    date=row["date"],
                    home=row["home_team"].strip(),
                    away=row["away_team"].strip(),
                    home_score=int(row["home_score"]),
                    away_score=int(row["away_score"]),
                    neutral=str(row.get("neutral", "")).lower() in ("1", "true", "yes"),
                    is_forfeit=str(row.get("is_forfeit", "")).lower() in ("1", "true", "yes"),
                )
            )
    return out


def team_index(games: Sequence[Game]) -> Dict[str, int]:
    names = sorted({g.home for g in games} | {g.away for g in games})
    return {n: i for i, n in enumerate(names)}


def drop_forfeits(games: Sequence[Game]) -> List[Game]:
    """MaxPreps and the AIA both state forfeits are excluded from ratings."""
    return [g for g in games if not g.is_forfeit]


# ----------------------------------------------------------------------
# Model 0: UHSAA RPI (documented exactly -- used as a sanity baseline)
# ----------------------------------------------------------------------

def uhsaa_rpi(
    games: Sequence[Game],
    w_mwp: float = 0.45,
    w_owp: float = 0.45,
    w_oowp: float = 0.10,
    tie_value: float = 0.5,
) -> Dict[str, Dict[str, float]]:
    """
    RPI = 0.45*MWP + 0.45*OWP + 0.10*OOWP.

    Critical detail from the UHSAA FAQ that most homemade RPI scripts get
    wrong: when computing OWP for team T, each opponent's winning percentage
    is recomputed with the games against T removed. And OWP is the average of
    the opponents' percentages, not the pooled record of the opponents.

    Classification modifiers (the 15 percent cross-class adjustment) are NOT
    implemented here -- as of the 2026-27 UHSAA FAQ, RPI is football only, so
    this exists for comparison, not for seeding soccer.
    """
    games = drop_forfeits(games)
    opp: Dict[str, List[str]] = {}
    rec: Dict[str, List[float]] = {}  # team -> list of per-game results

    for g in games:
        opp.setdefault(g.home, []).append(g.away)
        opp.setdefault(g.away, []).append(g.home)
        r = g.result
        rec.setdefault(g.home, []).append(r if r != 0.5 else tie_value)
        rec.setdefault(g.away, []).append((1.0 - r) if r != 0.5 else tie_value)

    # per-game results keyed by (team, opponent) so we can excise head-to-head
    per_opp: Dict[str, List[Tuple[str, float]]] = {}
    for g in games:
        r = g.result
        per_opp.setdefault(g.home, []).append((g.away, r if r != 0.5 else tie_value))
        per_opp.setdefault(g.away, []).append((g.home, (1.0 - r) if r != 0.5 else tie_value))

    def wp(team: str, excluding: Optional[str] = None) -> float:
        vals = [v for (o, v) in per_opp.get(team, []) if o != excluding]
        return sum(vals) / len(vals) if vals else 0.0

    out: Dict[str, Dict[str, float]] = {}
    for team in per_opp:
        mwp = wp(team)
        opps = [o for (o, _) in per_opp[team]]
        owp = sum(wp(o, excluding=team) for o in opps) / len(opps) if opps else 0.0

        oowp_terms = []
        for o in opps:
            oo = [x for (x, _) in per_opp.get(o, [])]
            if oo:
                oowp_terms.append(sum(wp(x, excluding=o) for x in oo) / len(oo))
        oowp = sum(oowp_terms) / len(oowp_terms) if oowp_terms else 0.0

        out[team] = {
            "rpi": w_mwp * mwp + w_owp * owp + w_oowp * oowp,
            "mwp": mwp,
            "owp": owp,
            "oowp": oowp,
            "games": float(len(opps)),
        }
    return out


# ----------------------------------------------------------------------
# Model A: Bradley-Terry / Bethel-style retrodictive MLE (result only)
# ----------------------------------------------------------------------

def bradley_terry(
    games: Sequence[Game],
    prior_sd: float = 1.0,
    home_adv: Optional[float] = 0.0,
    max_iter: int = 500,
    tol: float = 1e-9,
) -> Dict[str, float]:
    """
    Logistic (Bradley-Terry) maximum a posteriori ratings on win/loss/draw.

    This is the family the AIA says its MaxPreps-built seeding formula comes
    from: Roy Bethel, "A Solution to the Unequal Strength of Schedule
    Problem" (2005). Bethel's paper is a likelihood-based rating over the
    whole connected game graph, which is exactly what "infinitely deep,
    not two layers like RPI" means in the state FAQs.

    prior_sd is the Gaussian prior that keeps undefeated / winless teams
    from running off to infinity. Bethel handles this with a prior too;
    the exact width MaxPreps uses is unknown and is a calibration knob.

    Draws are handled as half a win plus half a loss, which is the cheap
    version of the "extra loop for ties" MaxPreps says it added.
    """
    games = drop_forfeits(games)
    idx = team_index(games)
    n = len(idx)
    r = np.zeros(n)
    lam = 1.0 / (prior_sd ** 2)

    rows = []
    for g in games:
        h, a = idx[g.home], idx[g.away]
        adv = 0.0 if (g.neutral or home_adv is None) else float(home_adv)
        res = g.result
        if res == 0.5:
            rows.append((h, a, adv, 1.0, 0.5))
        else:
            rows.append((h, a, adv, 1.0, res))

    for _ in range(max_iter):
        grad = -lam * r
        hess_diag = np.full(n, lam)
        for (h, a, adv, w, y) in rows:
            d = r[h] - r[a] + adv
            p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, d))))
            e = w * (y - p)
            grad[h] += e
            grad[a] -= e
            v = w * p * (1.0 - p)
            hess_diag[h] += v
            hess_diag[a] += v
        step = grad / hess_diag
        r += step
        r -= r.mean()
        if np.max(np.abs(step)) < tol:
            break

    return {name: float(r[i]) for name, i in idx.items()}


# ----------------------------------------------------------------------
# Model B: Freeman-style capped-margin least squares power rating
# ----------------------------------------------------------------------

def margin_power_rating(
    games: Sequence[Game],
    cap: float = 5.0,
    ridge: float = 1.0,
    home_adv: Optional[float] = None,
    result_bonus: float = 0.0,
    recency_halflife_days: Optional[float] = None,
    max_iter: int = 200,
) -> Dict[str, float]:
    """
    Ratings on a goals scale. Predicted margin for home team = r_h - r_a + hfa.
    Observed margin is clipped to +/- cap before fitting.

    Why this family: the MaxPreps.com ratings are produced by the Freeman
    system (Ned Freeman, also behind CalPreps). Freeman ratings are explicitly
    a margin-based power rating with a cutoff above which extra margin stops
    counting. MaxPreps' own FAQ says margin counts "with diminishing returns
    past a clear-win ceiling", and the AIA FAQ names the soccer cap as 5 goals.

    result_bonus adds a fixed goal-equivalent nudge in the direction of the
    winner, on top of the capped margin. This is how you encode UHSAA's
    statement that "score differential is a factor but has a much smaller
    impact than the actual result" without abandoning the margin scale.
    Set it to 0 for a pure margin fit; 0.5 to 1.5 makes results dominate.

    home_adv: pass a float to fix it, or None to estimate it jointly.
    """
    games = drop_forfeits(games)
    idx = team_index(games)
    n = len(idx)
    if n == 0:
        return {}

    est_hfa = home_adv is None
    hfa = 0.0 if home_adv is None else float(home_adv)

    # recency weights
    weights = np.ones(len(games))
    if recency_halflife_days:
        import datetime as _dt

        def _d(s: str) -> _dt.date:
            for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
                try:
                    return _dt.datetime.strptime(s, fmt).date()
                except ValueError:
                    continue
            raise ValueError("unparsed date: " + s)

        dates = [_d(g.date) for g in games]
        latest = max(dates)
        for i, d in enumerate(dates):
            age = (latest - d).days
            weights[i] = 0.5 ** (age / float(recency_halflife_days))

    y = np.empty(len(games))
    hi = np.empty(len(games), dtype=int)
    ai = np.empty(len(games), dtype=int)
    at_home = np.empty(len(games))
    for i, g in enumerate(games):
        hi[i] = idx[g.home]
        ai[i] = idx[g.away]
        at_home[i] = 0.0 if g.neutral else 1.0
        m = float(np.clip(g.margin, -cap, cap))
        if result_bonus:
            m += result_bonus * np.sign(g.margin)
        y[i] = m

    r = np.zeros(n)
    for _ in range(max_iter):
        # solve ridge least squares for r given hfa (Gauss-Seidel style)
        num = np.zeros(n)
        den = np.full(n, ridge)
        target = y - hfa * at_home
        for i in range(len(games)):
            w = weights[i]
            num[hi[i]] += w * (target[i] + r[ai[i]])
            den[hi[i]] += w
            num[ai[i]] += w * (r[hi[i]] - target[i])
            den[ai[i]] += w
        new_r = num / den
        new_r -= new_r.mean()
        delta = np.max(np.abs(new_r - r))
        r = new_r
        if est_hfa:
            mask = at_home > 0
            if mask.any():
                resid = y[mask] - (r[hi[mask]] - r[ai[mask]])
                hfa = float(np.average(resid, weights=weights[mask]))
        if delta < 1e-10:
            break

    return {name: float(r[i]) for name, i in idx.items()}


# ----------------------------------------------------------------------
# Derived quantities MaxPreps displays
# ----------------------------------------------------------------------

def strength_of_schedule(games: Sequence[Game], ratings: Dict[str, float]) -> Dict[str, float]:
    """CalPreps defines schedule strength as the plain mean of opponent ratings."""
    acc: Dict[str, List[float]] = {}
    for g in drop_forfeits(games):
        acc.setdefault(g.home, []).append(ratings.get(g.away, 0.0))
        acc.setdefault(g.away, []).append(ratings.get(g.home, 0.0))
    return {t: (sum(v) / len(v) if v else 0.0) for t, v in acc.items()}


def to_table(ratings: Dict[str, float], games: Sequence[Game]) -> List[dict]:
    sos = strength_of_schedule(games, ratings)
    rec: Dict[str, List[int]] = {}
    for g in drop_forfeits(games):
        for t, res in ((g.home, g.result), (g.away, 1.0 - g.result)):
            w, l, d = rec.setdefault(t, [0, 0, 0])
            if res == 1.0:
                rec[t][0] = w + 1
            elif res == 0.0:
                rec[t][1] = l + 1
            else:
                rec[t][2] = d + 1
    rows = []
    for t, v in sorted(ratings.items(), key=lambda kv: -kv[1]):
        w, l, d = rec.get(t, [0, 0, 0])
        rows.append({
            "team": t,
            "rating": round(v, 4),
            "sos": round(sos.get(t, 0.0), 4),
            "record": "%d-%d-%d" % (w, l, d),
        })
    for i, row in enumerate(rows, start=1):
        row["rank"] = i
    return rows


# ----------------------------------------------------------------------
# Calibration: fit the free parameters to published MaxPreps output
# ----------------------------------------------------------------------

def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    def ranks(x):
        order = sorted(range(len(x)), key=lambda i: x[i])
        rk = [0.0] * len(x)
        for pos, i in enumerate(order):
            rk[i] = float(pos)
        return rk
    ra, rb = ranks(a), ranks(b)
    n = len(ra)
    if n < 2:
        return float("nan")
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((ra[i] - ma) * (rb[i] - mb) for i in range(n))
    da = math.sqrt(sum((x - ma) ** 2 for x in ra))
    db = math.sqrt(sum((x - mb) ** 2 for x in rb))
    return num / (da * db) if da and db else float("nan")


def kendall_tau(a: Sequence[float], b: Sequence[float]) -> float:
    n = len(a)
    conc = disc = 0
    for i in range(n):
        for j in range(i + 1, n):
            s = (a[i] - a[j]) * (b[i] - b[j])
            if s > 0:
                conc += 1
            elif s < 0:
                disc += 1
    tot = conc + disc
    return (conc - disc) / tot if tot else float("nan")


def calibrate(
    games: Sequence[Game],
    published: Dict[str, float],
    caps: Iterable[float] = (3.0, 4.0, 5.0, 6.0, 99.0),
    ridges: Iterable[float] = (0.25, 0.5, 1.0, 2.0, 4.0),
    bonuses: Iterable[float] = (0.0, 0.5, 1.0, 1.5, 2.0),
    halflives: Iterable[Optional[float]] = (None,),
    home_advs: Iterable[Optional[float]] = (None, 0.0),
) -> List[dict]:
    """
    Grid-search the margin model against a scraped snapshot of MaxPreps
    ratings (or just their rank order) and report fit.

    `published` maps team name -> MaxPreps rating (or -rank if you only have
    the ordering; Spearman/tau only care about order).

    Returns rows sorted by descending Spearman. Report BOTH Spearman and
    the top-16 seed agreement, because for playoff seeding only the top of
    the list matters and a model can win on Spearman while scrambling seeds.
    """
    common = [t for t in published if t in {g.home for g in games} | {g.away for g in games}]
    results = []
    for cap, ridge, bonus, hl, hadv in itertools.product(caps, ridges, bonuses, halflives, home_advs):
        r = margin_power_rating(
            games, cap=cap, ridge=ridge, result_bonus=bonus,
            recency_halflife_days=hl, home_adv=hadv,
        )
        mine = [r.get(t, 0.0) for t in common]
        theirs = [published[t] for t in common]
        rho = spearman(mine, theirs)
        tau = kendall_tau(mine, theirs)

        k = min(16, len(common))
        top_mine = {t for t in sorted(common, key=lambda t: -r.get(t, 0.0))[:k]}
        top_theirs = {t for t in sorted(common, key=lambda t: -published[t])[:k]}
        results.append({
            "cap": cap, "ridge": ridge, "result_bonus": bonus,
            "halflife": hl, "home_adv": hadv,
            "spearman": round(rho, 4), "kendall_tau": round(tau, 4),
            "top%d_overlap" % k: len(top_mine & top_theirs),
            "n_teams": len(common),
        })
    results.sort(key=lambda d: (-d["spearman"]))
    return results


# ----------------------------------------------------------------------
# Self-test on synthetic data
# ----------------------------------------------------------------------

def _synthetic(n_teams: int = 40, n_games: int = 400, seed: int = 7) -> Tuple[List[Game], Dict[str, float]]:
    rng = np.random.default_rng(seed)
    names = ["T%02d" % i for i in range(n_teams)]
    true = {n: float(rng.normal(0, 1.5)) for n in names}
    games = []
    for k in range(n_games):
        h, a = rng.choice(n_teams, size=2, replace=False)
        hn, an = names[h], names[a]
        mu = true[hn] - true[an] + 0.25
        m = int(round(rng.normal(mu, 1.3)))
        hs = max(0, 1 + max(0, m))
        as_ = max(0, hs - m)
        games.append(Game("2026-09-%02d" % (1 + k % 28), hn, an, hs, as_))
    return games, true


if __name__ == "__main__":
    games, true = _synthetic()
    print("synthetic: %d teams, %d games" % (len({g.home for g in games} | {g.away for g in games}), len(games)))

    bt = bradley_terry(games)
    mp = margin_power_rating(games, cap=5.0, ridge=1.0, result_bonus=0.0)
    rpi = {t: v["rpi"] for t, v in uhsaa_rpi(games).items()}

    keys = sorted(true)
    for label, est in (("bradley_terry", bt), ("margin_power", mp), ("uhsaa_rpi", rpi)):
        a = [est.get(t, 0.0) for t in keys]
        b = [true[t] for t in keys]
        print("%-14s spearman vs truth = %.4f" % (label, spearman(a, b)))

    print()
    print("top 5 by margin_power:")
    for row in to_table(mp, games)[:5]:
        print("  %2d  %-6s rating %7.3f  sos %7.3f  %s" % (
            row["rank"], row["team"], row["rating"], row["sos"], row["record"]))

    print()
    print("calibration demo (target = true strengths):")
    for row in calibrate(games, true, caps=(3.0, 5.0, 99.0), ridges=(0.5, 1.0),
                         bonuses=(0.0, 1.0))[:4]:
        print(" ", row)
