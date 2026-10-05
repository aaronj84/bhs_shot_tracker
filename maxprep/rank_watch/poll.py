#!/usr/bin/env python3
"""Poll a MaxPreps rankings page for a change in its "Last Updated" line; alert via iMessage."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_PATH = SCRIPT_DIR / "state.json"
POLL_LOG = SCRIPT_DIR / "poll.log"
CHANGES_LOG = SCRIPT_DIR / "changes.log"
DEFAULT_URL = "https://www.maxpreps.com/ut/soccer/girls/"
TZ = ZoneInfo("America/Denver")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)
TIMEOUT_S = 10
RETRIES = 2
FAILURE_ALERT_THRESHOLD = 4
HEARTBEAT_EVERY = 4
PREFIX = "Last Updated:"
LABEL = "com.aaron.maxpreps-rank-watch"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
DOMAIN = f"gui/{os.getuid()}"


class PollError(Exception):
    """Fetch or parse failure."""


def now_local() -> datetime:
    return datetime.now(TZ)


def stamp() -> str:
    return now_local().strftime("%Y-%m-%d %H:%M:%S %Z")


def norm(text: str) -> str:
    return " ".join(text.split())


def append_line(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def fetch(url: str) -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    last_err: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=TIMEOUT_S)
        except requests.RequestException as e:
            last_err = e
        else:
            if resp.status_code < 500:
                if resp.status_code != 200:
                    raise PollError(f"HTTP {resp.status_code}; {page_summary(resp.text)}")
                return resp.text
            last_err = PollError(f"HTTP {resp.status_code}")
        if attempt < RETRIES:
            time.sleep(2 * 2**attempt)
    raise PollError(f"fetch failed after {RETRIES + 1} attempts: {last_err}")


def page_summary(html: str) -> str:
    """Short description of an unexpected page (e.g. a bot-block) for error messages."""
    soup = BeautifulSoup(html, "lxml")
    title = norm(soup.title.get_text()) if soup.title else "(no title)"
    body = norm(soup.get_text(" "))[:160]
    return f"title={title!r} body={body!r}"


def strip_prefix(text: str) -> str | None:
    text = norm(text)
    if text.lower().startswith(PREFIX.lower()):
        return text[len(PREFIX):].strip() or None
    return None


def parse_last_updated(html: str) -> str:
    """Return the "Last Updated" value, e.g. '10/1/2026' or 'Thursday, Oct 1, 2026'.

    Two server-rendered layouts are supported (styled-component class hashes
    change between deploys, so only stable class names / prefixes are used):
    - Full rankings list (/rankings/1/): <ul class="RankingsNotes__...">
      <li>Last updated: 10/1/2026</li>
    - State home page card: <h2 class="title">UT Girls Soccer Rankings</h2>
      then <h3 class="sub-title">Last Updated: Thursday, Oct 1, 2026</h3>
    """
    soup = BeautifulSoup(html, "lxml")
    for li in soup.select('ul[class*="RankingsNotes"] > li'):
        value = strip_prefix(li.get_text())
        if value:
            return value
    for h2 in soup.select("h2.title"):
        if not norm(h2.get_text()).endswith("Rankings"):
            continue
        h3 = h2.find_next("h3", class_="sub-title")
        value = strip_prefix(h3.get_text()) if h3 else None
        if value:
            return value
    raise PollError(f"'Last Updated' node not found; {page_summary(html)}")


def parse_rankings(html: str) -> tuple[list[tuple[int, str, float]], str | None]:
    """Return ([(rank, team, rating)], exact lastUpdated timestamp) from the page's
    embedded Next.js JSON; ([], None) if absent.

    Full rankings list pages carry it in pageProps.rankingsListData (one page,
    25 teams). The state home page card only shows record and "Str." (strength
    of schedule) visibly; its rating is in layoutProps.rankingsCardProps.
    """
    soup = BeautifulSoup(html, "lxml")
    tag = soup.find("script", id="__NEXT_DATA__")
    try:
        props = json.loads(tag.string)["props"]["pageProps"]
    except (AttributeError, TypeError, KeyError, ValueError):
        return [], None
    candidates = [
        lambda: props["rankingsListData"],
        lambda: props["layoutProps"]["rankingsCardProps"]["data"][0],
    ]
    for get in candidates:
        try:
            data = get()
            rows = [(int(r["rank"]), str(r["schoolName"]), float(r["rating"])) for r in data["rankings"]]
        except (TypeError, KeyError, IndexError, ValueError):
            continue
        if rows:
            return rows, data.get("lastUpdated")
    return [], None


def format_rankings(rows: list[tuple[int, str, float]]) -> str:
    if not rows:
        return "(rankings data not found)"
    return "\n".join(f"{rank}. {team} {rating:.2f}" for rank, team, rating in rows)


def load_state() -> dict[str, Any] | None:
    if not STATE_PATH.exists():
        return None
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    tmp.replace(STATE_PATH)



SEND_TO_HANDLE_SCRIPT = """
on run argv
    tell application "Messages"
        set svc to 1st account whose service type = iMessage
        send (item 2 of argv) to participant (item 1 of argv) of svc
    end tell
