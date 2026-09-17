"""
mp_whatif.py -- turn the rating models into decisions.

Answers three questions, in the coach's language:

  1. "If we play team X and the result is Y, where does our seed move?"
  2. "Across the range of opponents we could schedule, which ones move us
     up and which move us down?"
  3. "Does running the score up past the cap do anything?"
  4. "If we swap a cheap win for a close loss to a top team, where do we move?"
     (--mode swap; needs --games. Without it, prints direction and exits.)

Everything runs both model families side by side:

  bethel  -- the published retrodictive algorithm (mp_bethel.py). Result
             dominant. This is the ancestor of the state-seeding variant.
  margin  -- least-squares on capped goal margin (mp_rating.py). The
             Freeman/CalPreps shape, which is what the maxpreps.com
             rating that Utah now seeds off actually is.

Where both models agree on the direction of a decision, act on it. Where
they disagree, do not: the disagreement is exactly the part of the real
formula that is still unknown, and calibration has to settle it.

Seeding happens inside a classification, so pass a pool file (team,class)
to rank within 5A rather than against the whole state. Rating is computed
against every team in the data regardless -- classification never enters
the rating, only the ranking you read off it.

ASCII only. Python 3.9+.
"""

from __future__ import annotations

import argparse
import copy
import csv
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from mp_rating import Game, load_games, margin_power_rating
from mp_bethel import (bethel_strengths, make_dow_result_dominant,
                       projected_winning_percentage)

SOCCER_CAP = 5.0  # goals; the cap the AIA publishes for MaxPreps soccer


# ----------------------------------------------------------------------
# Model wrappers -- both return "bigger is better" on their own scale
# ----------------------------------------------------------------------

def rate_bethel(games: Sequence[Game], cap: float = SOCCER_CAP,
                margin_share: float = 0.25, floor: float = 0.05) -> Dict[str, float]:
    dow = make_dow_result_dominant(cap=cap, margin_share=margin_share, floor=floor)
    s, _ = bethel_strengths(games, degree_of_win=dow, iterations=400)
    # report on the projected-winning-percentage scale: same ordering,
    # but interpretable and not sensitive to the arbitrary strength scale
    return projected_winning_percentage(s)


def rate_margin(games: Sequence[Game], cap: float = SOCCER_CAP,
                ridge: float = 1.0, result_bonus: float = 1.0) -> Dict[str, float]:
    return margin_power_rating(games, cap=cap, ridge=ridge,
                               result_bonus=result_bonus, home_adv=None)


MODELS: Dict[str, Callable[[Sequence[Game]], Dict[str, float]]] = {
    "bethel": rate_bethel,
    "margin": rate_margin,
}


# ----------------------------------------------------------------------
# Pools and ranking
# ----------------------------------------------------------------------

def load_pool(path: Optional[str]) -> Optional[Dict[str, str]]:
    """CSV with columns team,classification. Returns team -> class."""
    if not path:
        return None
    out = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out[row["team"].strip()] = row.get("classification", "").strip()
    return out


def rank_in_pool(team: str, ratings: Dict[str, float],
                 pool: Optional[Sequence[str]] = None) -> int:
    members = [t for t in ratings if pool is None or t in pool]
    members.sort(key=lambda t: -ratings.get(t, 0.0))
    return members.index(team) + 1 if team in members else -1


def pool_for(team: str, classes: Optional[Dict[str, str]]) -> Optional[List[str]]:
    if not classes:
        return None
    my = classes.get(team)
    if not my:
        return None
    return [t for t, c in classes.items() if c == my]


# ----------------------------------------------------------------------
# The core primitive: add a hypothetical game, re-rate, measure the move
# ----------------------------------------------------------------------

def add_game(games: Sequence[Game], team: str, opponent: str,
             goals_for: int, goals_against: int,
             date: str = "2099-01-01", neutral: bool = True) -> List[Game]:
    g = list(games)
    g.append(Game(date, team, opponent, goals_for, goals_against, neutral=neutral))
    return g


