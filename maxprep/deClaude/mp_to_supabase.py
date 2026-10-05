"""
mp_to_supabase.py -- upsert MaxPreps CSVs into the mp_* tables.

Reads the games / teams CSVs from mp_collect.py and an optional snapshot
CSV from mp_snapshot.py (or the dated rankings dump).

Auth: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role bypasses RLS).
Without those, pass --sql-out to write INSERT statements instead.

Before upsert, compares incoming games to the datastore and prints a
diff (added / updated / removed / score changes). Pass --diff-only to
stop after the comparison. A diff that trips validate_diff() (no games,
too many table games missing, too many score changes) is not loaded
unless --force. Every sync appends an mp_ingest_runs row with status
ok / blocked / failed. Daily automation: mp_daily.py.

    python3 mp_to_supabase.py \
        --games ../data/ut_girls_soccer_2026.csv \
        --teams ../data/ut_girls_soccer_2026_teams.csv \
        --snapshots ../data/ut_girls_rankings_2026-09-13.csv

    python3 mp_to_supabase.py --games ... --teams ... --sql-out seed.sql
    python3 mp_to_supabase.py --games ... --teams ... --diff-only

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


def rest_select_all(url: str, key: str, table: str, columns: str) -> List[dict]:
    import requests
    endpoint = url.rstrip("/") + "/rest/v1/" + table
    headers = {
        "apikey": key,
        "Authorization": "Bearer " + key,
    }
    out: List[dict] = []
    start = 0
    page = 1000
    while True:
        headers_range = dict(headers)
        headers_range["Range"] = "%d-%d" % (start, start + page - 1)
        r = requests.get(
            endpoint, headers=headers_range,
            params={"select": columns}, timeout=60)
        if r.status_code >= 300:
            raise SystemExit(
                "GET %s failed %d: %s" % (table, r.status_code, r.text[:500]))
        chunk = r.json()
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < page:
            break
        start += page
    return out


def diff_games(existing: List[dict], incoming: List[dict]) -> dict:
    """Compare datastore games to a fresh scrape payload."""
    before = {g["game_id"]: g for g in existing if g.get("game_id")}
    after = {g["game_id"]: g for g in incoming if g.get("game_id")}
    added = [gid for gid in after if gid not in before]
    removed = [gid for gid in before if gid not in after]
    updated = []
    score_changes = []
    score_keys = ("home_score", "away_score", "is_forfeit", "neutral")
    for gid, neu in after.items():
        old = before.get(gid)
        if not old:
            continue
        changed = False
        was_scored = (old.get("home_score") is not None
                      and old.get("away_score") is not None)
        for k in score_keys:
            if old.get(k) != neu.get(k):
                changed = True
                # Unscored -> scored is a game being played, not a correction.
                if k in ("home_score", "away_score") and was_scored:
                    score_changes.append({
                        "game_id": gid,
                        "before": [old.get("home_score"), old.get("away_score")],
                        "after": [neu.get("home_score"), neu.get("away_score")],
                    })
                    break
        if changed:
            updated.append(gid)
    sample = {
        "added": added[:10],
        "removed": removed[:10],
        "score_changes": score_changes[:10],
    }
    return {
        "games_before": len(before),
        "games_after": len(after),
        "games_added": len(added),
        "games_updated": len(updated),
        "games_removed": len(removed),
        "score_changes": len(score_changes),
        "diff_sample": sample,
    }


# Validation thresholds. A scrape that trips any of these is not loaded.
MAX_REMOVED_ABS = 5
MAX_REMOVED_FRAC = 0.02
MAX_SCORE_CHANGES = 10
DAY_TZ = "America/Denver"


def validate_diff(diff: dict) -> List[str]:
    """Reasons to refuse a scrape; empty list means it looks sane."""
    reasons = []
    if diff["games_after"] == 0:
        reasons.append("scrape returned no games")
    allowed = max(MAX_REMOVED_ABS, int(diff["games_before"] * MAX_REMOVED_FRAC))
    if diff["games_removed"] > allowed:
        reasons.append("%d games in the table are missing from the scrape (limit %d)"
                       % (diff["games_removed"], allowed))
    if diff["score_changes"] > MAX_SCORE_CHANGES:
        reasons.append("%d existing scores changed (limit %d)"
                       % (diff["score_changes"], MAX_SCORE_CHANGES))
    return reasons


def _headers(key: str) -> dict:
    return {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }


def record_ingest_run(url: str, key: str, diff: Optional[dict], source_label: str,
                      status: str = "ok", reason: Optional[str] = None) -> None:
    import datetime
    import requests
    endpoint = url.rstrip("/") + "/rest/v1/mp_ingest_runs"
    headers = dict(_headers(key), Prefer="return=minimal")
    d = diff or {}
    row = {
        "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source_label": source_label,
        "status": status,
        "reason": reason,
        "games_before": d.get("games_before"),
        "games_after": d.get("games_after"),
        "games_added": d.get("games_added", 0),
        "games_updated": d.get("games_updated", 0),
        "games_removed": d.get("games_removed", 0),
        "score_changes": d.get("score_changes", 0),
        "diff_sample": d.get("diff_sample"),
        "notes": "mp_to_supabase sync",
    }
    r = requests.post(endpoint, headers=headers, data=json.dumps(row), timeout=60)
    if r.status_code >= 300:
        sys.stderr.write(
            "warn: could not write mp_ingest_runs (%d): %s\n"
            % (r.status_code, r.text[:300]))


def ran_today(url: str, key: str) -> Optional[dict]:
    """Latest ok/blocked run since local midnight (DAY_TZ), else None.

    Failed runs do not count, so a transient error is retried next slot.
    """
    import datetime
    from zoneinfo import ZoneInfo
    import requests
    tz = ZoneInfo(DAY_TZ)
    midnight = datetime.datetime.now(tz).replace(
        hour=0, minute=0, second=0, microsecond=0)
    r = requests.get(
        url.rstrip("/") + "/rest/v1/mp_ingest_runs",
        headers=_headers(key),
        params={
            "select": "started_at,status,reason",
            "status": "in.(ok,blocked)",
            "started_at": "gte." + midnight.isoformat(),
            "order": "started_at.desc",
            "limit": "1",
        },
        timeout=60)
    if r.status_code >= 300:
        raise SystemExit("GET mp_ingest_runs failed %d: %s"
                         % (r.status_code, r.text[:300]))
    rows = r.json()
    return rows[0] if rows else None


def load_payloads(games_csv: str, teams_csv: str, snapshots_csv: str = ""
                  ) -> Tuple[List[dict], List[dict], List[dict]]:
    teams = teams_payload(_read(teams_csv))
    games = games_payload(_read(games_csv))
    # drop games whose team ids are not in the teams table
    known = {t["team_id"] for t in teams}
    games = [g for g in games
             if g["home_team_id"] in known and g["away_team_id"] in known]
    snaps: List[dict] = []
    if snapshots_csv:
        snaps, unmatched = snapshots_payload(_read(snapshots_csv), teams)
        if unmatched:
            sys.stderr.write("snapshot names with no team_id (%d): %s\n"
                             % (len(unmatched), ", ".join(unmatched[:20])))
    sys.stderr.write("payload: %d teams, %d games, %d snapshots\n"
                     % (len(teams), len(games), len(snaps)))
    return teams, games, snaps


def sync(url: str, key: str, teams: List[dict], games: List[dict],
         snaps: List[dict], source_label: str = "csv", force: bool = False,
         diff_only: bool = False) -> Tuple[str, Optional[dict], List[str]]:
    """Diff, validate, upsert, record. Returns (status, diff, reasons).

    status is ok / blocked / failed, or "diff" when diff_only.
    """
    try:
        existing = rest_select_all(
            url, key, "mp_games",
            "game_id,home_score,away_score,neutral,is_forfeit")
        diff = diff_games(existing, games)
        sys.stderr.write(
            "diff: before=%d after=%d added=%d updated=%d removed=%d score_changes=%d\n"
            % (diff["games_before"], diff["games_after"], diff["games_added"],
               diff["games_updated"], diff["games_removed"], diff["score_changes"]))
        if diff["diff_sample"]["score_changes"]:
            sys.stderr.write("  score change sample: %s\n"
                             % json.dumps(diff["diff_sample"]["score_changes"][:3]))
        reasons = validate_diff(diff)
        for why in reasons:
            sys.stderr.write("  validation: %s\n" % why)
        if diff_only:
            return "diff", diff, reasons
        if reasons and not force:
            record_ingest_run(url, key, diff, source_label, "blocked",
                              "; ".join(reasons))
            return "blocked", diff, reasons

        rest_upsert(url, key, "mp_teams", teams, "team_id")
        rest_upsert(url, key, "mp_games", games, "game_id")
        if snaps:
            # REST upsert needs a unique key; snapshots use (taken_on,state,sport,team_name)
            rest_upsert(url, key, "mp_snapshots", snaps,
                        "taken_on,state,sport,team_name")
        note = ("forced past: " + "; ".join(reasons)) if reasons else None
        record_ingest_run(url, key, diff, source_label, "ok", note)
        sys.stderr.write("upsert complete\n")
        return "ok", diff, reasons
    except SystemExit as e:
        record_ingest_run(url, key, None, source_label, "failed", str(e)[:500])
        return "failed", None, [str(e)]


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--games", required=True)
    p.add_argument("--teams", required=True)
    p.add_argument("--snapshots", default="")
    p.add_argument("--sql-out", default="")
    p.add_argument("--diff-only", action="store_true",
                   help="Compare CSV to datastore; do not upsert")
    p.add_argument("--force", action="store_true",
                   help="Load even if validation flags the scrape")
    p.add_argument("--source-label", default="csv")
    p.add_argument("--supabase-url",
                   default=os.environ.get("SUPABASE_URL", ""))
    p.add_argument("--service-key",
                   default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    args = p.parse_args()

    teams, games, snaps = load_payloads(args.games, args.teams, args.snapshots)

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

    status, diff, reasons = sync(
        args.supabase_url, args.service_key, teams, games, snaps,
        args.source_label, args.force, args.diff_only)
    if status == "diff":
        print(json.dumps(dict(diff, validation=reasons), indent=2))
        return 0
    if status == "blocked":
        sys.stderr.write("blocked: not loaded (pass --force to override)\n")
        return 3
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
