"""
mp_to_supabase.py -- upsert MaxPreps CSVs into the mp_* tables.

Reads the games / teams CSVs from mp_collect.py and an optional snapshot
CSV from mp_snapshot.py (or the dated rankings dump).

Auth: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role bypasses RLS).
Without those, pass --sql-out to write INSERT statements instead.

    python3 mp_to_supabase.py \
        --games ../data/ut_girls_soccer_2026.csv \
        --teams ../data/ut_girls_soccer_2026_teams.csv \
        --snapshots ../data/ut_girls_rankings_2026-09-13.csv

    python3 mp_to_supabase.py --games ... --teams ... --sql-out seed.sql

ASCII only. Python 3.9+. Requires requests if talking to the API.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from typing import Dict, Iterable, List, Optional, Tuple

# Scoreboard short names -> snapshot / UHSAA long names
NAME_ALIASES = {
    "umahf": "Utah Military Academy - Hill Field",
    "umacw": "Utah Military Academy - Camp Williams",
    "utah military academy - hill field": "Utah Military Academy - Hill Field",
    "utah military academy - camp williams": "Utah Military Academy - Camp Williams",
}


def _norm(name: str) -> str:
    s = (name or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return NAME_ALIASES.get(s, s)


def _read(path: str) -> List[dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _empty(v: object) -> bool:
    return v is None or str(v).strip() in ("", "None")


def _int(v: object) -> Optional[int]:
    if _empty(v):
        return None
    try:
        return int(str(v).strip())
    except ValueError:
        return None


def _num(v: object) -> Optional[float]:
    if _empty(v):
        return None
    try:
        return float(str(v).strip())
    except ValueError:
        return None


def _bool01(v: object) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "t")


def teams_payload(rows: List[dict]) -> List[dict]:
    out = []
    for r in rows:
        tid = (r.get("team_id") or "").strip()
        name = (r.get("display_name") or "").strip()
        if not tid or not name:
            continue
        out.append({
            "team_id": tid,
            "display_name": name,
            "state": (r.get("state") or "UT").strip().upper(),
            "classification": (r.get("classification") or "").strip() or None,
            "region": (r.get("region") or "").strip() or None,
            "maxpreps_slug": (r.get("maxpreps_slug") or "").strip() or None,
            "is_our_team": _bool01(r.get("is_our_team")),
        })
    return out


def games_payload(rows: List[dict]) -> List[dict]:
    out = []
    for r in rows:
        gid = (r.get("contest_id") or "").strip()
        if not gid:
            gid = "%s:%s:%s" % (r.get("date"), r.get("home_team_id"),
                                r.get("away_team_id"))
        home_id = (r.get("home_team_id") or "").strip()
        away_id = (r.get("away_team_id") or "").strip()
        if not home_id or not away_id or not r.get("date"):
            continue
        out.append({
            "game_id": gid,
            "played_on": r["date"],
            "home_team_id": home_id,
            "away_team_id": away_id,
            "home_score": _int(r.get("home_score")),
            "away_score": _int(r.get("away_score")),
            "home_rank": _int(r.get("home_rank")),
            "away_rank": _int(r.get("away_rank")),
            "neutral": _bool01(r.get("neutral")),
            "is_forfeit": _bool01(r.get("is_forfeit")),
            "source_url": (r.get("match_url") or "").strip() or None,
        })
    return out


def snapshots_payload(rows: List[dict],
                      teams: List[dict]) -> Tuple[List[dict], List[str]]:
    by_name: Dict[str, str] = {}
    for t in teams:
        by_name[_norm(t["display_name"])] = t["team_id"]
        if t.get("is_our_team"):
            by_name["brighton"] = t["team_id"]
    unmatched: List[str] = []
    out = []
    for r in rows:
        name = (r.get("team") or r.get("team_name") or "").strip()
        if not name:
            continue
        tid = by_name.get(_norm(name))
        if not tid:
            unmatched.append(name)
        taken = (r.get("snapshot_date") or r.get("taken_on") or "").strip()
        out.append({
            "taken_on": taken,
            "state": (r.get("state") or "UT").strip().upper(),
            "sport": (r.get("sport") or "girls-soccer").strip(),
            "classification": (r.get("classification") or "").strip() or None,
            "rank": _int(r.get("rank")),
            "team_id": tid,
            "team_name": name,
            "rating": _num(r.get("rating")),
            "strength": _num(r.get("strength") or r.get("str")),
            "record": (r.get("record") or "").strip() or None,
        })
    return out, unmatched


def _sql_lit(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    s = str(v).replace("'", "''")
    return "'" + s + "'"


def _sql_cols(rows: List[dict], table: str, conflict: str,
              update_cols: List[str]) -> str:
    if not rows:
        return "-- no rows for %s\n" % table
    cols = list(rows[0].keys())
    lines = ["insert into public.%s (%s) values" % (table, ", ".join(cols))]
    chunks = []
    for r in rows:
        chunks.append("  (" + ", ".join(_sql_lit(r[c]) for c in cols) + ")")
    lines.append(",\n".join(chunks))
    updates = ", ".join("%s = excluded.%s" % (c, c) for c in update_cols)
    lines.append("on conflict (%s) do update set %s;" % (conflict, updates))
    return "\n".join(lines) + "\n"


def render_sql(teams: List[dict], games: List[dict],
               snaps: List[dict]) -> str:
    parts = ["begin;", ""]
    team_sql = _sql_cols(
        teams, "mp_teams", "team_id",
        ["display_name", "state", "classification", "region",
         "maxpreps_slug", "is_our_team"])
    team_sql = team_sql.replace(
        "is_our_team = excluded.is_our_team;",
        "is_our_team = excluded.is_our_team, updated_at = now();")
    parts.append(team_sql)
    parts.append(_sql_cols(
        games, "mp_games", "game_id",
        ["played_on", "home_team_id", "away_team_id", "home_score",
         "away_score", "home_rank", "away_rank", "neutral", "is_forfeit",
         "source_url"]))
    if snaps:
        parts.append(
            "delete from public.mp_snapshots where taken_on in (%s);"
            % ", ".join(sorted({_sql_lit(s["taken_on"]) for s in snaps})))
        cols = list(snaps[0].keys())
        lines = ["insert into public.mp_snapshots (%s) values" % ", ".join(cols)]
        chunks = []
        for r in snaps:
            chunks.append("  (" + ", ".join(_sql_lit(r[c]) for c in cols) + ")")
        lines.append(",\n".join(chunks) + ";")
        parts.append("\n".join(lines) + "\n")
    parts.append("commit;")
    return "\n".join(parts) + "\n"


def rest_upsert(url: str, key: str, table: str, rows: List[dict],
                on_conflict: str) -> None:
    import requests
    if not rows:
        return
    endpoint = url.rstrip("/") + "/rest/v1/" + table
    headers = {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    batch = 80
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        r = requests.post(
            endpoint, headers=headers, params={"on_conflict": on_conflict},
            data=json.dumps(chunk), timeout=60)
        if r.status_code >= 300:
            raise SystemExit(
                "POST %s failed %d: %s" % (table, r.status_code, r.text[:500]))
        sys.stderr.write("  %s %d-%d ok\n" % (table, i + 1, i + len(chunk)))


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--games", required=True)
    p.add_argument("--teams", required=True)
    p.add_argument("--snapshots", default="")
    p.add_argument("--sql-out", default="")
    p.add_argument("--supabase-url",
                   default=os.environ.get("SUPABASE_URL", ""))
    p.add_argument("--service-key",
                   default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    args = p.parse_args()

    teams = teams_payload(_read(args.teams))
    games = games_payload(_read(args.games))
    # drop games whose team ids are not in the teams table
    known = {t["team_id"] for t in teams}
    games = [g for g in games
             if g["home_team_id"] in known and g["away_team_id"] in known]
    snaps: List[dict] = []
    unmatched: List[str] = []
    if args.snapshots:
        snaps, unmatched = snapshots_payload(_read(args.snapshots), teams)

    sys.stderr.write("payload: %d teams, %d games, %d snapshots\n"
                     % (len(teams), len(games), len(snaps)))
    if unmatched:
        sys.stderr.write("snapshot names with no team_id (%d): %s\n"
                         % (len(unmatched), ", ".join(unmatched[:20])))

    if args.sql_out:
        sql = render_sql(teams, games, snaps)
        with open(args.sql_out, "w", encoding="utf-8") as fh:
            fh.write(sql)
        sys.stderr.write("wrote %s (%d bytes)\n" % (args.sql_out, len(sql)))
        return 0

    if not args.supabase_url or not args.service_key:
        sys.stderr.write(
            "no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; "
            "pass --sql-out or set env vars\n")
        return 2

    rest_upsert(args.supabase_url, args.service_key, "mp_teams", teams, "team_id")
    rest_upsert(args.supabase_url, args.service_key, "mp_games", games, "game_id")
    if snaps:
        # REST upsert needs a unique key; snapshots use (taken_on,state,sport,team_name)
        rest_upsert(args.supabase_url, args.service_key, "mp_snapshots", snaps,
                    "taken_on,state,sport,team_name")
    sys.stderr.write("upsert complete\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
