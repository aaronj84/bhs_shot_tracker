/**
 * Unit tests for Freeman what-if (pinned to Python mp_rating / mp_whatif fixtures).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  marginPowerRating,
  poolFor,
  rankInPool,
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

const RATING_OPTS = { cap: 5, ridge: 1, resultBonus: 1, homeAdv: null };

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
      const [gf, ga] = expected.score.split("-").map(Number);
      const got = whatIf(snapshot.games, "Brighton", expected.opponent, gf, ga, {
        classes,
        ratingOpts: RATING_OPTS,
      });
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
