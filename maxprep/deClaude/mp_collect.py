"""
mp_collect.py -- build the games table the rating models need.

Source: the MaxPreps date-indexed scoreboard pages, which are server-rendered
(unlike the rankings pages, which are client-rendered and return an empty
table to a plain HTTP GET).

    https://www.maxpreps.com/{state}/soccer/girls/scores/?date=M/D/YYYY

Each contest box lists away first, then home:

    <away score> <optional (#rank)> <away name>
    <home score> <optional (#rank)> <home name>
    Final

Verified against the page's own prose, e.g. 8/3/2026
"Hurricane (UT) @ #8 Maple Mountain" -> 0 Hurricane @ 6 Maple Mountain,
and 9/9/2026 "Bear River @ Deseret Peak" -> 5 Bear River @ 1 Deseret Peak.

Rows against "Non Varsity Opponent" are dropped -- UHSAA instructs coaches
to enter those as non-varsity, and they are not part of the rating graph.
The national-25 rail at the bottom of the page is ignored.

The scoreboard calendar exposes data-contest-count per day and marks
Sundays. A season pull uses that calendar so empty weekdays and Sundays
are not requested. Contests MaxPreps flags deleted (Brighton 8 @ Cyprus
0 on 2026-08-13) never appear on the day board; --season also reads
team schedule pages so those scores are not dropped.

Usage:
    # Utah girls 2026, Aug 3 through today, skip Sundays/empty days,
    # plus class + region for every UHSAA team:
    python3 mp_collect.py --season --out ../data/ut_girls_soccer_2026.csv

    python3 mp_collect.py --states ut --start 2026-08-03 --end 2026-09-12 \
        --out ../data/ut_girls_soccer_2026.csv

    python3 mp_collect.py --self-test

    # fill holes the day board dropped (deleted-but-scored contests):
    python3 mp_collect.py --schedules-only --out ../data/ut_girls_soccer_2026.csv

    # wider graph, which is what MaxPreps actually rates against:
    python3 mp_collect.py --states ut id nv az co nm wy --start 2026-08-03 \
        --end 2026-09-12 --out games_region.csv

Notes and cautions:
  - Selectors are best-effort. Run with --dump-html once and eyeball a page
    before trusting a full season pull. MaxPreps changes markup.
  - Be polite: default 1.5s delay between requests.
  - Check the site terms before running this at volume.

ASCII only. Python 3.9+. Requires requests and beautifulsoup4.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
from typing import Dict, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup, Tag

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"

BASE = "https://www.maxpreps.com/{state}/soccer/{gender}/scores/?date={m}/{d}/{y}"
CLASS_ASPX = (
    "https://www.maxpreps.com/list/schedules_scores.aspx"
    "?gendersport={gender},soccer"
    "&teamlevel=59a4c93d-374c-42ea-9b7f-87e1e51f1336"
    "&state={state}&statedivisionid={did}{date_q}"
)
REGION_SCORES = (
    "https://www.maxpreps.com/{state}/soccer/{gender}/26-27/region/"
    "{slug}/scores/?leagueid={lid}{date_q}"
)

SEASON_OPENER = dt.date(2026, 8, 3)  # first UT girls game this year
OUR_TEAM_NAMES = {"brighton"}
OUR_TEAM_SCHEDULE = (
    "https://www.maxpreps.com/ut/salt-lake-city/brighton-bengals"
    "/soccer/girls/schedule/"
)
NEXT_DATA_RE = re.compile(
    r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
TEAM_URL_RE = re.compile(
    r"maxpreps\.com/([a-z]{2})/[^/]+/([^/]+)/soccer/", re.I)

RANK_RE = re.compile(r"\(#(\d+)\)")
# Fallback if MaxPreps drops the contest-box markup.
PAIR = re.compile(
    r"(?<!\d)(\d{1,2})\s*(?:\(#\d+\)\s*)?([A-Za-z][^0-9]*?)"
    r"(?=\s+\d{1,2}\s|\s+Final\b|$)"
)
RECORD_PAIR = re.compile(
    r"(\d{1,2}-\d{1,2}(?:-\d{1,2})?)\s*(?:\(#\d+\)\s*)?"
    r"([A-Za-z][^0-9]*?)(?=\s*\d|\s*$)"
)
SLUG_PAIR = re.compile(r"/match/([a-z0-9\-]+?)-vs-([a-z0-9\-]+?)/")
DATE_IN_HREF = re.compile(r"date=(\d+)/(\d+)/(\d+)")

SKIP_NAMES = ("non varsity opponent", "non-varsity opponent")

GAME_COLS = [
    "date", "state", "home_team", "away_team", "home_score", "away_score",
    "neutral", "is_forfeit", "name_source", "match_url", "contest_id",
    "home_team_id", "away_team_id", "home_rank", "away_rank",
]
TEAM_COLS = [
    "team_id", "display_name", "state", "classification", "region",
    "maxpreps_slug", "is_our_team",
]


def daterange(start: dt.date, end: dt.date) -> Iterator[dt.date]:
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def clean(name: str) -> str:
    name = RANK_RE.sub("", name or "")
    return re.sub(r"\s+", " ", name).strip(" .+*-")


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def href_in_state(href: str, state: str) -> bool:
    h = (href or "").lower()
    st = state.lower()
    return (
        h.startswith("https://www.maxpreps.com/" + st + "/")
        or h.startswith("/" + st + "/")
        or ("/" + st + "/soccer/") in h
    )


def fetch(session: requests.Session, url: str, retries: int = 3) -> Optional[str]:
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=30, allow_redirects=True)
            if r.status_code == 200:
                return r.text
            if r.status_code in (429, 503):
                time.sleep(5 * (attempt + 1))
                continue
            sys.stderr.write("HTTP %d for %s\n" % (r.status_code, url))
            return None
        except requests.RequestException as exc:
            sys.stderr.write("error %s for %s\n" % (exc, url))
            time.sleep(3 * (attempt + 1))
    return None


def _name_and_rank(node: Optional[Tag]) -> Tuple[str, Optional[int]]:
    if node is None:
        return "", None
    rank = None
    rank_el = node.find("span", class_="rank")
    if rank_el:
        m = RANK_RE.search(rank_el.get_text())
        if m:
            rank = int(m.group(1))
    return clean(node.get_text(" ", strip=True)), rank


def _int_or_none(text: Optional[str]) -> Optional[int]:
    if text is None:
        return None
    t = str(text).strip()
    return int(t) if t.isdigit() else None


def parse_calendar(html: str) -> Dict[dt.date, int]:
    """date -> contest count, from the scoreboard month grid."""
    soup = BeautifulSoup(html, "html.parser")
    out: Dict[dt.date, int] = {}
    for a in soup.select("a[data-contest-count]"):
        href = a.get("href") or ""
        m = DATE_IN_HREF.search(href)
        if not m:
            continue
        d = dt.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        try:
            out[d] = int(a["data-contest-count"])
        except (TypeError, ValueError):
            continue
    return out


def parse_filters(html: str) -> Tuple[List[Tuple[str, str]], List[Tuple[str, str]]]:
    """Return (class_id, '5A') pairs and (league_id, '5A Region 6') pairs."""
    soup = BeautifulSoup(html, "html.parser")
    classes: List[Tuple[str, str]] = []
    regions: List[Tuple[str, str]] = []
    div = soup.find("select", id="division_filter")
    if div:
        for opt in div.find_all("option"):
            val = (opt.get("value") or "").strip()
            label = opt.get_text(" ", strip=True)
            m = re.search(r"([1-6]A)", label, re.I)
            if val and m:
                classes.append((val, m.group(1).upper()))
    league = soup.find("select", id="league_filter")
    if league:
        for opt in league.find_all("option"):
            val = (opt.get("value") or "").strip()
            label = opt.get_text(" ", strip=True)
            if val and re.search(r"[1-6]A\s+Region", label, re.I):
                regions.append((val, label))
    return classes, regions


def parse_team_dropdown(html: str) -> List[Tuple[str, str]]:
    """(school_id, display_name) from the Team filter on a scores page."""
    soup = BeautifulSoup(html, "html.parser")
    sel = soup.find("select", id="q_n_teams")
    if not sel:
        return []
    out = []
    for opt in sel.find_all("option"):
        val = (opt.get("value") or "").strip()
        name = clean(opt.get_text(" ", strip=True))
        if val and name and name.lower() != "select":
            out.append((val, name))
    return out


def _parse_contest_boxes(html: str, date: dt.date, state: str) -> List[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out: List[dict] = []
    seen = set()
    # Utah (or `state`) contests use data-contest-id. The national rail uses
    # data-contest-id-x and is skipped.
    for li in soup.select("li.c[data-contest-id]"):
        contest_id = (li.get("data-contest-id") or "").strip()
        if not contest_id or contest_id in seen:
            continue
        box = li.find("div", class_="contest-box-item")
        if not isinstance(box, Tag):
            continue
        if box.get("data-contest-state") == "placeholder":
            continue
        a = box.find("a", href=True)
        if not isinstance(a, Tag):
            continue
        href = a.get("href") or ""
        # Keep inter-state contests that land on this state's board
        # (Meridian ID @ Box Elder, etc.). The national rail uses
        # data-contest-id-x and is not selected here.
        items = a.select("ul.teams > li")
        if len(items) < 2:
            continue

        def one(item: Tag) -> Tuple[str, Optional[int], Optional[int]]:
            name, rank = _name_and_rank(item.find("div", class_="name"))
            score_el = item.find("div", class_="score")
            score = _int_or_none(score_el.get_text() if score_el else None)
            return name, score, rank

        away_name, away_score, away_rank = one(items[0])
        home_name, home_score, home_rank = one(items[1])
        if any(s in (away_name or "").lower() or s in (home_name or "").lower()
               for s in SKIP_NAMES):
            continue
        if not away_name or not home_name:
            continue

        seen.add(contest_id)
        ids = [x for x in (li.get("data-teams") or "").split(",") if x]
        # data-teams is home,away; the visual list is away, home.
        home_id = ids[0] if len(ids) > 0 else slugify(home_name)
        away_id = ids[1] if len(ids) > 1 else slugify(away_name)
        details = box.find("div", class_="details")
        details_text = details.get_text(" ", strip=True) if details else ""
        is_forfeit = 1 if "forfeit" in details_text.lower() else 0
        match_url = href if href.startswith("http") else urljoin(
            "https://www.maxpreps.com", href)

        out.append({
            "date": date.isoformat(),
            "state": state.upper(),
            "away_team": away_name,
            "home_team": home_name,
            "away_score": away_score,
            "home_score": home_score,
            "neutral": 0,
            "is_forfeit": is_forfeit,
            "name_source": "contest-box",
            "match_url": match_url,
            "contest_id": contest_id,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "home_rank": home_rank,
            "away_rank": away_rank,
        })
    return out


def _parse_day_fallback(html: str, date: dt.date, state: str) -> List[dict]:
    """Original text-regex parser, kept if contest-box markup disappears."""
    soup = BeautifulSoup(html, "html.parser")
    out: List[dict] = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/soccer/" not in href or "/match/" not in href:
            continue
        if not href_in_state(href, state):
            continue
        if a.find_parent("p", class_="summary"):
            continue
        cid = href.split("c=")[-1] if "c=" in href else href
        if cid in seen:
            continue
        seen.add(cid)
        text = re.sub(r"\s+", " ", a.get_text(" ", strip=True))
        played = "Final" in text
        pairs = PAIR.findall(text)
        name_source = "display"
        if played and len(pairs) >= 2:
            away_score, away = int(pairs[0][0]), clean(pairs[0][1])
            home_score, home = int(pairs[1][0]), clean(pairs[1][1])
        else:
            away_score = home_score = None
            recs = RECORD_PAIR.findall(text)
            if len(recs) >= 2:
                away, home = clean(recs[0][1]), clean(recs[1][1])
            else:
                m = SLUG_PAIR.search(href)
                if not m:
                    continue
                away = clean(m.group(1).replace("-", " ").title())
                home = clean(m.group(2).replace("-", " ").title())
                name_source = "slug"
        if any(s in (away or "").lower() or s in (home or "").lower()
               for s in SKIP_NAMES):
            continue
        if not away or not home:
            continue
        match_url = href if href.startswith("http") else urljoin(
            "https://www.maxpreps.com", href)
        out.append({
            "date": date.isoformat(),
            "state": state.upper(),
            "away_team": away,
            "home_team": home,
            "away_score": away_score,
            "home_score": home_score,
            "neutral": 0,
            "is_forfeit": 0,
            "name_source": name_source,
            "match_url": match_url,
            "contest_id": cid if re.fullmatch(
                r"[0-9a-f-]{36}", cid, re.I) else "",
            "home_team_id": slugify(home),
            "away_team_id": slugify(away),
            "home_rank": None,
            "away_rank": None,
        })
    return out


def parse_day(html: str, date: dt.date, state: str) -> List[dict]:
    """Pull one day's matches out of a scoreboard page."""
    rows = _parse_contest_boxes(html, date, state)
    if rows:
        return rows
    return _parse_day_fallback(html, date, state)