end run
"""

SEND_TO_CHAT_SCRIPT = """
on run argv
    tell application "Messages"
        send (item 2 of argv) to chat id (item 1 of argv)
    end tell
end run
"""

LIST_CHATS_SCRIPT = """
tell application "Messages"
    set out to ""
    set AppleScript's text item delimiters to ", "
    repeat with c in chats
        set hs to {}
        try
            repeat with p in participants of c
                set end of hs to (handle of p)
            end repeat
        end try
        set out to out & (id of c) & "  ->  " & (hs as text) & linefeed
    end repeat
    return out
end tell
"""


def osascript(script: str, *args: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script, *args], capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        raise RuntimeError(f"osascript exit {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def recipients() -> list[str]:
    return [r.strip() for r in os.getenv("TO_NUMBER", "").split(",") if r.strip()]


def send_sms(body: str) -> None:
    """Send via the Messages app on this Mac: to the group chat TO_CHAT_ID if set,
    otherwise to each handle in TO_NUMBER (comma-separated) individually."""
    chat_id = os.getenv("TO_CHAT_ID", "").strip()
    if chat_id:
        osascript(SEND_TO_CHAT_SCRIPT, chat_id, body)
        return
    handles = recipients()
    if not handles:
        raise RuntimeError("missing .env value: TO_NUMBER or TO_CHAT_ID")
    errors = []
    for handle in handles:
        try:
            osascript(SEND_TO_HANDLE_SCRIPT, handle, body)
        except RuntimeError as e:
            errors.append(f"{handle}: {e}")
    if errors:
        raise RuntimeError("; ".join(errors))


def try_sms(body: str) -> bool:
    try:
        send_sms(body)
        return True
    except Exception as e:  # noqa: BLE001 -- never let SMS failure lose state updates
        print(f"{stamp()} SMS FAILED: {e}", file=sys.stderr)
        return False


def launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def plist_text() -> str:
    python = SCRIPT_DIR / ".venv" / "bin" / "python"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python}</string>
        <string>{SCRIPT_DIR / "poll.py"}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{SCRIPT_DIR}</string>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{SCRIPT_DIR / "launchd.out.log"}</string>
    <key>StandardErrorPath</key>
    <string>{SCRIPT_DIR / "launchd.err.log"}</string>
</dict>
</plist>
"""


def job_loaded() -> bool:
    return launchctl("print", f"{DOMAIN}/{LABEL}").returncode == 0


def unschedule_self() -> None:
    """Remove the launchd job from inside it. launchd SIGTERMs this process, so
    launchctl runs in its own session to survive, and this must be the last step."""
    if job_loaded():
        subprocess.Popen(
            ["launchctl", "bootout", f"{DOMAIN}/{LABEL}"],
            start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )


def change_message(old: str, new: str, ts: str, html: str, url: str) -> str:
    rows, mp_stamp = parse_rankings(html)
    return (
        f"MaxPreps rankings updated!\nOld: {old}\nNew: {new}\nDetected: {ts}\n"
        f"MaxPreps timestamp: {mp_stamp}\n\nTeam / Rating:\n{format_rankings(rows)}\n\n"
        f"Full rankings: {url}\n\nMonitoring has stopped."
    )


