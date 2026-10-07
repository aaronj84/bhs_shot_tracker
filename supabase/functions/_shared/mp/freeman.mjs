/**
 * Freeman-style capped-margin least-squares power rating (MaxPreps.com family).
 * Port of maxprep/deClaude/mp_rating.margin_power_rating — keep in sync.
 * Pure JS; usable from Deno edge functions and Node/Vitest.
 */

/**
 * pk_winner: UHSAA has no ties. A level game goes to PKs; MaxPreps keeps the
 * level score and credits the shootout winner. null only for a true draw.
 * is_deleted: contest MaxPreps deleted (still on a team schedule); not rated.
 *
 * @typedef {{ date: string, home: string, away: string, home_score: number, away_score: number, neutral?: boolean, is_forfeit?: boolean, is_deleted?: boolean, pk_winner?: "home"|"away"|null }} Game
 */

/**
 * Fit against MaxPreps' published UT girls ratings (5A on 2026-10-07 and the
 * statewide 2026-09-13 snapshot): RMSE 0.14 rating points on 5A. A win is
 * worth ~13.7 MaxPreps points, each goal of margin ~1.4 up to 4 goals, a PK
 * win about like a 1-goal win, no home edge.
 */
export const MAXPREPS_RATING_OPTS = Object.freeze({
  cap: 4,
  ridge: 1,
  resultBonus: 10,
  pkMargin: 1,
  homeAdv: 0,
  scale: Object.freeze({ slope: 1.366, offset: 0.238 }),
});

/**
 * Games MaxPreps rates: no forfeits, no deleted contests.
 * @param {Game[]} games
 * @returns {Game[]}
 */
export function dropForfeits(games) {
  return games.filter((g) => !g.is_forfeit && !g.is_deleted);
}

/**
 * +1 home won (in regulation, overtime, or on PKs), -1 away won, 0 true draw.
 * @param {Game} g
 */
export function resultSign(g) {
  const m = g.home_score - g.away_score;
  if (m !== 0) return Math.sign(m);
  if (g.pk_winner === "home") return 1;
  if (g.pk_winner === "away") return -1;
  return 0;
}

/**
 * @param {Game[]} games
 * @returns {Record<string, number>}
 */
export function teamIndex(games) {
  const names = [
    ...new Set(games.flatMap((g) => [g.home, g.away])),
  ].sort();
  /** @type {Record<string, number>} */
  const idx = {};
  names.forEach((n, i) => {
    idx[n] = i;
  });
  return idx;
}

/**
 * Margin fed to the fit: capped goal difference, a PK win counted as
 * pkMargin goals, plus resultBonus toward the winner.
 *
 * @param {Game} g
 * @param {number} cap
 * @param {number} resultBonus
 * @param {number} pkMargin
 * @returns {number}
 */
function fitMargin(g, cap, resultBonus, pkMargin) {
  const s = resultSign(g);
  const raw = g.home_score - g.away_score;
  const goals = raw === 0 ? pkMargin * s : raw;
  return Math.max(-cap, Math.min(cap, goals)) + resultBonus * s;
}