def team_schedule_url(team_url: str) -> str:
    u = (team_url or "").split("?")[0].rstrip("/")
    if not u:
        return ""
    if u.endswith("/schedule"):
        return u + "/"
    return u + "/schedule/"


def slug_from_team_url(url: str) -> str:
    m = TEAM_URL_RE.search(url or "")
    return m.group(2) if m else ""


def parse_next_data(html: str) -> Optional[dict]:
    m = NEXT_DATA_RE.search(html or "")
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _schedule_team(t: list) -> Optional[dict]:
    """Unpack one packed team array from a schedule contest."""
    if not isinstance(t, list) or len(t) < 15:
        return None
    score = t[6] if len(t) > 6 else None
    homeish = t[11] if len(t) > 11 else None
    return {
        "name": clean(str(t[14] or "")),
        "score": score if isinstance(score, int) else None,
        "url": t[13] if isinstance(t[13], str) else "",
        "school_uuid": t[1] if isinstance(t[1], str) else "",
        "is_home": homeish == 0,
    }


def parse_team_schedule(html: str, state: str) -> Tuple[List[dict], List[str]]:
    """Scored contests from a team schedule page, plus opponent schedule URLs.

    MaxPreps packs contests in __NEXT_DATA__. The rendered table hides
    contests flagged deleted (c[3]=True). Those still carry scores --
    Brighton's 8-0 at Cyprus on 2026-08-13 is one -- so we keep any
    deleted contest that has both scores. c[27] is a note string on
    deleted rows and a roles list on live rows; do not assume a str.
    Join teams by display name later: schedule school UUIDs are not
    the scoreboard data-teams tokens.
    """
    data = parse_next_data(html)
    if not data:
        return [], []
    contests = data.get("props", {}).get("pageProps", {}).get("contests") or []
    rows: List[dict] = []
    opp_urls: List[str] = []
    seen = set()
    for c in contests:
        if not isinstance(c, list) or len(c) < 12:
            continue
        teams = c[0]
        contest_id = c[1] if isinstance(c[1], str) else ""
        deleted = bool(c[3]) if len(c) > 3 else False
        when = c[11] if len(c) > 11 else ""
        match_url = c[18] if len(c) > 18 and isinstance(c[18], str) else ""
        note = c[27] if len(c) > 27 and isinstance(c[27], str) else ""
        if not isinstance(teams, list) or len(teams) < 2:
            continue
        slots = [s for s in (_schedule_team(t) for t in teams) if s]
        for s in slots:
            u = team_schedule_url(s.get("url") or "")
            if u:
                opp_urls.append(u)
        if len(slots) < 2:
            continue
        home = next((s for s in slots if s["is_home"]), None)
        away = next((s for s in slots if not s["is_home"]), None)
        if not home or not away:
            continue
        if any(x in (home["name"] or "").lower() or x in (away["name"] or "").lower()
               for x in SKIP_NAMES):
            continue
        if home["score"] is None or away["score"] is None:
            continue
        if not isinstance(when, str) or len(when) < 10:
            continue
        if not contest_id or contest_id in seen:
            continue
        seen.add(contest_id)
        rows.append({
            "date": when[:10],
            "state": state.upper(),
            "away_team": away["name"],
            "home_team": home["name"],
            "away_score": away["score"],
            "home_score": home["score"],
            "neutral": 0,
            "is_forfeit": 1 if "forfeit" in note.lower() else 0,
            "name_source": (
                "team-schedule-deleted" if deleted else "team-schedule"),
            "match_url": match_url,
            "contest_id": contest_id,
            "home_team_id": "",
            "away_team_id": "",
            "home_rank": None,
            "away_rank": None,
            "_home_url": home["url"],
            "_away_url": away["url"],
        })
    return rows, opp_urls


