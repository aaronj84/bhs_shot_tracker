# rank_watch

Polls `TARGET_URL` (default in `.env.example`: the UT 5A girls soccer rankings list) once per
run and sends you an iMessage (through the Messages app on this Mac) when the page's
"Last updated" line changes. The goal is to find out when MaxPreps actually publishes new rankings.

Everything is server-rendered; no JavaScript is needed. Two page layouts are supported:

- Rankings list pages (`.../rankings/1/...`): `ul[class*="RankingsNotes"] > li` starting with
  "Last updated:".
- The state home page (`https://www.maxpreps.com/ut/soccer/girls/`): `h2.title` ending in
  "Rankings", then the next `h3.sub-title` starting with "Last Updated:".

The change alert lists rank, team and MaxPreps rating, plus MaxPreps' exact `lastUpdated`
timestamp, all read from the page's embedded `__NEXT_DATA__` JSON.

## Files

| File | Purpose |
| --- | --- |
| `state.json` | baseline value, failure counter, timestamps |
| `poll.log` | one line per run (unchanged / CHANGED / FAIL) |
| `changes.log` | one line per detected change |
| `launchd.out.log`, `launchd.err.log` | stdout / stderr from launchd runs |

## Setup

```bash
cd /Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then set TO_NUMBER (phone or Apple ID email)
.venv/bin/python poll.py --test-sms
.venv/bin/python poll.py --dry-run
.venv/bin/python poll.py    # first real run: writes baseline, sends startup message
```

Messages must be signed in to iMessage on this Mac. The first `--test-sms` triggers a macOS
prompt asking to let your terminal control Messages -- click OK. If you miss it, enable it under
System Settings -> Privacy & Security -> Automation.

## Watching for an update (the normal flow)

```bash
.venv/bin/python poll.py --start   # fresh baseline, then every 15 min via launchd
.venv/bin/python poll.py --show    # is it scheduled? what's the baseline / check count?
.venv/bin/python poll.py --stop    # give up early
```

- Check #1 sends "monitoring started". Every 4th check after that (#5, #9, #13, ...) sends
  "still monitoring", about once an hour.
- When "Last updated" changes, it sends the rankings (rank, team, rating), MaxPreps' exact
  timestamp and the page link, then unschedules itself. Run `--start` again for the next one.

Recipients: `TO_NUMBER` is a comma-separated list; each person gets their own message. For one
group thread instead, start a group with everyone in Messages by hand (the Messages scripting
interface cannot create groups), run `--list-chats`, and put that chat's id in `TO_CHAT_ID`.

## CLI

- `python poll.py` -- poll once, exit (what launchd runs)
- `python poll.py --start` / `--stop` -- schedule / unschedule the launchd job
- `python poll.py --list-chats` -- list Messages chat ids and participants
- `python poll.py --dry-run` -- fetch and parse, print result; no SMS, no state change
- `python poll.py --test-sms` -- send one test iMessage and exit
- `python poll.py --reset` -- delete state.json (asks first)
- `python poll.py --show` -- print stored baseline and state
- `python poll.py --preview` -- print the change alert as it would look, built from the live page
- `python poll.py --preview-sms` -- send that preview alert to your phone (marked `[PREVIEW]`)

Failure handling: each fetch or parse failure increments `consecutive_failures`. At 4 failures in a row
(about an hour at 15-min intervals) one alert SMS goes out. After that it stays quiet until a
successful poll, which sends one "recovered" SMS.

## launchd (every 15 minutes)

`--start` writes this file and loads it for you; it is here for reference. The path is
`~/Library/LaunchAgents/com.aaron.maxpreps-rank-watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aaron.maxpreps-rank-watch</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch/.venv/bin/python</string>
        <string>/Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch/poll.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch</string>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/aaron/Code/bhs_shot_tracker/maxprep/rank_watch/launchd.err.log</string>
</dict>
</plist>
```

Load / unload by hand (equivalent to `--start` / `--stop`, minus the state reset):

```bash
launchctl load ~/Library/LaunchAgents/com.aaron.maxpreps-rank-watch.plist
launchctl unload ~/Library/LaunchAgents/com.aaron.maxpreps-rank-watch.plist
```

Check it is registered: `launchctl list | grep maxpreps-rank-watch`.

Notes:

- macOS may need Full Disk Access granted to the Python binary for launchd to run it reliably
  (System Settings -> Privacy & Security -> Full Disk Access). `.venv/bin/python` is a symlink;
  grant access to the real binary it points at (`readlink -f .venv/bin/python`).
- `StartInterval` does not fire while the Mac is asleep. A missed interval runs once on wake,
  so gaps in `poll.log` are sleep, not the script failing.
- Under launchd, the process controlling Messages is the venv Python rather than your terminal, so
  macOS asks for Automation permission again on the first scheduled run. Watch for the prompt
  after `launchctl load` (RunAtLoad fires immediately). If `launchd.err.log` shows
  `Not authorized to send Apple events` (-1743), allow Python -> Messages under
  Privacy & Security -> Automation, or `tccutil reset AppleEvents` and reload to get the prompt again.
- You must be logged in to your macOS account; the job runs in your user session.
