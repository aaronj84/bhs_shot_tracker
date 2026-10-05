/**
 * Freeman-style capped-margin least-squares power rating (MaxPreps.com family).
 * Port of maxprep/deClaude/mp_rating.margin_power_rating — keep in sync.
 * Pure JS; usable from Deno edge functions and Node/Vitest.
 */

/**
 * @typedef {{ date: string, home: string, away: string, home_score: number, away_score: number, neutral?: boolean, is_forfeit?: boolean }} Game
 */

/**
 * @param {Game[]} games
 * @returns {Game[]}
 */
export function dropForfeits(games) {
  return games.filter((g) => !g.is_forfeit);
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
 * @param {Game} g
 * @returns {number}
 */
function margin(g) {
  return g.home_score - g.away_score;
}

/**
 * Ratings on a goals scale. Predicted margin for home = r_h - r_a + hfa.
 * Observed margin is clipped to +/- cap before fitting.
 *
 * @param {Game[]} games
 * @param {{ cap?: number, ridge?: number, homeAdv?: number|null, resultBonus?: number, maxIter?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function marginPowerRating(games, opts = {}) {
  const cap = opts.cap ?? 5.0;
  const ridge = opts.ridge ?? 1.0;
  const resultBonus = opts.resultBonus ?? 0.0;
  const maxIter = opts.maxIter ?? 200;
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
    let marg = Math.max(-cap, Math.min(cap, margin(g)));
    if (resultBonus) {
      const s = Math.sign(margin(g));
      marg += resultBonus * s;
    }
    y[i] = marg;
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

  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, i] of Object.entries(idx)) out[name] = r[i];
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
 * @param {{ date?: string, neutral?: boolean }} [opts]
 * @returns {Game[]}
 */
export function addGame(games, team, opponent, goalsFor, goalsAgainst, opts = {}) {
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
    },
  ];
}

/**
 * @param {Game} game
 * @param {string} team
 * @param {string} opponent
 */
function teamWon(game, team, opponent) {
  if (game.is_forfeit) return false;
  if (game.home === team && game.away === opponent) return game.home_score > game.away_score;
  if (game.away === team && game.home === opponent) return game.away_score > game.home_score;
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
 * @param {{ classes?: Record<string, string>|null, ratingOpts?: object, baseline?: { ratings: Record<string, number>, rank: number }|null }} [opts]
 */
export function whatIf(games, team, opponent, goalsFor, goalsAgainst, opts = {}) {
  const classes = opts.classes ?? null;
  const ratingOpts = opts.ratingOpts || { cap: 5, ridge: 1, resultBonus: 1, homeAdv: null };
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
    addGame(games, team, opponent, goalsFor, goalsAgainst),
    ratingOpts,
  );
  const newRank = rankInPool(team, newR, pool);

  return {
    model: "freeman",
    opponent,
    opp_rating: round4(baseR[opponent]),
    score: `${goalsFor}-${goalsAgainst}`,
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
 * @param {{ classes?: Record<string, string>|null, ratingOpts?: object }} [opts]
 */
export function swapResult(games, team, drop, add, goalsFor, goalsAgainst, opts = {}) {
  const classes = opts.classes ?? null;
  const ratingOpts = opts.ratingOpts || { cap: 5, ridge: 1, resultBonus: 1, homeAdv: null };
  const pool = poolFor(team, classes);
  const { kept, dropped } = dropWinsVs(games, team, drop);
  if (!dropped.length) {
    return {
      ok: false,
      error: `No win vs ${drop} in the season data. Cannot swap a result that is not there.`,
    };
  }
  const swapped = addGame(kept, team, add, goalsFor, goalsAgainst);
  const baseR = marginPowerRating(games, ratingOpts);
  const newR = marginPowerRating(swapped, ratingOpts);
  const before = rankInPool(team, baseR, pool);
  const after = rankInPool(team, newR, pool);
  return {
    ok: true,
    model: "freeman",
    drop,
    add,
    score: `${goalsFor}-${goalsAgainst}`,
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
