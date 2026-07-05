#!/usr/bin/env bash
# Determinism, shown as a picture. Renders the SAME page twice with each tool,
# then subtracts each tool's two runs from each other:
#   ours  run1 - run2  -> PURE BLACK  (byte-identical: seeded RNG + frozen clock)
#   PW    run1 - run2  -> BRIGHT NOISE (its runs diverge: real randomness + real-time)
# Output: out/compare.mp4 (left = Playwright's self-diff, right = ours). The image
# does the talking -- black vs confetti. Also prints a numeric verdict.
#
#   bash compare.sh                     # default: ../demo-av.html
#   bash compare.sh <page> <secs> <fps>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/out"; mkdir -p "$OUT"
cd "$ROOT"

TARGET="${1:-$ROOT/demo-av.html}"; DUR="${2:-5}"; FPS="${3:-30}"
fmd5(){ ffmpeg -v error -i "$1" -f framemd5 - 2>/dev/null | grep -oE '[0-9a-f]{32}'; }
verdict(){ paste <(fmd5 "$1") <(fmd5 "$2") | awk '$1!=$2{n++} END{d=n+0; print (d==0? "IDENTICAL — 0 of "NR" frames differ" : "DIFFERENT — "d" of "NR" frames differ")}'; }

# Playwright's built-in recordVideo (real-time). A local file is served on an
# ephemeral 127.0.0.1 server (Playwright only navigates to URLs). args via env.
record_pw(){ PW_OUT="$1" PW_URL="$2" PW_SECS="$DUR" node - <<'NODE'
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), http = require("http");
const TARGET = process.env.PW_URL, SECS = Number(process.env.PW_SECS || 5), OUT = process.env.PW_OUT;
const W = 1280, H = 720;
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".mp4":"video/mp4",
  ".webm":"video/webm", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".json":"application/json" };
function resolveTarget(t) {
  if (/^https?:\/\//i.test(t)) return Promise.resolve({ url: t, close: () => {} });
  const file = path.resolve(t), dir = path.dirname(file);
  const srv = http.createServer((q, r) => {
    const p = path.join(dir, decodeURIComponent(q.url.split("?")[0]));
    fs.createReadStream(p)
      .on("open", () => r.setHeader("content-type", MIME[path.extname(p).toLowerCase()] || "application/octet-stream"))
      .on("error", () => { r.statusCode = 404; r.end(); }).pipe(r);
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () =>
    res({ url: `http://127.0.0.1:${srv.address().port}/${path.basename(file)}`, close: () => srv.close() })));
}
(async () => {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const { url, close } = await resolveTarget(TARGET);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: path.dirname(path.resolve(OUT)), size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => console.error("  (goto:", e.message + ")"));
  await page.waitForTimeout(SECS * 1000);
  const video = page.video();
  await ctx.close(); await browser.close();
  fs.renameSync(await video.path(), path.resolve(OUT));
  close();
})().catch((e) => { console.error(e); process.exit(1); });
NODE
}

echo "Target: $TARGET  (${DUR}s @ ${FPS}fps, each tool run twice)"

# Ours pins the network so LIVE sites are reproducible, not just self-contained
# local pages: run 1 RECORDS a HAR and run 2 REPLAYS it, so both runs see the
# exact same bytes (frozen clock + seeded RNG can't fix bytes that arrive
# different -- A/B tests, rotating hero content, cache-bust tokens). This rides
# the tool's --baseline lifecycle (no standalone --har flag):
#   run1: --update-baseline -> records base.har + saves run1 as base.mp4
#   run2: (baseline exists)  -> replays base.har, diffs run2 vs base.mp4(==run1)
# A stale base.har from a previous target would replay the WRONG site, so clear
# it first. No effect on local files (bytes were already stable). Caveat: if
# TARGET trips a bot wall, stealth disables HAR -> live network -> runs diverge.
echo "== render OURS twice (run 1 records the network, run 2 replays it) =="
rm -f "$OUT/base.mp4" "$OUT/base.har"
node render.js "$TARGET" --duration "$DUR" --fps "$FPS" --baseline "$OUT/base.mp4" --update-baseline --out "$OUT/ours-run1.mp4" >/dev/null 2>&1
[ -s "$OUT/ours-run1.mp4" ] || { echo "render run1 failed"; exit 1; }
# --baseline also gates run2 with a regression diff (soft exit 1); we don't abort
# on that -- the framemd5 verdict below is the real signal -- only on a missing file.
node render.js "$TARGET" --duration "$DUR" --fps "$FPS" --baseline "$OUT/base.mp4" --out "$OUT/ours-run2.mp4" >/dev/null 2>&1
[ -s "$OUT/ours-run2.mp4" ] || { echo "render run2 failed"; exit 1; }
OURS="$(verdict "$OUT/ours-run1.mp4" "$OUT/ours-run2.mp4")"

echo "== record PLAYWRIGHT twice =="
record_pw "$OUT/playwright-run1.webm" "$TARGET" || exit 1
record_pw "$OUT/playwright-run2.webm" "$TARGET" || exit 1
PW="$(verdict "$OUT/playwright-run1.webm" "$OUT/playwright-run2.webm")"

echo "== build compare.mp4 (each tool: run1 minus run2) =="
L="Playwright: run 1 - run 2"; R="ours: run 1 - run 2"
N="scale=640:360,fps=$FPS,format=gbrp,setsar=1"
# Difference-blend each tool's two runs; hstack. Factual labels only; fall back to no labels.
ffmpeg -y -v error -i "$OUT/playwright-run1.webm" -i "$OUT/playwright-run2.webm" -i "$OUT/ours-run1.mp4" -i "$OUT/ours-run2.mp4" -filter_complex \
"[0:v]$N[a];[1:v]$N[b];[a][b]blend=all_mode=difference,drawtext=text='$L':x=10:y=10:fontcolor=white:box=1:boxcolor=black@0.6[pd];\
 [2:v]$N[c];[3:v]$N[d];[c][d]blend=all_mode=difference,drawtext=text='$R':x=10:y=10:fontcolor=white:box=1:boxcolor=black@0.6[od];\
 [pd][od]hstack=inputs=2:shortest=1,format=yuv420p[v]" -map "[v]" -pix_fmt yuv420p -t "$DUR" "$OUT/compare.mp4" 2>/dev/null \
|| ffmpeg -y -v error -i "$OUT/playwright-run1.webm" -i "$OUT/playwright-run2.webm" -i "$OUT/ours-run1.mp4" -i "$OUT/ours-run2.mp4" -filter_complex \
   "[0:v]$N[a];[1:v]$N[b];[a][b]blend=all_mode=difference[pd];[2:v]$N[c];[3:v]$N[d];[c][d]blend=all_mode=difference[od];[pd][od]hstack=inputs=2:shortest=1,format=yuv420p[v]" \
   -map "[v]" -pix_fmt yuv420p -t "$DUR" "$OUT/compare.mp4"

echo
echo "================= RESULT ================="
echo "  compare video (run1 - run2) : $OUT/compare.mp4"
echo "     left  = Playwright  -> bright noise (its two runs differ)"
echo "     right = ours        -> black        (its two runs are identical)"
echo "  OURS,       run 1 vs 2 : $OURS"
echo "  PLAYWRIGHT, run 1 vs 2 : $PW"
echo "=========================================="

# base.mp4 is just a byte-identical copy of ours-run1.mp4 (baseline plumbing for
# HAR replay); base.har is the recorded network. Neither is a distinct result, so
# remove them. The per-tool run files are kept for inspection.
rm -f "$OUT/base.mp4" "$OUT/base.har"