"""Box vs. outside-the-box shot value, end of regular season.

Stdlib only:  python3 "recorded data/box_vs_distance_analysis.py"
"""
import csv
import math
import random
from collections import defaultdict
from pathlib import Path

CSV = Path(__file__).with_name("shot-data-end-of-regular-season.csv")
random.seed(7)


def load():
    rows = list(csv.DictReader(CSV.open()))
    for r in rows:
        for k in ("is_shot", "is_pk", "is_on_frame", "is_goal", "in_box", "is_home"):
            r[k] = r[k] == "true"
        r["x"], r["y"] = float(r["x"]), float(r["y"])
        r["dist"] = float(r["goal_dist_yd"])
        r["angle"] = float(r["goal_angle_deg"])
        r["blocked"] = r["result"] == "blocked"
    return rows


def wilson(k, n, z=1.96):
    if n == 0:
        return (0, 0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def fisher_one_sided(a, b, c, d):
    """P(X >= a) for 2x2 [[a,b],[c,d]] (row1 = box)."""
    n1, n2, m = a + b, c + d, a + c
    N = n1 + n2
    tot = math.comb(N, m)
    return sum(math.comb(n1, k) * math.comb(n2, m - k) for k in range(a, min(n1, m) + 1)) / tot


def logit_fit(X, y, iters=50):
    """IRLS logistic regression. X rows include intercept."""
    p = len(X[0])
    beta = [0.0] * p
    for _ in range(iters):
        g = [0.0] * p
        H = [[0.0] * p for _ in range(p)]
        for xi, yi in zip(X, y):
            eta = sum(b * v for b, v in zip(beta, xi))
            mu = 1 / (1 + math.exp(-eta))
            w = mu * (1 - mu)
            for j in range(p):
                g[j] += (yi - mu) * xi[j]
                for k in range(p):
                    H[j][k] += w * xi[j] * xi[k]
        step = solve(H, g)
        beta = [b + s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < 1e-9:
            break
    return beta


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                M[r] = [a - f * c for a, c in zip(M[r], M[i])]
    return [M[i][n] / M[i][i] for i in range(n)]


def pred(beta, xi):
    return 1 / (1 + math.exp(-sum(b * v for b, v in zip(beta, xi))))


def summarize(label, shots):
    n = len(shots)
    g = sum(s["is_goal"] for s in shots)
    on = sum(s["is_on_frame"] for s in shots)
    bl = sum(s["blocked"] for s in shots)
    lo, hi = wilson(g, n)
    conv_on = f"{g / on:5.1%}" if on else "  -  "
    print(
        f"  {label:<28} n={n:3d}  goals={g:2d}  G/shot={g / n if n else 0:5.1%} "
        f"[{lo:4.1%}-{hi:4.1%}]  onFrame={on / n if n else 0:5.1%}  "
        f"blocked={bl / n if n else 0:5.1%}  G/onFrame={conv_on}  avgDist={sum(s['dist'] for s in shots) / max(n, 1):4.1f}yd"
    )
    return n, g


def bucket(s):
    if s["in_box"]:
        return "1 box: 0-9yd" if s["dist"] < 9 else "2 box: 9yd+"
    if s["y"] < 18:
        return "3 outside: wide of box"
    return "4 outside: 18-27yd" if s["dist"] < 27 else "5 outside: 27yd+"


def analyze(shots, games, title):
    print(f"\n{'=' * 100}\n{title}\n  games={len(games)}  shots={len(shots)}  shots/game={len(shots) / len(games):.1f}")

    box = [s for s in shots if s["in_box"]]
    out = [s for s in shots if not s["in_box"]]
    print("\nIn box vs outside (penalties excluded):")
    nb, gb = summarize("IN BOX", box)
    no, go = summarize("OUTSIDE BOX", out)
    print(f"  outside share of shots: {no / (nb + no):.0%}   outside share of goals: {go / max(gb + go, 1):.0%}")
    p = fisher_one_sided(gb, nb - gb, go, no - go)
    print(f"  Fisher exact (box converts better), one-sided p = {p:.3f}")
    rin, rout = gb / nb, go / no
    print(f"  ratio box/outside G/shot = {rin / rout:.2f}x" if rout else "  outside goals = 0")

    print("\nFiner buckets:")
    by = defaultdict(list)
    for s in shots:
        by[bucket(s)].append(s)
    for k in sorted(by):
        summarize(k[2:], by[k])

    print("\nBy distance band (shot_range):")
    for band in ("0-9", "9-18", "18-27", "27+"):
        summarize(band + " yd", [s for s in shots if s["shot_range"] == band])

    # Distance/angle logistic model -> smooth xG
    X = [[1.0, s["dist"]] for s in shots]
    y = [1 if s["is_goal"] else 0 for s in shots]
    b = logit_fit(X, y)
    print(f"\nLogistic xG(distance): logit = {b[0]:.2f} + {b[1]:.3f}*yd")
    for d in (6, 10, 14, 18, 22, 26, 30, 35, 40):
        print(f"  {d:2d} yd -> {pred(b, [1, d]):5.1%}")
    xg_box = sum(pred(b, [1, s['dist']]) for s in box)
    xg_out = sum(pred(b, [1, s['dist']]) for s in out)
    print(f"  model xG: box {xg_box:.1f} (actual {gb})  outside {xg_out:.1f} (actual {go})")

    # Trade-off: how many outside shots is one box shot worth?
    print("\nTrade-off math (per game):")
    G = len(games)
    out_pg, box_pg = no / G, nb / G
    print(f"  current: {box_pg:.1f} box shots + {out_pg:.1f} outside shots = {(gb + go) / G:.2f} goals/game (non-PK)")
    if rout:
        m = rin / rout
        print(f"  break-even: 1 box shot = {m:.1f} outside shots of value")
        for conv in (0.25, 0.5):
            give_up = out_pg * conv
            for kept in (1.0, 0.5, 1 / m):
                gained_box = give_up * kept
                new_goals = (gb + go) / G - give_up * rout + gained_box * rin
                print(
                    f"  pass up {conv:.0%} of outside shots ({give_up:.1f}/g), turn {kept:4.0%} of those into box shots"
                    f" -> {box_pg + gained_box + out_pg - give_up:4.1f} shots/g, {new_goals:.2f} goals/g"
                )

    # Cluster bootstrap by game for the box/outside ratio
    by_game = defaultdict(list)
    for s in shots:
        by_game[s["game_id"]].append(s)
    gids = list(by_game)
    ratios, diffs = [], []
    for _ in range(5000):
        samp = [s for gid in random.choices(gids, k=len(gids)) for s in by_game[gid]]
        bb = [s for s in samp if s["in_box"]]
        oo = [s for s in samp if not s["in_box"]]
        if not bb or not oo:
            continue
        ri = sum(s["is_goal"] for s in bb) / len(bb)
        ro = sum(s["is_goal"] for s in oo) / len(oo)
        diffs.append(ri - ro)
        if ro > 0:
            ratios.append(ri / ro)
    diffs.sort()
    ratios.sort()
    q = lambda a, p: a[int(p * (len(a) - 1))]
    print(
        f"\n  game-cluster bootstrap: box minus outside G/shot = {q(diffs, .5):+.1%} "
        f"[95%: {q(diffs, .025):+.1%} to {q(diffs, .975):+.1%}],  P(box better) = {sum(d > 0 for d in diffs) / len(diffs):.0%}"
    )
    if ratios:
        print(f"  break-even multiple (box/outside) median {q(ratios, .5):.1f}x [80%: {q(ratios, .1):.1f}x-{q(ratios, .9):.1f}x]")

    print("\nPer game:")
    print(f"  {'date':<10} {'opp':<12} {'shots':>5} {'box':>4} {'out':>4} {'out%':>5} {'Gbox':>4} {'Gout':>4}")
    for gid in sorted(by_game, key=lambda g: by_game[g][0]["game_date"]):
        ss = by_game[gid]
        bx = [s for s in ss if s["in_box"]]
        ox = [s for s in ss if not s["in_box"]]
        print(
            f"  {ss[0]['game_date']:<10} {ss[0]['opponent_name']:<12} {len(ss):5d} {len(bx):4d} {len(ox):4d} "
            f"{len(ox) / len(ss):5.0%} {sum(s['is_goal'] for s in bx):4d} {sum(s['is_goal'] for s in ox):4d}"
        )

    print("\nOutside-box shooters (min 4 outside shots):")
    byp = defaultdict(list)
    for s in shots:
        byp[s["player_name"]].append(s)
    rows = []
    for pl, ss in byp.items():
        ox = [s for s in ss if not s["in_box"]]
        bx = [s for s in ss if s["in_box"]]
        if len(ox) >= 4:
            rows.append((len(ox), pl, len(bx), sum(s["is_goal"] for s in ox), sum(s["is_goal"] for s in bx),
                         sum(s["is_on_frame"] for s in ox)))
    for no_, pl, nb_, go_, gb_, of in sorted(rows, reverse=True):
        print(f"  {pl:<10} outside {no_:2d} (goals {go_}, on frame {of})   box {nb_:2d} (goals {gb_})")

    print("\nBox shots: assisted vs unassisted:")
    summarize("box, assisted", [s for s in box if s["assist_type"] != "null"])
    summarize("box, unassisted", [s for s in box if s["assist_type"] == "null"])
    print("Outside shots: assisted vs unassisted:")
    summarize("outside, assisted", [s for s in out if s["assist_type"] != "null"])
    summarize("outside, unassisted", [s for s in out if s["assist_type"] == "null"])


def main():
    rows = load()
    shots_all = [r for r in rows if r["is_shot"]]
    bad = [r for r in shots_all if r["x"] == 0 and r["y"] == 0]
    pks = [r for r in shots_all if r["is_pk"]]
    shots = [r for r in shots_all if not r["is_pk"] and r not in bad]
    print(f"rows={len(rows)}  shot rows={len(shots_all)}  PKs={len(pks)}  bad-coord={len(bad)}  "
          f"non-shot rows={len(rows) - len(shots_all)}")

    games_all = {r["game_id"] for r in rows}
    analyze(shots, games_all, "ALL GAMES (incl. preseason Morgan)")
    off = [s for s in shots if s["stat_scope"] == "official"]
    games_off = {r["game_id"] for r in rows if r["stat_scope"] == "official"}
    analyze(off, games_off, "OFFICIAL GAMES ONLY")


if __name__ == "__main__":
    main()