/**
 * Ratings on a goals scale, or on the MaxPreps rating scale when
 * opts.scale is set. Predicted margin for home = r_h - r_a + hfa.
 * Observed margin is clipped to +/- cap before fitting.
 *
 * @param {Game[]} games
 * @param {{ cap?: number, ridge?: number, homeAdv?: number|null, resultBonus?: number, pkMargin?: number, scale?: { slope: number, offset: number }|null, maxIter?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function marginPowerRating(games, opts = {}) {
  const cap = opts.cap ?? 5.0;
  const ridge = opts.ridge ?? 1.0;
  const resultBonus = opts.resultBonus ?? 0.0;
  const pkMargin = opts.pkMargin ?? 0.0;
  const scale = opts.scale ?? null;
  const maxIter = opts.maxIter ?? 1000;
  const homeAdvOpt = opts.homeAdv === undefined ? null : opts.homeAdv;

  const clean = dropForfeits(games);
  const idx = teamIndex(clean);
  const n = Object.keys(idx).length;
  if (n === 0) return {};

  const estHfa = homeAdvOpt === null || homeAdvOpt === undefined;
  let hfa = estHfa ? 0.0 : Number(homeAdvOpt);

  const m = clean.length;
  const y = new Float64Array(m);
  const hi = new Int32Array(m);
  const ai = new Int32Array(m);
  const atHome = new Float64Array(m);
  const weights = new Float64Array(m);

  for (let i = 0; i < m; i += 1) {
    const g = clean[i];
    hi[i] = idx[g.home];
    ai[i] = idx[g.away];
    atHome[i] = g.neutral ? 0.0 : 1.0;
    weights[i] = 1.0;
    y[i] = fitMargin(g, cap, resultBonus, pkMargin);
  }

  let r = new Float64Array(n);
  for (let iter = 0; iter < maxIter; iter += 1) {
    const num = new Float64Array(n);
    const den = new Float64Array(n);
    for (let t = 0; t < n; t += 1) den[t] = ridge;
    for (let i = 0; i < m; i += 1) {
      const target = y[i] - hfa * atHome[i];
      const w = weights[i];
      num[hi[i]] += w * (target + r[ai[i]]);
      den[hi[i]] += w;
      num[ai[i]] += w * (r[hi[i]] - target);
      den[ai[i]] += w;
    }
    const newR = new Float64Array(n);
    let mean = 0;
    for (let t = 0; t < n; t += 1) {
      newR[t] = num[t] / den[t];
      mean += newR[t];
    }
    mean /= n;
    let delta = 0;
    for (let t = 0; t < n; t += 1) {
      newR[t] -= mean;
      delta = Math.max(delta, Math.abs(newR[t] - r[t]));
    }
    r = newR;
    if (estHfa) {
      let wSum = 0;
      let residSum = 0;
      for (let i = 0; i < m; i += 1) {
        if (atHome[i] <= 0) continue;
        const resid = y[i] - (r[hi[i]] - r[ai[i]]);
        residSum += weights[i] * resid;
        wSum += weights[i];
      }
      if (wSum > 0) hfa = residSum / wSum;
    }
    if (delta < 1e-10) break;
  }

  const slope = scale ? scale.slope : 1;
  const offset = scale ? scale.offset : 0;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, i] of Object.entries(idx)) out[name] = slope * r[i] + offset;
  return out;
}

/**
 * @param {Record<string, number>} ratings
 * @param {string} team
 * @param {string[]|null|undefined} pool
 * @returns {number}
 */
export function rankInPool(team, ratings, pool) {
  const members = Object.keys(ratings).filter((t) => !pool || pool.includes(t));
  members.sort((a, b) => (ratings[b] ?? 0) - (ratings[a] ?? 0));
  const i = members.indexOf(team);
  return i >= 0 ? i + 1 : -1;
}

/**
 * @param {string} team
 * @param {Record<string, string>|null|undefined} classes
 * @returns {string[]|null}
 */
export function poolFor(team, classes) {
  if (!classes) return null;
  const my = classes[team];
  if (!my) return null;
  return Object.entries(classes)
    .filter(([, c]) => c === my)
    .map(([t]) => t);
}

/**
 * @param {Game[]} games
 * @param {string} team
 * @param {string} opponent
 * @param {number} goalsFor
 * @param {number} goalsAgainst
 * @param {{ date?: string, neutral?: boolean, pkWin?: boolean|null }} [opts]
 *   pkWin: for a level score, whether `team` won the shootout.
 * @returns {Game[]}
 */
export function addGame(games, team, opponent, goalsFor, goalsAgainst, opts = {}) {
  const level = goalsFor === goalsAgainst;
  const pkWin = opts.pkWin ?? null;
  return [
    ...games,
    {
      date: opts.date || "2099-01-01",
      home: team,
      away: opponent,
      home_score: goalsFor,
      away_score: goalsAgainst,
      neutral: opts.neutral !== false,
      is_forfeit: false,
      pk_winner: level && pkWin !== null ? (pkWin ? "home" : "away") : null,
    },
  ];
}

/**
 * @param {number} goalsFor
 * @param {number} goalsAgainst
 * @param {boolean|null|undefined} pkWin
 */
export function scoreLabel(goalsFor, goalsAgainst, pkWin) {
  const base = `${goalsFor}-${goalsAgainst}`;
  if (goalsFor !== goalsAgainst || pkWin == null) return base;
  return `${base} (${pkWin ? "won" : "lost"} on PKs)`;
}

/**
 * @param {Game} game
 * @param {string} team
 * @param {string} opponent
 */
function teamWon(game, team, opponent) {
  if (game.is_forfeit || game.is_deleted) return false;
  if (game.home === team && game.away === opponent) return resultSign(game) > 0;
  if (game.away === team && game.home === opponent) return resultSign(game) < 0;
  return false;
}

