#!/usr/bin/env node
/**
 * Rebuild supabase/functions/_shared/mp/season_snapshot.json and
 * tests/fixtures/freeman_whatif.json from maxprep/data CSVs via Python.
 *
 *   node scripts/refresh-mp-snapshot.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = `
import csv, json, sys, os
sys.path.insert(0, os.path.join(${JSON.stringify(root)}, "maxprep", "deClaude"))
from mp_rating import Game, MAXPREPS_PARAMS, margin_power_rating, to_maxpreps_scale
from mp_whatif import what_if, pool_for, rank_in_pool, drop_wins_vs, add_game

root = ${JSON.stringify(root)}
games = []
with open(os.path.join(root, "maxprep/data/ut_girls_soccer_2026.csv")) as fh:
    for row in csv.DictReader(fh):
        if row.get("home_score") in (None, "", "None") or row.get("away_score") in (None, "", "None"):
            continue
        games.append({
            "date": row["date"],
            "home": row["home_team"].strip(),
            "away": row["away_team"].strip(),
            "home_score": int(row["home_score"]),
            "away_score": int(row["away_score"]),
            "neutral": str(row.get("neutral", "")).lower() in ("1", "true", "yes"),
            "is_forfeit": str(row.get("is_forfeit", "")).lower() in ("1", "true", "yes"),
            "is_deleted": str(row.get("is_deleted", "")).lower() in ("1", "true", "yes"),
            "pk_winner": (row.get("pk_winner") or "").strip().lower() or None,
        })
teams = []
with open(os.path.join(root, "maxprep/data/ut_girls_soccer_2026_teams.csv")) as fh:
    for row in csv.DictReader(fh):
        teams.append({
            "team_id": row["team_id"].strip(),
            "display_name": row["display_name"].strip(),
            "classification": (row.get("classification") or "").strip(),
            "is_our_team": str(row.get("is_our_team", "")).lower() in ("1", "true", "yes"),
        })

gobjs = [Game(**g) for g in games]
classes = {t["display_name"]: t["classification"] for t in teams if t["classification"]}
rate = lambda gs: to_maxpreps_scale(margin_power_rating(gs, **MAXPREPS_PARAMS))
base = rate(gobjs)
team = "Brighton"
pool = pool_for(team, classes)
fixtures = {
    "params": MAXPREPS_PARAMS,
    "baseline": {
        "team": team,
        "rating": round(base[team], 6),
        "rank": rank_in_pool(team, base, pool),
        "n_games": len(gobjs),
        "n_teams": len(base),
    },
    "what_if": [],
}
for opp, gf, ga, pk in [("Lone Peak", 2, 1, None), ("Lone Peak", 1, 2, None), ("Cyprus", 5, 0, None),
                        ("Orem", 1, 2, None), ("Lone Peak", 1, 1, True), ("Lone Peak", 1, 1, False)]:
    row = what_if(gobjs, team, opp, gf, ga, model="margin", classes=classes, pk_win=pk)
    row["pk_win"] = pk
    fixtures["what_if"].append(row)

remaining, dropped = drop_wins_vs(gobjs, team, "Orem")
swapped = add_game(remaining, team, "Lone Peak", 1, 2)
new_r = rate(swapped)
fixtures["swap_orem_for_lone_peak_loss"] = {
    "drop": "Orem",
    "add": "Lone Peak",
    "score": "1-2",
    "dropped": len(dropped),
    "rank_before": rank_in_pool(team, base, pool),
    "rank_after": rank_in_pool(team, new_r, pool),
    "rating_before": round(base[team], 6),
    "rating_after": round(new_r[team], 6),
}

snap_path = os.path.join(root, "supabase/functions/_shared/mp/season_snapshot.json")
fix_path = os.path.join(root, "tests/fixtures/freeman_whatif.json")
os.makedirs(os.path.dirname(snap_path), exist_ok=True)
os.makedirs(os.path.dirname(fix_path), exist_ok=True)
with open(snap_path, "w") as fh:
    json.dump({"teams": teams, "games": games, "as_of": "2026-10-03"}, fh, separators=(",", ":"))
with open(fix_path, "w") as fh:
    json.dump(fixtures, fh, indent=2)
print("wrote", snap_path, "games", len(games), "teams", len(teams))
print("wrote", fix_path)
`;

const r = spawnSync("python3", ["-c", py], { cwd: root, encoding: "utf8" });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