def bind_schedule_ids(rows: List[dict], teams: Dict[str, dict]) -> None:
    """Map schedule display names onto existing scoreboard team_ids."""
    by_name = {}
    for tid, rec in teams.items():
        n = (rec.get("display_name") or "").strip().lower()
        if n and n not in by_name:
            by_name[n] = tid

    def pick(name: str, url: str) -> str:
        n = (name or "").strip().lower()
        if n in by_name:
            tid = by_name[n]
            slug = slug_from_team_url(url)
            if slug and not teams[tid].get("maxpreps_slug"):
                teams[tid]["maxpreps_slug"] = slug
            return tid
        fallback = slug_from_team_url(url) or slugify(name)
        sys.stderr.write("schedule: unknown team %r, id=%s\n" % (name, fallback))
        if fallback and fallback not in teams:
            teams[fallback] = {
                "team_id": fallback,
                "display_name": name,
                "state": "UT",
                "classification": "",
                "region": "",
                "maxpreps_slug": slug_from_team_url(url),
                "is_our_team": "1" if n in OUR_TEAM_NAMES else "0",
            }
            by_name[n] = fallback
        return fallback

    for r in rows:
        r["home_team_id"] = pick(r.get("home_team") or "", r.get("_home_url") or "")
        r["away_team_id"] = pick(r.get("away_team") or "", r.get("_away_url") or "")


