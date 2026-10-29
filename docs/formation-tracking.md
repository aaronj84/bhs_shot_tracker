# Formation tracking (design notes)

Status: **notes only — do not implement yet.** Backlog item **B2** in [`FEATURE_REQUESTS_WIP.md`](FEATURE_REQUESTS_WIP.md).

Goal: record which player is in which position over the course of a match, and let staff switch the shape (4-3-3, 4-4-2, and other common XI shapes) without fighting a fixed pitch map.

## What we already have

| Piece | Today |
| --- | --- |
| Shape | Hardcoded **4-3-3** only: `POSITION_SLOTS` + `FORMATIONATION_LAYOUT` in `shots.js` |
| Live XI | `games.lineup` jsonb `{ us: { "<slotId>": { player_id, jersey_number } } }` — current snapshot, no history |
| Edits | Swap / sub / restore default on the formation pitch; Sync push/pull |
| Clock | Per-game clock + `shots.game_clock_seconds` (elapsed into period). Periods: `1`, `2`, `ET1`, `ET2` |
| Position on plays | Each shot/foul can carry a `position` code (GK, LB, …) from the same 4-3-3 slot list |

`shots.js` header still lists “formation drawing” as out of scope for the current phase; this doc is the place to decide what “recordable throughout a match” means before code.

## Product requirements (from B2 + this ask)

1. **Timeline**: know who occupied which role at which minute (or clock stamp), not only the latest XI.
2. **Shape toggle**: switch among at least **4-3-3** and **4-4-2**, with room for other shapes (3-5-2, 4-2-3-1, 4-1-4-1, …) without a schema rewrite per shape.
3. **Sideline-first**: iPhone portrait (390×844). Changes must be few taps while the clock is running — not a desktop tactics board.
4. **Compatible with Sync**: another phone watching or recording should see the same live XI; history must not break the existing lineup pull/push pattern.

## Core modeling choice: snapshot vs event log

Both can answer “who was at LM at 23:00?” The difference is write shape and UI.

### A. Formation *events* (append-only log) — lean recommendation

Each staff action appends a row (or jsonb event):

- shape change → `type: "shape"`, `shape: "4-4-2"`, clock stamp
- player into slot / sub / swap → `type: "assign" | "sub" | "swap"`, slots + players, clock stamp

**Pros:** Natural timeline; easy undo (“delete last event”); matches how the game is coached (subs and shape changes are discrete).  
**Cons:** “XI at minute T” requires replaying events up to T (or caching a derived snapshot).

### B. Periodic / on-change *snapshots*

Store full XI (+ shape) whenever anything changes, keyed by `(period, elapsed_sec)`.

**Pros:** Instant “who was on at T” (binary search / last snapshot ≤ T).  
**Cons:** Duplicates 11 players every edit; harder to show “what changed”; larger jsonb if kept on `games`.

### C. Hybrid (events + derived current)

Persist the event log; keep `games.lineup` (or `games.formation_current`) as the **materialized live XI** for Sync and for stamping plays — same as today.

**Pros:** Sideline Sync stays simple; history is queryable; play recording still reads one object.  
**Cons:** Two representations to keep consistent (always derive current from events, or write both in one API call).

**Lean:** **C**. Keep today’s live snapshot for the recorder; add an append-only history for minutes and shape changes.

## Shape catalog (toggle 4-3-3 / 4-4-2 / …)

Do **not** hardcode one layout array forever. Treat shapes as data:

```text
shape id     → ordered list of role slots
role slot    → { code, group, x%, y% }   // pitch pin for UI
```

Examples:

| Shape | Back | Mid | Front | Notes vs current slots |
| --- | --- | --- | --- | --- |
| `4-3-3` | LB LCB RCB RB | LM DM RM | LW CF RW | Matches today’s codes |
| `4-4-2` | LB LCB RCB RB | LM LCM RCM RM | LST RST | Needs CM / ST codes (or map DM→LCM and CF→LST) |
| `4-2-3-1` | LB LCB RCB RB | LDM RDM | LAM CAM RAM | + ST |
| `3-5-2` | LCB CB RCB | LWB LCM CM RCM RWB | LST RST | Wing-backs |

### Slot identity options

1. **Stable role codes per shape** (LW, CF, …) — codes can overlap across shapes; a player “stays” on CF when switching 4-3-3 → 4-2-3-1 if both have CF.
2. **Opaque slot ids** (`s1`…`s11`) with a shape-specific label map — safer for DB uniqueness, worse for play `position` continuity.
3. **Canonical role vocabulary** shared across shapes (OB, CB, DM, CM, AM, W, ST, GK) plus optional side (L/R/C) — good for analytics (“minutes at CM”), slightly abstract for tap UI.

**Lean:** shape-specific **role codes** that reuse today’s codes where possible, plus a small **remap table** when toggling shapes (e.g. 4-3-3 `LM`/`RM`/`DM` → 4-4-2 `LM`/`LCM`/`RCM`/`RM` with a prompt for the ambiguous mid).

