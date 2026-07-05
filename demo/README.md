# Determinism, as a picture: render.js vs Playwright recordVideo

Renders the same page **twice with each tool**, then subtracts each tool's two
runs from each other. The result is `out/compare.mp4`:

- **right = ours** → **pure black** — our two runs are byte-identical (seeded RNG + frozen clock), so run1 minus run2 is nothing.
- **left = Playwright** → **bright confetti** — its two runs diverge (real randomness + real-time capture), so run1 minus run2 is everything.

Black vs static noise, side by side. The image does the talking.

## Run it

```bash
bash compare.sh                     # default: ../demo-av.html
bash compare.sh <page> <secs> <fps>
```

Needs Node + ffmpeg on PATH. On Windows, run it in **Git Bash** (not WSL — WSL is
a separate Linux userland without this project's Node/ffmpeg/Chromium):
`& "C:\Program Files\Git\bin\bash.exe" compare.sh`. Output is `out/compare.mp4`
(git-ignored). It also prints the numeric verdict (`IDENTICAL` vs `DIFFER`).

## Why demo-av.html

The diff only lights up if the page's content actually **diverges** between runs.
`../demo-av.html` renders a background field of 260 particles with `Math.random`, so:
- ours seeds the RNG → identical every run → black.
- Playwright gets fresh randomness each run → different every run → confetti.

The same page also exercises the renderer's hard paths — `<video>` decode, `--data`
injection, `HTMLAudioElement`, and a Web Audio graph — so one fixture proves both
determinism *and* A/V + params fidelity. (The particle field started life as a
standalone `particles.html`; it was folded in here so there's a single canonical demo.)

A time-driven page (a clock, a progress bar) is deterministic in content, so both
tools match and the diff is black on both sides — nothing to see. Live pages
(e.g. stripe's GDP counter) also differ by design; determinism is only claimed
for self-contained pages.