def collect_schedules(session: requests.Session, seed_urls: List[str],
                      state: str, delay: float, hops: int,
                      start: Optional[dt.date], end: Optional[dt.date],
                      teams: Dict[str, dict]) -> List[dict]:
    """Crawl team schedule pages. hops=0 is seeds only; 1 adds opponents."""
    seen_urls = set()
    queue = [team_schedule_url(u) or u for u in seed_urls if u]
    rows: List[dict] = []
    for hop in range(hops + 1):
        nxt: List[str] = []
        for url in queue:
            url = (url or "").rstrip("/") + "/"
            if not url.startswith("http") or url in seen_urls:
                continue
            seen_urls.add(url)
            html = fetch(session, url)
            time.sleep(delay)
            if not html:
                continue
            day_rows, opp = parse_team_schedule(html, state)
            rows.extend(day_rows)
            nxt.extend(opp)
            sys.stderr.write("schedule hop %d %s: %d scored\n"
                             % (hop, url, len(day_rows)))
        queue = nxt
    if start and end:
        lo, hi = start.isoformat(), end.isoformat()
        rows = [r for r in rows if lo <= r["date"] <= hi]
    bind_schedule_ids(rows, teams)
    return rows


def read_games_csv(path: str) -> List[dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    int_cols = ("home_score", "away_score", "home_rank", "away_rank",
                "neutral", "is_forfeit")
    for r in rows:
        for k in int_cols:
            v = (r.get(k) or "").strip()
            if v.isdigit() or (v.startswith("-") and v[1:].isdigit()):
                r[k] = int(v)
            elif v == "":
                r[k] = None
    return rows


def read_teams_csv(path: str) -> Dict[str, dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        return {r["team_id"]: r for r in csv.DictReader(fh) if r.get("team_id")}


def write_csv(path: str, rows: Iterable[dict], cols: List[str]) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in cols})