When the shape changes mid-game:

- Prefer **keep players on matching codes**, clear unmatched slots, and highlight empties for quick fill.
- Never silently invent a full remapping without a confirm step on phone (too easy to get wrong on the sideline).

## Clock / “at what minute”

Reuse the existing game clock model — do **not** invent a second clock.

Stamp every formation event with:

- `period` (`1` | `2` | `ET1` | `ET2`)
- `elapsed_sec` (same meaning as `shots.game_clock_seconds`: elapsed into that period)
- optional `recorded_at` wall time (debug / multi-device ordering)

Display as match minute for reports: half length + elapsed rules already live in `shots.js` (`periodLengthSec`, count-up vs countdown).

Edge cases to decide later:

| Case | Options |
| --- | --- |
| Clock off / never started | Allow “period only” stamps, or require clock before formation edits |
| Edit after the fact | Allow picking period + clock when adding a retroactive sub |
| Half-time shape change | Event at end of P1 or start of P2 — pick one convention and stick to it |
| Multi-device race | Last-write-wins on live snapshot (today); events need `id` + server time so Sync can merge or refuse |

## Storage sketches (not chosen yet)

### Option 1 — jsonb on `games` (smallest migration)

```json
{
  "us": {
    "shape": "4-3-3",
    "slots": { "1": { "player_id": "…", "jersey_number": "1" }, "…" },
    "history": [
      {
        "id": "…",
        "at": { "period": "1", "elapsed_sec": 1380 },
        "type": "shape",
        "shape": "4-4-2"
      },
      {
        "id": "…",
        "at": { "period": "1", "elapsed_sec": 1402 },
        "type": "sub",
        "off_slot": "9",
        "on": { "player_id": "…", "jersey_number": "5" }
      }
    ]
  }
}
```

Extend today’s `lineup` (or rename conceptually to `formation`) so Sync still pushes one column. Cap history length if jsonb growth becomes an issue.

### Option 2 — relational `game_formation_events`

```text
game_formation_events (
  id, game_id, team ('us'|'opp'),
  period, elapsed_sec,
  event_type, shape, payload jsonb,
  created_at
)
```

Better for SQL minutes-by-position reports; more migrations + API surface.

### Option 3 — `game_formation_segments`

Closed intervals: `(shape, slot → player)` valid from `start` until next change. Nice for “minutes played at position” aggregates; more work on every write.

**Lean for v1:** Option 1 or 2 with hybrid C (live snapshot + events). Prefer Option 2 if we expect coach reports (“minutes at RW”) soon; Option 1 if we only need UI timeline first.

## Sideline UX (portrait)

Keep one formation pitch; add a **shape control** near the existing lineup tools (not a second screen of tactics).

Suggested flow:

1. Open lineup / formation (existing).
2. Tap shape chip: `4-3-3` · `4-4-2` · `More…` → applies remap + stamps a shape event at current clock.
3. Sub / swap as today → each successful change stamps an assign/sub/swap event.
4. Optional “Formation log” sheet: scroll of events with minute labels; tap to edit/delete last mistaken sub (PIN already gates writes).

Avoid:

- Drag-and-drop tactics boards
- Editing both teams’ shapes in one dense view
- Hover-only affordances

Visitor/opponent XI can stay shape-less or mirror the same model later; Brighton (`us`) is the priority.

## Interaction with shot / foul `position`

Today play position codes assume 4-3-3. If the live shape is 4-4-2:

- Position picker should use **current shape’s** role codes / pins.
- Historical plays keep the code they were saved with (do not rewrite when shape changes later).
- Reports that join “shot position” to “formation minutes” must treat codes as **role labels**, not permanent slot numbers.

## Analytics that become possible

Once history exists:

- Minutes per player per role (and per shape)
- “Who was on the pitch when this shot happened?” (replay events to play’s clock)
- Shape usage share (time in 4-3-3 vs 4-4-2)

Not required for v1 UI, but the event model should not block them.

## Phased approach (when we do build)

1. **Shape catalog + layout maps** in JS only; still a single live XI; toggle remaps pins (no history yet). Validates UX on phone.
2. **Stamp events** into jsonb or a table; keep `games.lineup` as current.
3. **Timeline / minutes report** (read path).
4. Optional: opponent formations; default shape per competition; PIN-gated “correct past event”.

## Open questions

1. Is clock required for formation edits, or is period-only OK when clock is off?
2. Which shapes are in the first chip row (beyond 4-3-3 / 4-4-2)?
3. On shape toggle, auto-remap silence vs always confirm empties?
4. jsonb on `games` vs `game_formation_events` table for v1?
5. Should subbing from the foul/shot picker also append formation history (yes if that picker mutates live XI today)?
6. Do we care about bench order / who is available, or only the XI slots?

## Decision log

| Date | Decision |
| --- | --- |
| 2026-10-23 | Notes only; no schema or UI yet. Prefer hybrid live snapshot + event log; multi-shape role catalog with remap-on-toggle. |