def run_once(url: str) -> int:
    state = load_state() or {
        "baseline": None,
        "consecutive_failures": 0,
        "failure_alert_sent": False,
    }
    ts = stamp()

    if state.get("stopped_at"):
        append_line(POLL_LOG, f"{ts}  STOPPED  (since {state['stopped_at']}; run --start)")
        print(f"{ts} stopped since {state['stopped_at']}; run --start to watch again")
        unschedule_self()
        return 0

    check = state["check_count"] = state.get("check_count", 0) + 1
    heartbeat_due = check % HEARTBEAT_EVERY == 1

    try:
        html = fetch(url)
        value = parse_last_updated(html)
    except PollError as e:
        state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
        n = state["consecutive_failures"]
        state["last_error"] = f"{ts} {e}"
        append_line(POLL_LOG, f"{ts}  #{check}  FAIL #{n}  {e}")
        print(f"{ts} FAIL #{n}: {e}", file=sys.stderr)
        if n >= FAILURE_ALERT_THRESHOLD and not state.get("failure_alert_sent"):
            if try_sms(f"MaxPreps poll: {n} consecutive failures as of {ts}. Last error: {e}"[:600]):
                state["failure_alert_sent"] = True
        elif heartbeat_due:
            try_sms(f"Still monitoring MaxPreps, but check #{check} at {ts} failed "
                    f"({n} in a row): {e}"[:600])
        save_state(state)
        return 1

    if state.get("failure_alert_sent"):
        try_sms(f"MaxPreps poll recovered at {ts}. Current value: {value}")
    state["consecutive_failures"] = 0
    state["failure_alert_sent"] = False
    state.pop("last_error", None)
    state["last_success_at"] = ts

    old = state.get("baseline")
    if old is None:
        state["baseline"] = value
        state["baseline_set_at"] = ts
        save_state(state)
        append_line(POLL_LOG, f"{ts}  #{check}  BASELINE  {value}")
        try_sms(
            f"MaxPreps monitoring started {ts}.\nLast updated: {value}\n"
            f"Checking every 15 min; 'still monitoring' text every {HEARTBEAT_EVERY}th check "
            f"(about hourly).\n{url}"
        )
        print(f"{ts} baseline set: {value}")
        return 0

    if value != old:
        state["baseline"] = value
        state["last_change_at"] = ts
        state["stopped_at"] = ts
        save_state(state)
        mp_stamp = parse_rankings(html)[1]
        sent = try_sms(change_message(old, value, ts, html, url))
        append_line(
            CHANGES_LOG,
            f"{ts}  {old!r} -> {value!r}  mp_ts={mp_stamp}  sms={'sent' if sent else 'FAILED'}",
        )
        append_line(POLL_LOG, f"{ts}  #{check}  CHANGED  {old} -> {value}  (stopping)")
        print(f"{ts} CHANGED: {old} -> {value}; stopping")
        unschedule_self()
        return 0 if sent else 1

    save_state(state)
    append_line(POLL_LOG, f"{ts}  #{check}  unchanged  {value}")
    print(f"{ts} unchanged: {value}")
    if heartbeat_due:
        try_sms(f"Still monitoring MaxPreps. Check #{check} at {ts}.\nLast updated still: {value}")
    return 0


def cmd_start() -> int:
    python = SCRIPT_DIR / ".venv" / "bin" / "python"
    if not python.exists():
        print(f"ERROR: {python} not found; create the venv first (see README).", file=sys.stderr)
        return 1
    if job_loaded():
        launchctl("bootout", f"{DOMAIN}/{LABEL}")
    if STATE_PATH.exists():
        STATE_PATH.unlink()
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(plist_text(), encoding="utf-8")
    result = launchctl("bootstrap", DOMAIN, str(PLIST_PATH))
    if result.returncode != 0:
        print(f"ERROR: launchctl bootstrap failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Started. launchd job {LABEL} runs now, then every 15 minutes.")
    print("Watch for a macOS prompt asking to let Python control Messages -- click OK.")
    return 0


