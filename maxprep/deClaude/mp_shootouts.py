"""
mp_shootouts.py -- Utah varsity soccer has no draws.

Level after regulation goes to overtime and then penalty kicks. MaxPreps
keeps the 1-1 score but credits the W/L, and its records show no ties.
The scoreboard never says which side won the shootout; team schedule
pages do (team array index 5 is "W"/"L"). mp_collect writes those
contests as plain draws, so apply the winners from
ut_girls_soccer_2026_shootouts.csv before rating.

modes:
  draw  -- leave as a draw (what the raw scrape does)
  win0  -- shootout winner takes the result, goal margin stays ~0
  win1  -- shootout winner credited with a one-goal win
"""

from __future__ import annotations

import csv
from dataclasses import replace
from typing import Dict, List, Sequence, Tuple

from mp_rating import Game

EPS = 0.001


def load_shootouts(path: str) -> Dict[Tuple[str, frozenset], str]:
    out = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            out[(r["date"], frozenset((r["team_a"], r["team_b"])))] = r["winner"]
    return out


def shootout_game(g: Game, winner: str, mode: str) -> Game:
    if mode == "draw":
        return g
    bump = EPS if mode == "win0" else 1
    if winner == g.home:
        return replace(g, home_score=g.home_score + bump)
    if winner == g.away:
        return replace(g, away_score=g.away_score + bump)
    return g


def apply_shootouts(games: Sequence[Game], shootouts: Dict[Tuple[str, frozenset], str],
                    mode: str = "win0") -> List[Game]:
    out = []
    for g in games:
        w = shootouts.get((g.date, frozenset((g.home, g.away)))) if g.home_score == g.away_score else None
        out.append(shootout_game(g, w, mode) if w else g)
    return out