def what_if(games: Sequence[Game], team: str, opponent: str,
            goals_for: int, goals_against: int,
            model: str = "bethel",
            classes: Optional[Dict[str, str]] = None,
            baseline: Optional[Tuple[Dict[str, float], int]] = None) -> dict:
    """
    Effect of one hypothetical result on `team`'s rating and seed.

    Note this holds the rest of the world fixed, which is not quite what
    happens in reality: your opponent's own future games also move, and
    the whole national graph re-solves. It is the right tool for "which
    of these two games should we schedule", not for forecasting the
    exact seed you will finish with.
    """
    pool = pool_for(team, classes)
    rater = MODELS[model]

    if baseline is None:
        base_r = rater(games)
        base_rank = rank_in_pool(team, base_r, pool)
    else:
        base_r, base_rank = baseline

    new_r = rater(add_game(games, team, opponent, goals_for, goals_against))
    new_rank = rank_in_pool(team, new_r, pool)

    return {
        "model": model,
        "opponent": opponent,
        "opp_rating": round(base_r.get(opponent, float("nan")), 4),
        "score": "%d-%d" % (goals_for, goals_against),
        "rating_before": round(base_r.get(team, 0.0), 4),
        "rating_after": round(new_r.get(team, 0.0), 4),
        "rating_delta": round(new_r.get(team, 0.0) - base_r.get(team, 0.0), 4),
        "rank_before": base_rank,
        "rank_after": new_rank,
        "rank_delta": base_rank - new_rank,  # positive = moved up
    }


# ----------------------------------------------------------------------
# Q1: the scheduling grid
# ----------------------------------------------------------------------

def opponent_tiers(ratings: Dict[str, float], team: str,
                   n: int = 5) -> List[Tuple[str, str]]:
    """
    Pick n representative opponents spread across the rating range,
    labelled relative to `team`. Returns (label, opponent_name).
    """
    others = sorted([t for t in ratings if t != team], key=lambda t: -ratings[t])
    if not others:
        return []
    me = ratings[team]
    picks = []
    idxs = np.linspace(0, len(others) - 1, num=min(n, len(others))).astype(int)
    for i in idxs:
        o = others[int(i)]
        gap = ratings[o] - me
        if gap > 0.02:
            lab = "stronger than us"
        elif gap > -0.02:
            lab = "about even"
        elif gap > -0.15:
            lab = "somewhat weaker"
        else:
            lab = "much weaker"
        picks.append(("%s (%s)" % (o, lab), o))
    return picks


def scheduling_grid(games: Sequence[Game], team: str,
                    classes: Optional[Dict[str, str]] = None,
                    models: Sequence[str] = ("bethel", "margin"),
                    outcomes: Sequence[Tuple[str, int, int]] = (
                        ("win by 5+", 5, 0),
                        ("win by 2", 3, 1),
                        ("win by 1", 2, 1),
                        ("draw", 1, 1),
                        ("lose by 1", 1, 2),
                        ("lose by 3", 1, 4),
                    ),
                    n_opponents: int = 5) -> List[dict]:
    """
    The headline table. Rows: candidate opponent x plausible result.
    Columns: rating and seed movement under each model.

    Read it as: "if we add this game to the schedule and it goes this
    way, our seed moves by this much."
    """
    rows = []
    baselines = {}
    for m in models:
        r = MODELS[m](games)
        baselines[m] = (r, rank_in_pool(team, r, pool_for(team, classes)))

    ref = baselines[models[0]][0]
    tiers = opponent_tiers(ref, team, n=n_opponents)

    for label, opp in tiers:
        for oname, gf, ga in outcomes:
            row = {"opponent": label, "result": oname, "score": "%d-%d" % (gf, ga)}
            for m in models:
                res = what_if(games, team, opp, gf, ga, model=m,
                              classes=classes, baseline=baselines[m])
                row["%s_rating_delta" % m] = res["rating_delta"]
                row["%s_rank_delta" % m] = res["rank_delta"]
            rows.append(row)
    return rows


# ----------------------------------------------------------------------
# Q2: does running up the score do anything?
# ----------------------------------------------------------------------