def teams_from_games(games: List[dict], state: str) -> Dict[str, dict]:
    teams: Dict[str, dict] = {}

    def add(tid: str, name: str) -> None:
        if not tid or not name:
            return
        rec = teams.setdefault(tid, {
            "team_id": tid,
            "display_name": name,
            "state": state.upper(),
            "classification": "",
            "region": "",
            "maxpreps_slug": "",
            "is_our_team": "1" if name.lower() in OUR_TEAM_NAMES else "0",
        })
        if not rec["display_name"] and name:
            rec["display_name"] = name
        if name.lower() in OUR_TEAM_NAMES:
            rec["is_our_team"] = "1"

    for g in games:
        add(g.get("home_team_id") or "", g.get("home_team") or "")
        add(g.get("away_team_id") or "", g.get("away_team") or "")
    return teams


def _date_q(d: Optional[dt.date]) -> str:
    if not d:
        return ""
    return "&date=%d/%d/%d" % (d.month, d.day, d.year)


def attach_meta(session: requests.Session, html: str, state: str, gender: str,
                teams: Dict[str, dict], delay: float,
                busy_date: Optional[dt.date] = None) -> None:
    """Fill classification and region from the class / region scoreboards.

    Class/region team dropdowns only list who played on the page's date, so
    pass a high-volume day (busy_date) to cover more of the class.
    """
    classes, regions = parse_filters(html)
    class_dates = [None]  # undated class pages list the full class
    region_dates = [None]
    if busy_date:
        region_dates.append(busy_date)
    sys.stderr.write("meta: %d classes, %d regions (region dates=%s)\n"
                     % (len(classes), len(regions),
                        ",".join(d.isoformat() if d else "default"
                                 for d in region_dates)))
    for did, label in classes:
        url = CLASS_ASPX.format(gender=gender, state=state.upper(), did=did,
                                date_q="")
        page = fetch(session, url)
        time.sleep(delay)
        if not page:
            continue
        n = 0
        for tid, name in parse_team_dropdown(page):
            rec = teams.setdefault(tid, {
                "team_id": tid,
                "display_name": name,
                "state": state.upper(),
                "classification": label,
                "region": "",
                "maxpreps_slug": "",
                "is_our_team": "1" if name.lower() in OUR_TEAM_NAMES else "0",
            })
            rec["classification"] = rec["classification"] or label
            rec["display_name"] = rec["display_name"] or name
            if name.lower() in OUR_TEAM_NAMES:
                rec["is_our_team"] = "1"
            n += 1
        sys.stderr.write("  class %s: %d teams\n" % (label, n))

    seen_region = set()
    for d in region_dates:
        dq = _date_q(d)
        for lid, label in regions:
            slug = slugify(label)
            url = REGION_SCORES.format(state=state, gender=gender, slug=slug,
                                       lid=lid, date_q=dq)
            page = fetch(session, url)
            time.sleep(delay)
            if not page:
                continue
            n = 0
            for tid, name in parse_team_dropdown(page):
                rec = teams.setdefault(tid, {
                    "team_id": tid,
                    "display_name": name,
                    "state": state.upper(),
                    "classification": "",
                    "region": label,
                    "maxpreps_slug": "",
                    "is_our_team": "1" if name.lower() in OUR_TEAM_NAMES else "0",
                })
                rec["region"] = rec["region"] or label
                rec["display_name"] = rec["display_name"] or name
                if not rec.get("classification"):
                    m = re.search(r"([1-6]A)", label, re.I)
                    if m:
                        rec["classification"] = m.group(1).upper()
                if name.lower() in OUR_TEAM_NAMES:
                    rec["is_our_team"] = "1"
                n += 1
                seen_region.add((label, tid))
            sys.stderr.write("  %s%s: %d teams\n"
                             % (label, " " + d.isoformat() if d else "", n))


