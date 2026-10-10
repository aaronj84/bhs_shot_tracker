/**
 * Unit tests for Freeman what-if (pinned to Python mp_rating / mp_whatif fixtures).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAXPREPS_RATING_OPTS,
  dropForfeits,
  marginPowerRating,
  poolFor,
  rankInPool,
  resultSign,
  swapResult,
  whatIf,
} from "../../supabase/functions/_shared/mp/freeman.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = JSON.parse(
  readFileSync(join(root, "tests/fixtures/freeman_whatif.json"), "utf8"),
);
const snapshot = JSON.parse(
  readFileSync(
    join(root, "supabase/functions/_shared/mp/season_snapshot.json"),
    "utf8",
  ),
);

const RATING_OPTS = MAXPREPS_RATING_OPTS;

/** @param {string} home @param {string} away @param {number} hs @param {number} as @param {object} [extra] */
function game(home, away, hs, as, extra = {}) {
  return { date: "2026-09-01", home, away, home_score: hs, away_score: as, ...extra };
}

describe("freeman marginPowerRating", () => {
  it("matches Python baseline for Brighton in 5A", () => {
    const classes = Object.fromEntries(
      snapshot.teams
        .filter((t) => t.classification)
        .map((t) => [t.display_name, t.classification]),
    );
    const ratings = marginPowerRating(snapshot.games, RATING_OPTS);
    const pool = poolFor("Brighton", classes);
    const rank = rankInPool("Brighton", ratings, pool);
    expect(snapshot.games.length).toBe(fixtures.baseline.n_games);
    expect(Object.keys(ratings).length).toBe(fixtures.baseline.n_teams);
    expect(rank).toBe(fixtures.baseline.rank);
    expect(ratings.Brighton).toBeCloseTo(fixtures.baseline.rating, 4);
  });

  it("matches Python what-if deltas", () => {
    const classes = Object.fromEntries(
      snapshot.teams
        .filter((t) => t.classification)
        .map((t) => [t.display_name, t.classification]),
    );
    for (const expected of fixtures.what_if) {
      const [gf, ga] = expected.score.split(" ")[0].split("-").map(Number);
      const got = whatIf(snapshot.games, "Brighton", expected.opponent, gf, ga, {
        classes,
        ratingOpts: RATING_OPTS,
        pkWin: expected.pk_win,
      });
      expect(got.score).toBe(expected.score);
      expect(got.rank_before).toBe(expected.rank_before);
      expect(got.rank_after).toBe(expected.rank_after);
      expect(got.rank_delta).toBe(expected.rank_delta);
      expect(got.rating_delta).toBeCloseTo(expected.rating_delta, 3);
    }
  });

  it("matches Python Orem→Lone Peak early-season swap", () => {
    const classes = Object.fromEntries(
      snapshot.teams
        .filter((t) => t.classification)
        .map((t) => [t.display_name, t.classification]),
    );
    const expected = fixtures.swap_orem_for_lone_peak_loss;
    const got = swapResult(
      snapshot.games,
      "Brighton",
      expected.drop,
      expected.add,
      1,
      2,
      { classes, ratingOpts: RATING_OPTS },
    );
    expect(got.ok).toBe(true);
    expect(got.dropped).toBe(expected.dropped);
    expect(got.rank_before).toBe(expected.rank_before);
    expect(got.rank_after).toBe(expected.rank_after);
    expect(got.rating_before).toBeCloseTo(expected.rating_before, 4);
    expect(got.rating_after).toBeCloseTo(expected.rating_after, 4);
  });
});

describe("freeman PK results and deleted contests", () => {
  it("credits the shootout winner; only a missing pk_winner is a draw", () => {
    expect(resultSign(game("A", "B", 1, 1, { pk_winner: "home" }))).toBe(1);
    expect(resultSign(game("A", "B", 1, 1, { pk_winner: "away" }))).toBe(-1);
    expect(resultSign(game("A", "B", 1, 1))).toBe(0);
    expect(resultSign(game("A", "B", 0, 2, { pk_winner: null }))).toBe(-1);
  });

  it("rates a PK win above a draw, and a draw above a PK loss", () => {
    const base = [game("A", "C", 2, 0), game("B", "C", 2, 0)];
    const pkWin = marginPowerRating([...base, game("A", "B", 1, 1, { pk_winner: "home" })], RATING_OPTS);
    const draw = marginPowerRating([...base, game("A", "B", 1, 1)], RATING_OPTS);
    const pkLoss = marginPowerRating([...base, game("A", "B", 1, 1, { pk_winner: "away" })], RATING_OPTS);
    expect(pkWin.A).toBeGreaterThan(draw.A);
    expect(draw.A).toBeGreaterThan(pkLoss.A);
    expect(pkWin.A - pkWin.B).toBeGreaterThan(0);
  });

  it("drops deleted contests and forfeits from ratings", () => {
    const games = [
      game("A", "B", 2, 0),
      game("A", "C", 8, 0, { is_deleted: true }),
      game("B", "C", 3, 0, { is_forfeit: true }),
    ];
    expect(dropForfeits(games)).toHaveLength(1);
    expect(Object.keys(marginPowerRating(games, RATING_OPTS)).sort()).toEqual(["A", "B"]);
  });

  it("will not swap out a deleted win, but will swap a PK win", () => {
    const games = [
      game("Brighton", "Cyprus", 8, 0, { is_deleted: true }),
      game("Brighton", "Orem", 1, 1, { pk_winner: "home" }),
      game("Orem", "Cyprus", 1, 0),
    ];
    expect(swapResult(games, "Brighton", "Cyprus", "Orem", 1, 0).ok).toBe(false);
    const swapped = swapResult(games, "Brighton", "Orem", "Cyprus", 1, 1, { pkWin: false });
    expect(swapped.ok).toBe(true);
    expect(swapped.score).toBe("1-1 (lost on PKs)");
  });
});
