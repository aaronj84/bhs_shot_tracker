# Feature requests WIP

Started: 2026-09-16

Process one paragraph at a time. Commit after each. Update this file as work proceeds so a later session can resume.

## Status

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Ignore `.DS_Store` in `.gitignore` | done | commit `4f26401` |
| 2 | Free kick + shot infinite loop; add every shot type to tests (home + visitor) | done | Loop was afterTakerPicked re-entering fk-result and miss-dir requiring position |
| 3 | Corners require shot location; add corner without tapping occupied spot | done | Corner then shot awaits a second tap; Left/Right corner buttons; inspect Add play here; double-tap works on marks |
| 4 | White circle on shot map: jersey number cannot be white | pending | |
| 5 | Missed option for crossbar or post | pending | |
| 6 | Team kicks: show prior shooter numbers above player selector | pending | |
| 7 | Lineup syncs every time synchronization happens | pending | |
| 8 | Swap 1st/2nd half shots for Olympus 2026-09-15 | pending | SQL already drafted in `supabase/fix_shots_olympus_2026-09-15_swap_halves.sql` |
| 9 | Default to first half; confirm if tracking 2nd before 1st | pending | |
| 10 | Bulk edit to change half on a bunch of shots | pending | |
| 11 | Swap player when entering who committed the foul | pending | |
| 12 | Set game to “final” — scoreboard + data archival | pending | |

## Resume instructions

1. Read this file.
2. Find the first non-done row.
3. Implement that feature only.
4. Commit with a useful message.
5. Mark the row done and start the next.

## Current work

#3 done. Next: #4 white circle on shot map cannot have a white jersey number.