def cmd_stop() -> int:
    state = load_state()
    if state is not None and not state.get("stopped_at"):
        state["stopped_at"] = stamp()
        save_state(state)
    if job_loaded():
        result = launchctl("bootout", f"{DOMAIN}/{LABEL}")
        if result.returncode != 0:
            print(f"ERROR: launchctl bootout failed: {result.stderr.strip()}", file=sys.stderr)
            return 1
    print("Stopped. Run --start to watch again.")
    return 0


def fetch_and_parse(url: str) -> tuple[str, str] | None:
    try:
        html = fetch(url)
        return html, parse_last_updated(html)
    except PollError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return None


def main() -> int:
    load_dotenv(SCRIPT_DIR / ".env")
    url = os.getenv("TARGET_URL") or DEFAULT_URL

    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--start", action="store_true",
                       help="fresh baseline + schedule every 15 min with launchd")
    group.add_argument("--stop", action="store_true", help="unschedule the launchd job")
    group.add_argument("--dry-run", action="store_true", help="fetch + parse only; no SMS, no state")
    group.add_argument("--test-sms", action="store_true", help="send one test message and exit")
    group.add_argument("--reset", action="store_true", help="delete state.json after confirmation")
    group.add_argument("--show", action="store_true", help="print stored state + launchd status")
    group.add_argument("--preview", action="store_true",
                       help="print the change alert built from the live page; no state change")
    group.add_argument("--preview-sms", action="store_true",
                       help="send that change alert to the recipients; no state change")
    group.add_argument("--list-chats", action="store_true",
                       help="list Messages chat ids + participants (to find TO_CHAT_ID)")
    args = ap.parse_args()

    if args.start:
        return cmd_start()
    if args.stop:
        return cmd_stop()

    if args.list_chats:
        print(osascript(LIST_CHATS_SCRIPT).strip() or "(no chats)")
        return 0

    if args.preview or args.preview_sms:
        parsed = fetch_and_parse(url)
        if parsed is None:
            return 1
        html, value = parsed
        old = (load_state() or {}).get("baseline") or "(previous value)"
        body = "[PREVIEW] " + change_message(old, value, stamp(), html, url)
        print(body)
        if args.preview_sms:
            if not try_sms(body):
                return 1
            print("\nPreview sent.")
        return 0

    if args.dry_run:
        parsed = fetch_and_parse(url)
        if parsed is None:
            return 1
        html, value = parsed
        state = load_state() or {}
        baseline = state.get("baseline")
        print(f"URL:      {url}")
        print(f"Parsed:   {value}")
        print(f"Baseline: {baseline}")
        print("Result:   " + ("no baseline yet" if baseline is None
                              else "unchanged" if value == baseline else "CHANGED"))
        rows, mp_stamp = parse_rankings(html)
        print(f"MP ts:    {mp_stamp}")
        print(f"\nTeam / Rating:\n{format_rankings(rows)}")
        return 0

    if args.test_sms:
        try:
            send_sms(f"MaxPreps poll test message at {stamp()}.")
        except Exception as e:  # noqa: BLE001
            print(f"SEND FAILED: {e}", file=sys.stderr)
            return 1
        print("Test message sent.")
        return 0

    if args.reset:
        if not STATE_PATH.exists():
            print("No state.json to delete.")
            return 0
        if input(f"Delete {STATE_PATH}? [y/N] ").strip().lower() == "y":
            STATE_PATH.unlink()
            print("Deleted.")
        else:
            print("Aborted.")
        return 0

    if args.show:
        print(f"launchd job: {'SCHEDULED' if job_loaded() else 'not scheduled'} ({LABEL})")
        print(f"Send to:     {os.getenv('TO_CHAT_ID') or ', '.join(recipients()) or '(none)'}")
        state = load_state()
        if state is None:
            print("No state.json yet.")
        else:
            print(json.dumps(state, indent=2))
        return 0

    return run_once(url)


if __name__ == "__main__":
    sys.exit(main())