/**
 * Drop wins by `team` vs `opponent`. Returns { kept, dropped }.
 * @param {Game[]} games
 * @param {string} team
 * @param {string} opponent
 */
export function dropWinsVs(games, team, opponent) {
  /** @type {Game[]} */
  const kept = [];
  /** @type {Game[]} */
  const dropped = [];
  for (const g of games) {
    if (teamWon(g, team, opponent)) dropped.push(g);
    else kept.push(g);
  }
  return { kept, dropped };
}

/**
 * Effect of one hypothetical result on `team`'s rating and class seed.
 *
 * @param {Game[]} games
 * @param {string} team
 * @param {string} opponent
 * @param {number} goalsFor
 * @param {number} goalsAgainst
 * @param {{ classes?: Record<string, string>|null, ratingOpts?: object, baseline?: { ratings: Record<string, number>, rank: number }|null, pkWin?: boolean|null }} [opts]
 */
export function whatIf(games, team, opponent, goalsFor, goalsAgainst, opts = {}) {
  const classes = opts.classes ?? null;
  const ratingOpts = opts.ratingOpts || MAXPREPS_RATING_OPTS;
  const pkWin = opts.pkWin ?? null;
  const pool = poolFor(team, classes);

  let baseR;
  let baseRank;
  if (opts.baseline) {
    baseR = opts.baseline.ratings;
    baseRank = opts.baseline.rank;
  } else {
    baseR = marginPowerRating(games, ratingOpts);
    baseRank = rankInPool(team, baseR, pool);
  }

  const newR = marginPowerRating(
    addGame(games, team, opponent, goalsFor, goalsAgainst, { pkWin }),
    ratingOpts,
  );
  const newRank = rankInPool(team, newR, pool);

  return {
    model: "freeman",
    opponent,
    opp_rating: round4(baseR[opponent]),
    score: scoreLabel(goalsFor, goalsAgainst, pkWin),
    rating_before: round4(baseR[team] ?? 0),
    rating_after: round4(newR[team] ?? 0),
    rating_delta: round4((newR[team] ?? 0) - (baseR[team] ?? 0)),
    rank_before: baseRank,
    rank_after: newRank,
    rank_delta: baseRank - newRank,
  };
}

/**
 * Replace a win vs `drop` with a hypothetical result vs `add`.
 *
 * @param {Game[]} games
 * @param {string} team
 * @param {string} drop
 * @param {string} add
 * @param {number} goalsFor
 * @param {number} goalsAgainst
 * @param {{ classes?: Record<string, string>|null, ratingOpts?: object, pkWin?: boolean|null }} [opts]
 */
export function swapResult(games, team, drop, add, goalsFor, goalsAgainst, opts = {}) {
  const classes = opts.classes ?? null;
  const ratingOpts = opts.ratingOpts || MAXPREPS_RATING_OPTS;
  const pkWin = opts.pkWin ?? null;
  const pool = poolFor(team, classes);
  const { kept, dropped } = dropWinsVs(games, team, drop);
  if (!dropped.length) {
    return {
      ok: false,
      error: `No win vs ${drop} in the season data. Cannot swap a result that is not there.`,
    };
  }
  const swapped = addGame(kept, team, add, goalsFor, goalsAgainst, { pkWin });
  const baseR = marginPowerRating(games, ratingOpts);
  const newR = marginPowerRating(swapped, ratingOpts);
  const before = rankInPool(team, baseR, pool);
  const after = rankInPool(team, newR, pool);
  return {
    ok: true,
    model: "freeman",
    drop,
    add,
    score: scoreLabel(goalsFor, goalsAgainst, pkWin),
    dropped: dropped.length,
    rating_before: round4(baseR[team] ?? 0),
    rating_after: round4(newR[team] ?? 0),
    rating_delta: round4((newR[team] ?? 0) - (baseR[team] ?? 0)),
    rank_before: before,
    rank_after: after,
    rank_delta: before - after,
  };
}

/**
 * Top-N standings within classification pool.
 * @param {Record<string, number>} ratings
 * @param {string[]|null} pool
 * @param {number} [limit]
 */
export function standings(ratings, pool, limit = 16) {
  const members = Object.keys(ratings).filter((t) => !pool || pool.includes(t));
  members.sort((a, b) => (ratings[b] ?? 0) - (ratings[a] ?? 0));
  return members.slice(0, limit).map((t, i) => ({
    rank: i + 1,
    team: t,
    rating: round4(ratings[t]),
  }));
}

function round4(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(Number(n) * 10000) / 10000;
}
