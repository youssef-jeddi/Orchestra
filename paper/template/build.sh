#!/usr/bin/env bash
# Build the paper PDF from paper.html (Brave/Chromium headless + paged.js).
# Usage: ./build.sh          → paper/template/paper.pdf + word count report
set -euo pipefail
cd "$(dirname "$0")"

BROWSER="${BROWSER_BIN:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
OUT="paper.pdf"
PORT="${PORT:-8971}"

# paged.js fetches the stylesheet, and Chromium blocks fetch() on file:// —
# serve the template over localhost for the duration of the print.
# Serve from the paper/ parent so ../figures/ resolves.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory .. >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1

BROWSER_BIN="$BROWSER" node render.js "http://127.0.0.1:$PORT/template/paper.html" "$OUT"

echo "✓ wrote $(pwd)/$OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"

# ── Word count (competition window: 2,500–4,000) + TODO check ──
python3 - <<'EOF'
import re, html as h
src = open("paper.html", encoding="utf-8").read()
body = re.search(r"<main>(.*?)</main>", src, re.S).group(1)

todos = len(re.findall(r'class="todo"', src))

def words(fragment: str) -> int:
    fragment = re.sub(r"<(div|p|li|figcaption)[^>]*class=\"todo\"[^>]*>.*?</\1>", " ", fragment, flags=re.S)
    fragment = re.sub(r"<script.*?</script>", " ", fragment, flags=re.S)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return len(h.unescape(fragment).split())

refs = re.search(r'<section class="references">(.*?)</section>', body, re.S)
refs_w = words(refs.group(1)) if refs else 0
figcaps = sum(words(m) for m in re.findall(r"<figcaption>(.*?)</figcaption>", body, re.S))
tables = sum(words(m) for m in re.findall(r'<div class="table-block">(.*?)</div>', body, re.S))
total = words(body)
main_text = total - refs_w - figcaps - tables

print(f"word count — main text: {main_text}  (+{figcaps} captions, +{tables} tables, +{refs_w} references)")
lo, hi = 2500, 4000
if main_text < lo:   print(f"  → {lo - main_text} words below the 2,500 minimum")
elif main_text > hi: print(f"  ⚠ {main_text - hi} words OVER the 4,000 limit — trim before submitting")
else:                print(f"  ✓ within the 2,500–4,000 window")
if todos:            print(f"  ⚠ {todos} TODO placeholder(s) still in the document — not submittable yet")
EOF
