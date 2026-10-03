#!/usr/bin/env bash
# Build the LaTeX paper: figures (if missing) + tectonic + word count.
set -euo pipefail
cd "$(dirname "$0")"

[ -f figs/fig2-architecture.pdf ] || node svg2pdf.js

tectonic main.tex

# Approximate main-text word count against the 2,500–4,000 window.
# TO WRITE boxes are excluded (they are notes, not prose); so are tables,
# captions, the bibliography, and LaTeX commands.
python3 - <<'EOF'
import re
src = open("main.tex", encoding="utf-8").read()
body = src.split(r"\begin{document}", 1)[1]
todos = len(re.findall(r"\\begin\{towrite\}", body))
body = re.sub(r"\\begin\{towrite\}.*?\\end\{towrite\}", " ", body, flags=re.S)
body = re.sub(r"\\begin\{table\}.*?\\end\{table\}", " ", body, flags=re.S)
body = re.sub(r"\\caption\{[^}]*\}", " ", body)
body = re.sub(r"%.*", " ", body)
body = re.sub(r"\\bibliograph\w+\{[^}]*\}", " ", body)
body = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^{}]*\})?", " ", body)
body = re.sub(r"[{}~$&\\]", " ", body)
n = len(body.split())
print(f"word count — main text (prose outside TO WRITE boxes): {n}")
lo, hi = 2500, 4000
if n < lo:   print(f"  → {lo - n} words below the 2,500 minimum")
elif n > hi: print(f"  ⚠ {n - hi} words OVER the 4,000 limit — trim before submitting")
else:        print("  ✓ within the 2,500–4,000 window")
if todos:    print(f"  ⚠ {todos} TO WRITE box(es) remain — not submittable yet")
EOF
