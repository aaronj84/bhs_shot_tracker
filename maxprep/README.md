# MaxPrep

Not an app module. Ryan wants a clear answer to one question: **what scheduling priorities most influence final MaxPreps ranking**, given that region is locked.

| What | Where |
|------|--------|
| Briefing for Ryan — drop this in Drive | `Brighton_scheduling_priorities.docx` |
| Same briefing as HTML (print / backup) | `Brighton_scheduling_priorities.html` |
| Same content as markdown | `deClaude/RYAN_SCHEDULING_PRIORITIES.md` |
| 13 Sep 2026 state rankings (records un-Excelled) | `data/ut_girls_rankings_2026-09-13.csv` |
| Research + Python models | `deClaude/` |

## Now

Give Ryan the briefing. Direction is solid. Magnitudes can be computed.

The season scrape is in `data/ut_girls_soccer_2026.csv` (Aug 3–Sep 12, no Sundays, plus team-schedule backfill for contests MaxPreps deleted from the day board). Refresh with `python3 mp_collect.py --season` from `deClaude/`.

## Next

Ryan’s follow-up: *how much would ranking move if we traded a win against #75 (Logan) for a close loss against #5 (Lone Peak)?*

Brighton’s scoreboard does not include Logan. Swap a real cheap win (Hillcrest, Morgan, Orem) or pass `--drop Hillcrest`.

```bash
cd deClaude
python3 mp_whatif.py --mode swap --games ../data/ut_girls_soccer_2026.csv --team Brighton \
  --snapshot ../data/ut_girls_rankings_2026-09-13.csv \
  --drop-rank 75 --add-rank 5 --add-score 1-2
```