def mercy_curve(games: Sequence[Game], team: str, opponent: str,
                max_margin: int = 9,
                models: Sequence[str] = ("bethel", "margin"),
                classes: Optional[Dict[str, str]] = None) -> List[dict]:
    """
    Rating gain from beating the same opponent by 1, 2, ... max_margin.

    Expect the curve to go flat at the cap. The AIA publishes a 5-goal
    cap for MaxPreps soccer and UHSAA says outright that running up
    scores will not improve a rating. This shows you the shape of that,
    and lets you check whether a fitted cap matches the published one.
    """
    baselines = {m: (MODELS[m](games), rank_in_pool(team, MODELS[m](games),
                                                    pool_for(team, classes)))
                 for m in models}
    rows = []
    for margin in range(1, max_margin + 1):
        row = {"score": "%d-0" % margin, "margin": margin}
        for m in models:
            res = what_if(games, team, opponent, margin, 0, model=m,
                          classes=classes, baseline=baselines[m])
            row["%s_rating_delta" % m] = res["rating_delta"]
        rows.append(row)
    return rows


# ----------------------------------------------------------------------
# Q3: the remaining schedule
# ----------------------------------------------------------------------

def team_from_snapshot(path: str, rank: int) -> str:
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if int(row["rank"]) == rank:
                return row["team"]
    raise SystemExit("rank %d not in %s" % (rank, path))


def brighton_won(game: Game, team: str, opponent: str) -> bool:
    if game.is_forfeit:
        return False
    if game.home == team and game.away == opponent:
        return game.home_score > game.away_score
    if game.away == team and game.home == opponent:
        return game.away_score > game.home_score
    return False


def drop_wins_vs(games: Sequence[Game], team: str, opponent: str) -> Tuple[List[Game], List[Game]]:
    kept: List[Game] = []
    dropped: List[Game] = []
    for g in games:
        if brighton_won(g, team, opponent):
            dropped.append(g)
        else:
            kept.append(g)
    return kept, dropped


def parse_score(text: str) -> Tuple[int, int]:
    a, b = text.replace(" ", "").split("-", 1)
    return int(a), int(b)


def swap_without_games_message() -> str:
    return (
        "SWAP needs the season game graph (--games), not just the rankings table.\n"
        "Brighton did not play #75 Logan. Closest real cheap wins are Cyprus "
        "(#80) and Hillcrest (#64). A 1-2 loss to #5 Lone Peak in place of "
        "either does not climb the ranking in the current models (margin down, "
        "Bethel flat). Re-run with a real drop team:\n"
        "  python3 mp_whatif.py --mode swap --games ../data/ut_girls_soccer_2026.csv "
        "--team Brighton \\\n"
        "    --snapshot ../data/ut_girls_rankings_2026-09-13.csv \\\n"
        "    --drop Cyprus --add-rank 5 --add-score 1-2"
    )


def run_swap(games: Sequence[Game], team: str, classes: Optional[Dict[str, str]],
             args: argparse.Namespace) -> int:
    drop = args.drop
    add = args.add_team
    if args.drop_rank:
        if not args.snapshot:
            print("--drop-rank needs --snapshot")
            return 1
        drop = team_from_snapshot(args.snapshot, args.drop_rank)
    if args.add_rank:
        if not args.snapshot:
            print("--add-rank needs --snapshot")
            return 1
        add = team_from_snapshot(args.snapshot, args.add_rank)
    if not drop or not add:
        print("swap needs --drop/--add or --drop-rank/--add-rank")
        return 1

    gf, ga = parse_score(args.add_score)
    remaining, dropped = drop_wins_vs(games, team, drop)
    if not dropped:
        print("No Brighton win vs %s in the games file. Cannot swap a result that is not there." % drop)
        print("Teams in file may use a different spelling. Not inventing a number.")
        return 1

    print("Removed %d win(s) vs %s:" % (len(dropped), drop))
    for g in dropped:
        print("  %s  %s %d-%d %s" % (g.date, g.away, g.away_score, g.home_score, g.home))

    swapped = add_game(remaining, team, add, gf, ga)
    print("Added hypothetical: %s %d-%d %s (us listed first)\n" % (team, gf, ga, add))

    rows = []
    for model in ("bethel", "margin"):
        base_r = MODELS[model](games)
        new_r = MODELS[model](swapped)
        pool = pool_for(team, classes)
        before = rank_in_pool(team, base_r, pool)
        after = rank_in_pool(team, new_r, pool)
        rows.append({
            "model": model,
            "rating_before": round(base_r.get(team, 0.0), 4),
            "rating_after": round(new_r.get(team, 0.0), 4),
            "rating_delta": round(new_r.get(team, 0.0) - base_r.get(team, 0.0), 4),
            "rank_before": before,
            "rank_after": after,
            "rank_delta": before - after,
        })
    print_table(rows)
    print("\nPositive rank_delta = moved up. Models disagree on sign → treat as unclear.")
    return 0


