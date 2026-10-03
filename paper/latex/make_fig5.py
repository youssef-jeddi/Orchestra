#!/usr/bin/env python3
"""Generate Figure 5 (unsafe-approval rate by category) from eval run JSONs.

Usage:
  python3 make_fig5.py <pre-fix-run.json> [post-fix-run.json]

Writes ../figures/fig5-results.svg, converts it to figs/fig5-results.pdf via
the existing node converter, and prints the post-fix column for Table 2.
Series colors are the validated categorical palette used by all paper figures.
"""
import json, subprocess, sys, os
from collections import defaultdict

INK, MUTED, RULE = "#1a1a19", "#52514e", "#d9d8d4"
SERIES = [  # (label, hex) — validated palette order (blue, orange, aqua)
    ("Gatekeeper LLM (pre-fix)", "#2a78d6"),
    ("Deterministic (pre-fix)", "#eb6834"),
    ("Deterministic (post-fix)", "#1baf7a"),
]

def unsafe_rates(path):
    d = json.load(open(path))
    llm, det, trials = defaultdict(int), defaultdict(int), defaultdict(int)
    for r in d["records"]:
        if r["expected"] != "ESCALATE":
            continue
        c = r["category"]
        trials[c] += 1
        if r["llm"]["verdict"] == "AUTO_EXECUTE":
            llm[c] += 1
        if r["det"]["verdict"] == "AUTO_EXECUTE":
            det[c] += 1
    return llm, det, trials

def main():
    pre = sys.argv[1]
    post = sys.argv[2] if len(sys.argv) > 2 else None
    llm_pre, det_pre, trials = unsafe_rates(pre)
    det_post = None
    if post:
        _, det_post, post_trials = unsafe_rates(post)
        assert dict(post_trials) == dict(trials), "pre/post corpora differ — rates not comparable"

    cats = sorted(trials, key=lambda c: -(llm_pre[c] + det_pre[c]))
    series = [(SERIES[0], llm_pre), (SERIES[1], det_pre)]
    if det_post is not None:
        series.append((SERIES[2], det_post))

    # ── layout ──
    LEFT, RIGHT, W = 190, 70, 900
    BAR_H, BAR_GAP, GROUP_GAP, TOP = 13, 3, 16, 64
    plot_w = W - LEFT - RIGHT
    n = len(series)
    group_h = n * BAR_H + (n - 1) * BAR_GAP
    H = TOP + len(cats) * (group_h + GROUP_GAP) + 40
    maxrate = max(
        (cnt[c] / trials[c] for (_, cnt) in series for c in cats if trials[c]),
        default=0.5,
    )
    scale = plot_w / max(0.55, maxrate * 1.15)

    s = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
         f'font-family="Helvetica Neue, Arial, sans-serif">',
         f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
    # legend
    lx = LEFT
    for (label, color), _ in series:
        s.append(f'<rect x="{lx}" y="20" width="11" height="11" rx="2" fill="{color}"/>')
        s.append(f'<text x="{lx+16}" y="30" font-size="11" fill="{INK}">{label}</text>')
        lx += 16 + 7 * len(label) + 26
    s.append(f'<text x="{LEFT}" y="52" font-size="10" font-style="italic" fill="{MUTED}">'
             f'unsafe-approval rate per category (attack trials auto-executed), 3 trials/case</text>')

    y = TOP
    for c in cats:
        cy = y + group_h / 2 + 4
        s.append(f'<text x="{LEFT-8}" y="{cy}" font-size="11" fill="{INK}" text-anchor="end">{c.replace("_"," ")}</text>')
        by = y
        for (label, color), cnt in series:
            rate = cnt[c] / trials[c] if trials[c] else 0
            w = max(rate * scale, 0)
            s.append(f'<rect x="{LEFT}" y="{by}" width="{w:.1f}" height="{BAR_H}" rx="2" fill="{color}"/>')
            lbl = f"{rate*100:.0f}% ({cnt[c]}/{trials[c]})" if cnt[c] else "0%"
            s.append(f'<text x="{LEFT + w + 6:.1f}" y="{by + BAR_H - 3}" font-size="10" fill="{MUTED}">{lbl}</text>')
            by += BAR_H + BAR_GAP
        y += group_h + GROUP_GAP
    s.append(f'<line x1="{LEFT}" y1="{TOP-6}" x2="{LEFT}" y2="{y-GROUP_GAP+6}" stroke="{RULE}" stroke-width="1"/>')
    s.append("</svg>")

    out_svg = os.path.join(os.path.dirname(__file__), "..", "figures", "fig5-results.svg")
    open(out_svg, "w").write("\n".join(s) + "\n")
    print(f"wrote {out_svg} (H={H})")

    # SVG → PDF via a one-off node call reusing the puppeteer converter pattern
    conv = f'''
const p = require("puppeteer-core"); const fs = require("fs");
(async () => {{
  const b = await p.launch({{executablePath: process.env.BROWSER_BIN || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true, args:["--disable-gpu"]}});
  const pg = await b.newPage();
  const svg = fs.readFileSync({json.dumps(os.path.abspath(out_svg))}, "utf-8");
  await pg.setContent(`<!DOCTYPE html><style>@page{{size:{W}px {H}px;margin:0}}body{{margin:0}}svg{{display:block;width:{W}px;height:{H}px}}</style>` + svg, {{waitUntil:"load"}});
  await pg.pdf({{path: "figs/fig5-results.pdf", width: "{W}px", height: "{H}px", printBackground: true, margin:{{top:0,right:0,bottom:0,left:0}}}});
  await b.close(); console.log("wrote figs/fig5-results.pdf");
}})().catch(e => {{ console.error(e); process.exit(1); }});
'''
    subprocess.run(["node", "-e", conv], check=True, cwd=os.path.dirname(os.path.abspath(__file__)))

    if det_post is not None:
        print("\nTable 2 post-fix column (paste into main.tex):")
        for c in cats:
            print(f"  {c}: {det_post[c]}")
        tot = sum(det_post[c] for c in cats)
        att = sum(trials[c] for c in cats)
        print(f"  total: {tot}/{att} ({100*tot/att:.1f}%)")

if __name__ == "__main__":
    main()
