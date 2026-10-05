"""
mp_daily.py -- scrape MaxPreps once a day and load DEV + PROD mp_* tables.

For each target that has no ok/blocked mp_ingest_runs row since local
midnight (America/Denver), runs one season scrape (mp_collect.py) and syncs
it through mp_to_supabase.sync(), which diffs against the table, refuses
scrapes that look broken, and records the run.

Targets come from env; any target missing its URL or key is skipped:

    SUPABASE_URL_DEV,  SUPABASE_SERVICE_ROLE_KEY_DEV
    SUPABASE_URL_PROD, SUPABASE_SERVICE_ROLE_KEY_PROD

    python3 mp_daily.py                # skip targets already done today
    python3 mp_daily.py --force        # scrape + load even if done / flagged
    python3 mp_daily.py --diff-only    # scrape + diff + validate, no writes
    python3 mp_daily.py --games g.csv --teams t.csv   # reuse a scrape

Exit 0 when every target is ok (or already done), 1 if any blocked/failed.

ASCII only. Python 3.9+. Requires requests and beautifulsoup4.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from typing import List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mp_to_supabase as mts  # noqa: E402

TARGET_NAMES = ("DEV", "PROD")


def targets_from_env() -> List[Tuple[str, str, str]]:
    out = []
    for name in TARGET_NAMES:
        url = os.environ.get("SUPABASE_URL_" + name, "").strip()
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY_" + name, "").strip()
        if url and key:
            out.append((name, url, key))
        else:
            sys.stderr.write("%s: no URL/service key in env, skipping\n" % name)
    return out


def scrape(workdir: str) -> Tuple[str, str]:
    games = os.path.join(workdir, "ut_girls_soccer.csv")
    teams = os.path.join(workdir, "ut_girls_soccer_teams.csv")
    cmd = [sys.executable, os.path.join(HERE, "mp_collect.py"), "--season",
           "--out", games, "--teams-out", teams]
    sys.stderr.write("scrape: %s\n" % " ".join(cmd))
    subprocess.run(cmd, check=True)
    return games, teams


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--force", action="store_true",
                   help="ignore today's runs and validation flags")
    p.add_argument("--diff-only", action="store_true",
                   help="scrape and validate; write nothing")
    p.add_argument("--games", default="", help="existing games CSV (skip scrape)")
    p.add_argument("--teams", default="", help="existing teams CSV (skip scrape)")
    p.add_argument("--workdir", default="",
                   help="where scrape CSVs go (default: a temp dir)")
    p.add_argument("--source-label", default="daily-scrape")
    args = p.parse_args()

    targets = targets_from_env()
    if not targets:
        sys.stderr.write("no targets configured\n")
        return 1

    pending = []
    for name, url, key in targets:
        done = None if (args.force or args.diff_only) else mts.ran_today(url, key)
        if done:
            sys.stderr.write("%s: already ran today (%s at %s), skipping\n"
                             % (name, done["status"], done["started_at"]))
        else:
            pending.append((name, url, key))
    if not pending:
        sys.stderr.write("nothing to do\n")
        return 0

    if args.games and args.teams:
        games_csv, teams_csv = args.games, args.teams
    else:
        workdir = args.workdir or tempfile.mkdtemp(prefix="mp_daily_")
        os.makedirs(workdir, exist_ok=True)
        try:
            games_csv, teams_csv = scrape(workdir)
        except subprocess.CalledProcessError as e:
            why = "scrape failed: exit %d" % e.returncode
            sys.stderr.write(why + "\n")
            if not args.diff_only:
                for name, url, key in pending:
                    mts.record_ingest_run(url, key, None, args.source_label,
                                          "failed", why)
            return 1

    teams, games, snaps = mts.load_payloads(games_csv, teams_csv)
    results = []
    for name, url, key in pending:
        sys.stderr.write("--- %s\n" % name)
        status, _diff, reasons = mts.sync(
            url, key, teams, games, snaps, args.source_label,
            force=args.force, diff_only=args.diff_only)
        results.append((name, status, reasons))

    bad = False
    for name, status, reasons in results:
        line = "%s: %s" % (name, status)
        if reasons:
            line += " (" + "; ".join(reasons) + ")"
        print(line)
        if status in ("blocked", "failed"):
            bad = True
        if status == "diff" and reasons:
            bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