def collect_state(session: requests.Session, state: str, gender: str,
                  start: dt.date, end: dt.date, delay: float,
                  skip_sundays: bool, use_calendar: bool,
                  dump_html: Optional[str]) -> Tuple[List[dict], Dict[str, dict], Optional[str]]:
    rows: List[dict] = []
    first_html: Optional[str] = None
    dates: List[dt.date]

    if skip_sundays:
        candidates = [d for d in daterange(start, end) if d.weekday() != 6]
    else:
        candidates = list(daterange(start, end))
    if not candidates:
        return [], {}, None

    seed = candidates[0]
    seed_url = BASE.format(state=state, gender=gender, m=seed.month, d=seed.day, y=seed.year)
    seed_html = fetch(session, seed_url)
    time.sleep(delay)
    if not seed_html:
        sys.stderr.write("failed to fetch seed page %s\n" % seed_url)
        return [], {}, None
    first_html = seed_html
    if dump_html:
        os.makedirs(dump_html, exist_ok=True)
        with open("%s/%s_%s.html" % (dump_html, state, seed.isoformat()),
                  "w", encoding="utf-8") as fh:
            fh.write(seed_html)

    calendar = parse_calendar(seed_html) if use_calendar else {}
    if use_calendar and calendar:
        dates = [d for d in candidates if calendar.get(d, 0) > 0]
        sys.stderr.write("%s calendar: %d days with games in range\n"
                         % (state, len(dates)))
    else:
        dates = candidates
        if use_calendar:
            sys.stderr.write("%s: no calendar parsed, walking every day\n" % state)

    fetched = {seed: seed_html}
    for d in dates:
        html = fetched.get(d)
        if html is None:
            url = BASE.format(state=state, gender=gender, m=d.month, d=d.day, y=d.year)
            html = fetch(session, url)
            time.sleep(delay)
            if not html:
                continue
            if dump_html:
                with open("%s/%s_%s.html" % (dump_html, state, d.isoformat()),
                          "w", encoding="utf-8") as fh:
                    fh.write(html)
        day = parse_day(html, d, state)
        rows.extend(day)
        sys.stderr.write("%s %s: %d matches\n" % (state, d.isoformat(), len(day)))

    teams = teams_from_games(rows, state)
    return rows, teams, first_html


# ----------------------------------------------------------------------
# Known-day checks used by --self-test
# ----------------------------------------------------------------------

EXPECTED_AUG3 = {
    ("Farmington", "Crimson Cliffs", 0, 1),
    ("Summit Academy", "Manti", 0, 9),
    ("Northridge", "Pleasant Grove", 2, 6),
    ("Green Canyon", "Syracuse", 5, 0),
    ("Granger", "Juan Diego Catholic", 0, 3),
    ("Hurricane", "Maple Mountain", 0, 6),
    ("Weber", "Clearfield", 4, 0),
}
EXPECTED_SEP9 = {
    ("Bear River", "Deseret Peak", 5, 1),
    ("Ridgeline", "Stansbury", 2, 1),
    ("Green Canyon", "Tooele", 9, 1),
}
EXPECTED_AUG29 = {
    ("Meridian", "Box Elder", 0, 2),
    ("Meridian", "Logan", 2, 2),
}
# Deleted on the day board; still on Brighton's team schedule.
EXPECTED_CYPRUS = ("Brighton", "Cyprus", 8, 0)


