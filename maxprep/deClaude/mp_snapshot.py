"""
mp_snapshot.py -- capture the published MaxPreps rank order, dated.

This is the piece that makes the whole project work. Without dated
snapshots of what MaxPreps actually published, you have models but no
target to fit them to, and you cannot recover old snapshots later: the
site shows only current values and the entire list re-ranks every run.

Ten minutes a week, starting now, is the whole cost.

THREE WAYS IN, easiest first.

1. PASTE (no dependencies, always works)
   Open the rankings page, select the table, copy, paste into a text
   file, run:

       python3 mp_snapshot.py paste --in pasted.txt --date 2026-09-14 \
           --sport girls-soccer --state ut --out snapshots.csv

   Handles the common shapes: "1 Crimson Cliffs 11-0 ...", tab-separated,
   and the UHSAA table layout. It prints what it parsed so you can check
   it before trusting it.

2. JSON ENDPOINT (best, if you can find it -- five minutes once)
   The MaxPreps rankings page and the UHSAA rankings page both render
   their tables client-side, which means a JSON call is behind them.
   To find it: open the rankings page, F12 -> Network -> filter XHR ->
   reload -> look for the request that returns the team list. Right
   click -> Copy -> Copy URL. Then:

       python3 mp_snapshot.py json --url '<that url>' \
           --date 2026-09-14 --out snapshots.csv

   The parser walks arbitrary nested JSON looking for objects that carry
   a team name plus a rank or rating, so it usually works without you
   having to know the schema.

3. HEADLESS BROWSER (most robust, needs install)
   pip install playwright && playwright install chromium
   then see render_with_playwright() at the bottom.

OUTPUT is one long CSV you append to all season:

    snapshot_date, state, sport, classification, rank, team, rating, record

Feed it to mp_rating.calibrate() as the target. Rank order is enough --
Spearman and Kendall tau only care about ordering, so do not worry if
the rating column comes back empty.

ASCII only. Python 3.9+.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from typing import Any, Dict, Iterable, List, Optional

COLS = ["snapshot_date", "state", "sport", "classification", "rank",
        "team", "rating", "record"]

# "12  Maple Mountain  9-2-1  53.4"   /  "12 Maple Mountain (Spanish Fork, UT) 9-2-1"
LINE = re.compile(
    r"^\s*(?P<rank>\d{1,3})[.)]?\s+"
    r"(?P<team>[A-Za-z][^\t]*?)"
    r"(?:\s*\([^)]*\))?"
    r"(?:\s+(?P<record>\d{1,3}-\d{1,3}(?:-\d{1,3})?))?"
    r"(?:\s+(?P<rating>-?\d+\.\d+))?"
    r"\s*$"
)


def parse_pasted(text: str) -> List[dict]:
    """
    Parse a pasted rankings table. Tab-separated lines are handled first
    (that is what you usually get copying an HTML table), then the
    whitespace-separated shape.
    """
    rows: List[dict] = []
    current_class = ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue

        # a bare classification header like "5A" or "Class 5A"
        m = re.match(r"^\s*(?:Class\s+)?([1-6]A)\s*$", line, re.I)
        if m:
            current_class = m.group(1).upper()
            continue

        if "\t" in line:
            parts = [p.strip() for p in line.split("\t") if p.strip()]
            if len(parts) >= 2 and re.match(r"^\d{1,3}$", parts[0]):
                rating = ""
                record = ""
                for p in parts[2:]:
                    if re.match(r"^\d{1,3}-\d{1,3}(-\d{1,3})?$", p):
                        record = p
                    elif re.match(r"^-?\d+\.\d+$", p):
                        rating = p
                rows.append({"rank": int(parts[0]), "team": parts[1],
                             "rating": rating, "record": record,
                             "classification": current_class})
                continue

        m = LINE.match(line)
        if m:
            team = re.sub(r"\s+", " ", m.group("team")).strip(" .-")
            if not team or team.lower() in ("rank", "school", "team"):
                continue
            rows.append({"rank": int(m.group("rank")), "team": team,
                         "rating": m.group("rating") or "",
                         "record": m.group("record") or "",
                         "classification": current_class})
    return rows


# ----------------------------------------------------------------------
# JSON walking
# ----------------------------------------------------------------------

NAME_KEYS = ("name", "schoolname", "teamname", "school", "team", "displayname")
RANK_KEYS = ("rank", "ranking", "position", "seed", "overallrank", "staterank")
RATE_KEYS = ("rating", "score", "power", "rpi", "value", "powerrating")
REC_KEYS = ("record", "overallrecord", "wlt", "wl")


def _pick(d: Dict[str, Any], keys: Iterable[str]) -> Optional[Any]:
    lowered = {str(k).lower().replace("_", "").replace(" ", ""): v for k, v in d.items()}
    for k in keys:
        if k in lowered and lowered[k] not in (None, ""):
            return lowered[k]
    return None


def parse_json_blob(blob: Any) -> List[dict]:
    """Walk arbitrary nested JSON and pull out anything team-shaped."""
    found: List[dict] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            name = _pick(node, NAME_KEYS)
            rank = _pick(node, RANK_KEYS)
            rating = _pick(node, RATE_KEYS)
            if isinstance(name, dict):
                name = _pick(name, NAME_KEYS)
            if isinstance(name, str) and (rank is not None or rating is not None):
                found.append({
                    "rank": int(rank) if isinstance(rank, (int, float)) or
                            (isinstance(rank, str) and rank.isdigit()) else "",
                    "team": name.strip(),
                    "rating": rating if rating is not None else "",
                    "record": _pick(node, REC_KEYS) or "",
                    "classification": "",
                })
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(blob)
    # de-duplicate by team, keeping the first (usually the outermost list)
    seen = set()
    out = []
    for r in found:
        if r["team"] in seen:
            continue
        seen.add(r["team"])
        out.append(r)
    return out


def fetch_json(url: str, headers: Optional[Dict[str, str]] = None) -> Any:
    import requests
    h = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    h.update(headers or {})
    r = requests.get(url, headers=h, timeout=30)
    r.raise_for_status()
    return r.json()


# ----------------------------------------------------------------------
# Writing
# ----------------------------------------------------------------------

def append_snapshot(rows: List[dict], path: str, date: str,
                    state: str, sport: str, default_class: str = "") -> int:
    exists = os.path.exists(path)
    n = 0
    with open(path, "a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        if not exists:
            w.writeheader()
        for r in rows:
            if not r.get("team"):
                continue
            w.writerow({
                "snapshot_date": date,
                "state": state,
                "sport": sport,
                "classification": r.get("classification") or default_class,
                "rank": r.get("rank", ""),
                "team": r["team"],
                "rating": r.get("rating", ""),
                "record": r.get("record", ""),
            })
            n += 1
    return n


def load_snapshot(path: str, date: Optional[str] = None,
                  classification: Optional[str] = None) -> Dict[str, float]:
    """
    Read one snapshot back as the `published` argument for
    mp_rating.calibrate(). Uses rating when present, otherwise negated
    rank, which preserves the ordering.
    """
    best_date = date
    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            rows.append(r)
    if best_date is None:
        best_date = max(r["snapshot_date"] for r in rows)
    out: Dict[str, float] = {}
    for r in rows:
        if r["snapshot_date"] != best_date:
            continue
        if classification and r["classification"] != classification:
            continue
        try:
            out[r["team"]] = float(r["rating"])
        except (TypeError, ValueError):
            try:
                out[r["team"]] = -float(r["rank"])
            except (TypeError, ValueError):
                continue
    return out


# ----------------------------------------------------------------------
# Playwright fallback
# ----------------------------------------------------------------------

def render_with_playwright(url: str, wait_selector: str = "table") -> str:
    """
    Return the fully rendered HTML of a client-side page. Pipe the
    result through parse_pasted() after stripping tags, or just use
    pandas.read_html on it.

        pip install playwright && playwright install chromium
    """
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto(url, wait_until="networkidle", timeout=60000)
        try:
            page.wait_for_selector(wait_selector, timeout=15000)
        except Exception:
            pass
        html = page.content()
        browser.close()
    return html


# ----------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--date", default=dt.date.today().isoformat())
    common.add_argument("--state", default="ut")
    common.add_argument("--sport", default="girls-soccer")
    common.add_argument("--classification", default="")
    common.add_argument("--out", default="snapshots.csv")

    a = sub.add_parser("paste", parents=[common])
    a.add_argument("--in", dest="infile", required=True)

    b = sub.add_parser("json", parents=[common])
    b.add_argument("--url", required=True)

    c = sub.add_parser("render", parents=[common])
    c.add_argument("--url", required=True)
    c.add_argument("--save-html", default="rendered.html")

    args = p.parse_args()

    if args.cmd == "paste":
        with open(args.infile, encoding="utf-8") as fh:
            rows = parse_pasted(fh.read())
    elif args.cmd == "json":
        rows = parse_json_blob(fetch_json(args.url))
    else:
        html = render_with_playwright(args.url)
        with open(args.save_html, "w", encoding="utf-8") as fh:
            fh.write(html)
        text = re.sub(r"<[^>]+>", "\t", html)
        text = re.sub(r"\t{2,}", "\t", text)
        rows = parse_pasted(text)

    print("parsed %d rows. first five:" % len(rows))
    for r in rows[:5]:
        print("  ", r)
    if not rows:
        print("nothing parsed -- check the input, or use the render subcommand")
        return 1

    n = append_snapshot(rows, args.out, args.date, args.state,
                        args.sport, args.classification)
    print("appended %d rows to %s for %s" % (n, args.out, args.date))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
