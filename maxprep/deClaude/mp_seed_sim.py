"""
mp_seed_sim.py -- Tuesday result x friendly grid for the 5A top-4 bracket.

Anchors each team at its published MaxPreps rating and adds the model's
rating change from games played after the snapshot's cutoff, plus the
hypothetical ones. Shootouts are wins (see mp_shootouts.py).

Goal: Brighton seeded 2 or 3, Olympus and Bountiful seeded 1 or 4, so
those two meet in a semifinal before Brighton faces either.

    python3 mp_seed_sim.py --out /tmp/seed_sim.csv
"""

from __future__ import annotations

import argparse
import csv
from typing import Dict, List, Optional, Tuple

from mp_bethel import bethel_strengths, make_dow_result_dominant, projected_winning_percentage
from mp_rating import Game, load_games, margin_power_rating
from mp_shootouts import EPS, apply_shootouts, load_shootouts

D = "../data/"
SNAPSHOT_CUTOFF = "2026-09-29"

# (shootout mode, cap, result_bonus, ridge, slope to MaxPreps scale)
CALS = [("win1", 5, 10, 1.0, 1.336),
        ("win0", 6, 15, 1.0, 0.959),
        ("win1", 4, 6, 1.0, 1.990)]

# (shootout mode, margin_share, floor). Bethel has no MaxPreps-scale anchor;
# rank straight off projected winning percentage. The first reproduces the
# 2026-10-04 5A top 8 exactly; the others are the nearest runners-up.
BETHEL_CALS = [("win0", 0.5, 0.10),
               ("win1", 0.5, 0.10),
               ("win0", 0.25, 0.02)]

OTHER_OCT6 = [Game("2026-10-06", "Payson", "Maple Mountain", 0, 3),
              Game("2026-10-06", "Woods Cross", "Bountiful", 0, 3),
              Game("2026-10-06", "Salem Hills", "Timpview", 1, 2)]

# Viewmont is home. Scores are (Viewmont, Olympus); +EPS marks a shootout winner.
TUESDAY = {
    "Olympus wins 3-0": (0, 3),
    "Olympus wins 1-0": (0, 1),
    "Olympus wins on PKs": (1, 1 + EPS),
    "Viewmont wins on PKs": (1 + EPS, 1),
    "Viewmont wins 1-0": (1, 0),
}

OPPONENTS = ["Lone Peak", "Park City", "Crimson Cliffs", "Green Canyon", "Davis",
             "Farmington", "Lehi", "East", "Syracuse", "Corner Canyon"]
# Brighton goals, opponent goals
FRIENDLY_RESULTS = {"W 2-0": (2, 0), "W 1-0": (1, 0), "W PKs": (1 + EPS, 1),
                    "L PKs": (1, 1 + EPS), "L 0-1": (0, 1)}


def rate(games: List[Game], cal) -> Dict[str, float]:
    mode, cap, rb, ridge, _ = cal
    return margin_power_rating(games, cap=cap, ridge=ridge, result_bonus=rb, home_adv=0.0)


def rate_bethel(games: List[Game], cal) -> Dict[str, float]:
    _, share, floor = cal
    dow = make_dow_result_dominant(cap=5.0, margin_share=share, floor=floor)
    s, _ = bethel_strengths(games, degree_of_win=dow, iterations=400)
    return projected_winning_percentage(s)


def shootout_eps_to_mode(games: List[Game], mode: str) -> List[Game]:
    """Hypothetical shootouts are written with +EPS; widen to a goal for win1."""
    if mode != "win1":
        return games
    out = []
    for g in games:
        hs, as_ = g.home_score, g.away_score
        if hs != int(hs):
            g = Game(g.date, g.home, g.away, int(hs) + 1, as_, g.neutral)
        elif as_ != int(as_):
            g = Game(g.date, g.home, g.away, hs, int(as_) + 1, g.neutral)
        out.append(g)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="/tmp/seed_sim.csv")
    p.add_argument("--model", choices=["margin", "bethel"], default="margin")
    args = p.parse_args()
    bethel = args.model == "bethel"

    pub = {r["team"]: float(r["rating"])
           for r in csv.DictReader(open(D + "ut_girls_rankings_2026-10-04.csv"))}
    five = [r["team"] for r in csv.DictReader(open(D + "ut_girls_rankings_5A_2026-10-04.csv"))]
    so = load_shootouts(D + "ut_girls_soccer_2026_shootouts.csv")
    raw = load_games(D + "ut_girls_soccer_2026.csv")

    rows = []
    for cal in (BETHEL_CALS if bethel else CALS):
        games = apply_shootouts(raw, so, cal[0])
        base = [g for g in games if g.date <= SNAPSHOT_CUTOFF]
        since = [g for g in games if g.date > SNAPSHOT_CUTOFF]
        r0 = None if bethel else rate(base, cal)
        label = ("%s/share%s/floor%s" if bethel else "%s/cap%s/rb%s") % cal[:3]
        friendlies: List[Optional[Tuple[str, str, Tuple]]] = [None] + [
            (o, k, v) for o in OPPONENTS for k, v in FRIENDLY_RESULTS.items()]
        for tname, (vg, og) in TUESDAY.items():
            for fr in friendlies:
                extra = OTHER_OCT6 + [Game("2026-10-06", "Viewmont", "Olympus", vg, og)]
                if fr:
                    extra.append(Game("2026-10-08", "Brighton", fr[0], fr[2][0], fr[2][1], neutral=True))
                played = base + since + shootout_eps_to_mode(extra, cal[0])
                if bethel:
                    r1 = rate_bethel(played, cal)
                    proj = {t: r1[t] for t in five if t in r1}
                else:
                    r1 = rate(played, cal)
                    proj = {t: pub[t] + cal[4] * (r1.get(t, 0) - r0.get(t, 0))
                            for t in five if t in pub}
                order = sorted(proj, key=lambda t: -proj[t])
                pos = {t: i + 1 for i, t in enumerate(order)}
                rows.append({
                    "cal": label, "tuesday": tname,
                    "friendly": "none" if not fr else "%s %s" % (fr[0], fr[1]),
                    "top5": " > ".join(order[:5]),
                    "brighton": round(proj["Brighton"], 4), "olympus": round(proj["Olympus"], 4),
                    "maple_mountain": round(proj["Maple Mountain"], 4),
                    "bountiful": round(proj["Bountiful"], 4),
                    "brighton_seed": pos["Brighton"], "olympus_seed": pos["Olympus"],
                    "goal": pos["Brighton"] in (2, 3) and pos["Olympus"] in (1, 4)
                    and pos["Bountiful"] in (1, 4),
                })
    with open(args.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print("wrote %d scenarios to %s" % (len(rows), args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