def _as_tuple(r: dict) -> Tuple[str, str, int, int]:
    return (r["away_team"], r["home_team"], int(r["away_score"]), int(r["home_score"]))


def self_test(delay: float) -> int:
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    ok = True
    for day, expected in (
        (dt.date(2026, 8, 3), EXPECTED_AUG3),
        (dt.date(2026, 9, 9), EXPECTED_SEP9),
        (dt.date(2026, 8, 29), EXPECTED_AUG29),
    ):
        url = BASE.format(state="ut", gender="girls", m=day.month, d=day.day, y=day.year)
        html = fetch(session, url)
        time.sleep(delay)
        if not html:
            sys.stderr.write("self-test: failed to fetch %s\n" % url)
            return 1
        got = {_as_tuple(r) for r in parse_day(html, day, "ut")
               if r["home_score"] is not None}
        missing = expected - got
        extra = got - expected
        sys.stderr.write("%s: parsed %d scored, expected %d\n"
                         % (day.isoformat(), len(got), len(expected)))
        if missing:
            sys.stderr.write("  MISSING %s\n" % sorted(missing))
            ok = False
        if extra:
            sys.stderr.write("  EXTRA %s\n" % sorted(extra))
            ok = False
    html = fetch(session, OUR_TEAM_SCHEDULE)
    time.sleep(delay)
    if not html:
        sys.stderr.write("self-test: failed to fetch Brighton schedule\n")
        return 1
    sched, _opp = parse_team_schedule(html, "ut")
    got_s = {_as_tuple(r) for r in sched}
    cyprus = [r for r in sched
              if r["date"] == "2026-08-13" and r["home_team"] == "Cyprus"]
    sys.stderr.write("brighton schedule: %d scored, cyprus rows=%d\n"
                     % (len(got_s), len(cyprus)))
    if EXPECTED_CYPRUS not in got_s:
        sys.stderr.write("  MISSING Cyprus 8-0 on Brighton schedule\n")
        ok = False
    elif cyprus and cyprus[0].get("name_source") != "team-schedule-deleted":
        sys.stderr.write("  Cyprus row should be marked deleted, got %s\n"
                         % cyprus[0].get("name_source"))
        ok = False
    if ok:
        sys.stderr.write("self-test passed\n")
        return 0
    sys.stderr.write("self-test FAILED\n")
    return 1


def _row_rank(r: dict) -> Tuple[int, int, int]:
    """Lower is better: scored contest-box rows beat schedule backfill."""
    scored = 0 if r.get("home_score") is not None else 1
    src = r.get("name_source") or ""
    src_n = {
        "contest-box": 0,
        "display": 1,
        "team-schedule": 2,
        "team-schedule-deleted": 3,
        "slug": 4,
    }.get(src, 5)
    has_url = 0 if r.get("match_url") else 1
    return (scored, src_n, has_url)