def remaining_schedule_report(games: Sequence[Game], team: str,
                              upcoming: Sequence[str],
                              classes: Optional[Dict[str, str]] = None,
                              model: str = "bethel") -> List[dict]:
    """
    For each opponent still on the schedule, the seed swing between the
    best plausible result and the worst. Big swing = the game that
    actually matters. Use it to decide where to spend a tired squad.
    """
    r = MODELS[model](games)
    base = (r, rank_in_pool(team, r, pool_for(team, classes)))
    rows = []
    for opp in upcoming:
        if opp not in r:
            rows.append({"opponent": opp, "note": "not in data yet"})
            continue
        best = what_if(games, team, opp, 5, 0, model=model, classes=classes, baseline=base)
        worst = what_if(games, team, opp, 0, 2, model=model, classes=classes, baseline=base)
        rows.append({
            "opponent": opp,
            "opp_rating": round(r[opp], 4),
            "best_case_rank_delta": best["rank_delta"],
            "worst_case_rank_delta": worst["rank_delta"],
            "swing": best["rank_delta"] - worst["rank_delta"],
        })
    rows.sort(key=lambda d: -d.get("swing", -999))
    return rows


# ----------------------------------------------------------------------
# Printing
# ----------------------------------------------------------------------

def print_table(rows: Sequence[dict], cols: Optional[Sequence[str]] = None) -> None:
    if not rows:
        print("  (no rows)")
        return
    cols = list(cols or rows[0].keys())
    widths = {c: max(len(str(c)), max(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    print("  " + "  ".join(str(c).ljust(widths[c]) for c in cols))
    print("  " + "  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  " + "  ".join(str(r.get(c, "")).ljust(widths[c]) for c in cols))


# ----------------------------------------------------------------------
# Demo season so the tools are runnable before you have real data
# ----------------------------------------------------------------------

def demo_season(seed: int = 3) -> Tuple[List[Game], Dict[str, str]]:
    """
    Synthetic Utah-shaped season: five classifications, regions inside
    them, a realistic amount of cross-class non-region scheduling, and
    goal totals drawn from strength gaps. Structure only -- no real
    teams, no real results.
    """
    rng = np.random.default_rng(seed)
    classes: Dict[str, str] = {}
    quality: Dict[str, float] = {}
    by_class: Dict[str, List[str]] = {}
    for cls, n, mu in (("6A", 20, 0.5), ("5A", 20, 0.3), ("4A", 20, 0.0),
                       ("3A", 16, -0.4), ("2A", 14, -0.8)):
        names = ["%s-%02d" % (cls, i) for i in range(n)]
        by_class[cls] = names
        for nm in names:
            classes[nm] = cls
            quality[nm] = float(rng.normal(mu, 0.9))

    def play(a: str, b: str, date: str) -> Game:
        mu = quality[a] - quality[b]
        lam_a = max(0.15, 1.6 + 0.75 * mu)
        lam_b = max(0.15, 1.6 - 0.75 * mu)
        return Game(date, a, b, int(rng.poisson(lam_a)), int(rng.poisson(lam_b)))

    games: List[Game] = []
    d = 1
    # region play: split each class into regions of ~5, double round robin
    for cls, names in by_class.items():
        for start in range(0, len(names), 5):
            reg = names[start:start + 5]
            for i in range(len(reg)):
                for j in range(len(reg)):
                    if i != j:
                        games.append(play(reg[i], reg[j], "2026-09-%02d" % (1 + d % 28)))
                        d += 1
    # non-region / preseason: cross-class
    allnames = [n for v in by_class.values() for n in v]
    for _ in range(260):
        a, b = rng.choice(len(allnames), size=2, replace=False)
        games.append(play(allnames[a], allnames[b], "2026-08-%02d" % (1 + d % 28)))
        d += 1
    return games, classes


def _demo() -> None:
    games, classes = demo_season()
    # pick a team that is near but not at the top of 5A. If you are
    # already the 1 seed there is no upward move available and every
    # row in the grid reads zero or negative, which is true but not
    # informative.
    r0 = MODELS["bethel"](games)
    fives = sorted([t for t, c in classes.items() if c == "5A"], key=lambda t: -r0[t])
    us = fives[3]
    print("DEMO SEASON: %d games, %d teams. Our team: %s (%s)\n"
          % (len(games), len({g.home for g in games} | {g.away for g in games}), us, classes[us]))

    for m in ("bethel", "margin"):
        r = MODELS[m](games)
        print("%s model: our rating %.4f, seed %d in %s"
              % (m, r[us], rank_in_pool(us, r, pool_for(us, classes)), classes[us]))
    print()

    print("SCHEDULING GRID -- what adding one game does to our seed")
    grid = scheduling_grid(games, us, classes=classes, n_opponents=4)
    print_table(grid, ["opponent", "result", "score",
                       "bethel_rating_delta", "bethel_rank_delta",
                       "margin_rating_delta", "margin_rank_delta"])
    print()

    r = MODELS["bethel"](games)
    weakest = min((t for t in r if t != us), key=lambda t: r[t])
    print("MERCY CURVE -- beating %s by 1 through 9" % weakest)
    print_table(mercy_curve(games, us, weakest, classes=classes),
                ["score", "margin", "bethel_rating_delta", "margin_rating_delta"])
    print()

    upcoming = sorted((t for t in r if t != us), key=lambda t: -r[t])[:3] + [weakest]
    print("REMAINING SCHEDULE -- which games actually swing our seed")
    print_table(remaining_schedule_report(games, us, upcoming, classes=classes),
                ["opponent", "opp_rating", "best_case_rank_delta",
                 "worst_case_rank_delta", "swing"])


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--games", help="games CSV from mp_collect.py")
    p.add_argument("--team", help="our team name, exactly as it appears in the data")
    p.add_argument("--pool", help="CSV with columns team,classification")
    p.add_argument("--mode", default="grid",
                   choices=["grid", "mercy", "remaining", "demo", "swap"])
    p.add_argument("--opponent", help="for --mode mercy")
    p.add_argument("--upcoming", nargs="*", default=[], help="for --mode remaining")
    p.add_argument("--snapshot", help="rankings CSV; used by --mode swap to resolve --drop-rank / --add-rank")
    p.add_argument("--drop", help="for --mode swap: team whose Brighton win we remove")
    p.add_argument("--add", dest="add_team", help="for --mode swap: opponent we hypothetically lose to")
    p.add_argument("--drop-rank", type=int, help="for --mode swap: resolve drop team from --snapshot")
    p.add_argument("--add-rank", type=int, help="for --mode swap: resolve add team from --snapshot")
    p.add_argument("--add-score", default="1-2", help="for --mode swap: our goals-opponent goals (default 1-2)")
    args = p.parse_args()

    if args.mode == "swap" and not args.games:
        print(swap_without_games_message())
        return 2

    if args.mode == "demo" or not args.games:
        _demo()
        return 0

    games = load_games(args.games)
    classes = load_pool(args.pool)
    team = args.team
    if team not in ({g.home for g in games} | {g.away for g in games}):
        print("Team %r not found. Check the exact spelling in the games CSV." % team)
        return 1

    if args.mode == "grid":
        print_table(scheduling_grid(games, team, classes=classes))
    elif args.mode == "mercy":
        print_table(mercy_curve(games, team, args.opponent, classes=classes))
    elif args.mode == "remaining":
        print_table(remaining_schedule_report(games, team, args.upcoming, classes=classes))
    elif args.mode == "swap":
        return run_swap(games, team, classes, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