def _dedup(rows: List[dict]) -> List[dict]:
    dedup: Dict[Tuple[str, str, str], dict] = {}
    for r in rows:
        key = (r["date"], r["home_team"], r["away_team"])
        if key not in dedup or _row_rank(r) < _row_rank(dedup[key]):
            dedup[key] = r
    return sorted(dedup.values(), key=lambda r: (r["date"], r["home_team"]))


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--states", nargs="+", default=["ut"],
                   help="two-letter state codes")
    p.add_argument("--gender", default="girls", choices=["girls", "boys"])
    p.add_argument("--start", help="YYYY-MM-DD")
    p.add_argument("--end", help="YYYY-MM-DD")
    p.add_argument("--season", action="store_true",
                   help="UT girls from 2026-08-03 through today; skip Sundays "
                        "and empty calendar days; scrape class+region")
    p.add_argument("--out", default="",
                   help="games CSV path (default: ../data/ut_girls_soccer_YYYY.csv)")
    p.add_argument("--teams-out", default="",
                   help="teams CSV path (next to --out unless set)")
    p.add_argument("--delay", type=float, default=1.5)
    p.add_argument("--dump-html", metavar="DIR",
                   help="save raw HTML here for selector debugging")
    p.add_argument("--skip-sundays", dest="skip_sundays",
                   action="store_true", default=None)
    p.add_argument("--include-sundays", dest="skip_sundays",
                   action="store_false")
    p.add_argument("--no-calendar", action="store_true",
                   help="hit every day in range instead of the scoreboard calendar")
    p.add_argument("--no-meta", action="store_true",
                   help="skip class/region pages")
    p.add_argument("--schedules", action="store_true",
                   help="also crawl team schedule pages (on by default with --season)")
    p.add_argument("--no-schedules", action="store_true",
                   help="skip team schedule pages")
    p.add_argument("--schedules-only", action="store_true",
                   help="only crawl team schedules and merge into --out")
    p.add_argument("--schedule-hops", type=int, default=1,
                   help="0=seed teams only, 1=also opponents (default)")
    p.add_argument("--self-test", action="store_true",
                   help="fetch 8/3, 9/9, and Brighton schedule (Cyprus 8-0)")
    args = p.parse_args()

    if args.self_test:
        return self_test(args.delay)

    today = dt.date.today()
    if args.schedules_only:
        start = dt.date.fromisoformat(args.start) if args.start else SEASON_OPENER
        end = dt.date.fromisoformat(args.end) if args.end else today
        skip_sundays = True if args.skip_sundays is None else args.skip_sundays
        use_calendar = not args.no_calendar
        fetch_meta = False
        args.states = args.states or ["ut"]
    elif args.season:
        start = dt.date.fromisoformat(args.start) if args.start else SEASON_OPENER
        end = dt.date.fromisoformat(args.end) if args.end else today
        skip_sundays = True if args.skip_sundays is None else args.skip_sundays
        use_calendar = not args.no_calendar
        fetch_meta = not args.no_meta
        args.states = args.states or ["ut"]
    else:
        if not args.start or not args.end:
            p.error("--start and --end are required (or pass --season)")
        start = dt.date.fromisoformat(args.start)
        end = dt.date.fromisoformat(args.end)
        skip_sundays = False if args.skip_sundays is None else args.skip_sundays
        use_calendar = not args.no_calendar
        fetch_meta = not args.no_meta

    if end > today:
        end = today

    fetch_schedules = (
        args.schedules_only
        or args.schedules
        or (args.season and not args.no_schedules)
    )
    if args.no_schedules:
        fetch_schedules = False

    out_path = args.out or os.path.join(
        os.path.dirname(__file__), "..", "data",
        "ut_girls_soccer_%d.csv" % start.year)
    out_path = os.path.normpath(out_path)
    teams_path = args.teams_out or (
        os.path.splitext(out_path)[0] + "_teams.csv")

    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})

    rows: List[dict] = []
    teams: Dict[str, dict] = {}
    if args.schedules_only:
        if os.path.exists(out_path):
            rows = read_games_csv(out_path)
            sys.stderr.write("loaded %d existing games from %s\n"
                             % (len(rows), out_path))
        if os.path.exists(teams_path):
            teams = read_teams_csv(teams_path)
            sys.stderr.write("loaded %d teams from %s\n"
                             % (len(teams), teams_path))
        if not teams:
            teams = teams_from_games(rows, args.states[0])

    for state in args.states:
        if not args.schedules_only:
            day_rows, day_teams, first_html = collect_state(
                session, state, args.gender, start, end, args.delay,
                skip_sundays, use_calendar, args.dump_html)
            rows.extend(day_rows)
            teams.update(day_teams)
            if fetch_meta and first_html and state.lower() == "ut":
                cal = parse_calendar(first_html)
                busy = max(cal, key=cal.get) if cal else None
                attach_meta(session, first_html, state, args.gender, teams,
                            args.delay, busy_date=busy)
        if fetch_schedules:
            seeds = []
            if state.lower() == "ut" and args.gender == "girls":
                seeds.append(OUR_TEAM_SCHEDULE)
            extra = collect_schedules(
                session, seeds, state, args.delay, args.schedule_hops,
                start, end, teams)
            sys.stderr.write("%s schedules: %d scored contests\n"
                             % (state, len(extra)))
            rows.extend(extra)

    final = _dedup(rows)
    write_csv(out_path, final, GAME_COLS)
    team_rows = sorted(teams.values(), key=lambda r: (r.get("classification") or "",
                                                      r["display_name"]))
    write_csv(teams_path, team_rows, TEAM_COLS)

    played = sum(1 for r in final if r["home_score"] is not None)
    sys.stderr.write("\nwrote %s: %d rows (%d with scores), %d teams -> %s\n"
                     % (out_path, len(final), played, len(teams), teams_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
