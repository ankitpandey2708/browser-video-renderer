# browser-video-renderer

Render any URL or local HTML page to MP4 by virtualizing time in headless
Chrome, so animations are captured frame-accurately regardless of render speed.
Technique from Vinlic's [WebVideoCreator](https://github.com/Vinlic/WebVideoCreator).

## Setup

```bash
npm install
npx playwright install chromium
```

Needs `ffmpeg` and `ffprobe` on PATH. `npm install` also patches Playwright
(via `rebrowser-patches`, a `postinstall` hook) so the renderer can reach
Cloudflare-protected pages; that path additionally needs **Google Chrome**
installed. Playwright is pinned to `1.52.0` (rebrowser's supported version) —
don't bump it blindly. See [`docs/cloudflare-stealth.md`](docs/cloudflare-stealth.md).

## Usage

```bash
npm run demo                                             # -> out/demo-av.mp4
node render.js demo-av.html                              # local file
node render.js "https://stripe.com"   # public URL
node render.js "https://codepen.io/GreenSock/full/BaarZmV"  # Cloudflare-walled page: auto stealth mode
node render.js <url> --scroll                            # page tour: scroll through during capture
node render.js <url> --baseline base.mp4                 # visual-regression: exit 1 if it changed
node render.js <url> --duration 8                        # fixed length (overrides auto)
node render.js app.html --click "#start" 1               # click on camera at 1s
node render.js demo-av.html --data '{"label":"hi","accent":"#ff5c8a"}'  # templated render (window.__params)
node render.js scene.html --out out/v.mkv                # pick container via extension
node render.js viz.html --captions                       # transcribe audio -> .srt
```

A `<video>` on the page is decoded automatically. Output is auto-named
`out/<name>.mp4`. Renders are **repeatable** — `Math.random`/`crypto` are seeded
and the clock is frozen, so the same page renders byte-identical every run.

## Arguments

**You usually only need `<url>`** — it's the one **mandatory** argument. Everything
else is optional with a sensible default. Run `node render.js --help` for the full
list of flags.

| Category | Arg | Required? | Default | Meaning |
|---|---|---|---|---|
| **Input** | `<url\|file>` | **Mandatory** | — | public `http(s)` URL or local `.html` (auto-served over `127.0.0.1`) |
| **Output** | `--out <path>` | Optional | `out/<name>.mp4` | output file; extension picks the container (`.mp4`/`.webm`/`.mov`/`.mkv`/`.gif`; extension-less → PNG frame sequence) |
| **Timing** | `--duration <s>` | Optional | auto | fixed length (turns auto off; ignored if `--end` set) |
| **Timing** | `--start <s>` | Optional | `0` | start of record window |
| **Timing** | `--end <s>` | Optional | — | end of record window (turns auto off; length = `end − start`) |
| **Timing** | `--fps <n>` | Optional | `30` | frames per second |
| **Size** | `--size <WxH>` | Optional | `1280x720` | frame size, e.g. `960x540` |
| **Interaction** | `--click <sel> [s]` | Optional | — | click a selector (repeatable). No `s` = before filming (staging, e.g. dismiss a banner); `s` = on camera at second `s`. |
| **Interaction** | `--scroll [a-b]` | Optional | — | tour the whole page during capture (auto-scales length). `a-b` bounds the tour to those seconds (`b` may be `end`). |
| **Data** | `--data <json\|@file>` | Optional | — | inject as `window.__params` before page scripts (URL query params also work) |
| **Captions** | `--captions` | Optional | off | transcribe the page's own audio → `<out>.srt` sidecar (non-destructive) |
| **Captions** | `--burn` | Optional | off | additionally hardsub the captions into the video |
| **Visual regression** | `--baseline <file>` | Optional | — | compare render to this baseline via an **exact per-frame hash** (renders are byte-deterministic, so there's no tolerance to tune); **exits 1 on any changed frame** (for CI). On failure writes `<out>.diff.mp4` (+ `<out>.diff.worst.png`). A missing baseline is saved automatically |
| **Visual regression** | `--update-baseline` | Optional | off | (re)save this render as the baseline |
| **Visual regression** | `--mask <sel\|x,y,w,h>` | Optional | — | blacken a region — CSS selector or rect — so a dynamic zone neither trips the gate nor shows in the diff (repeatable) |
| **Auth** | `--cookies <file>` | Optional | — | inject cookies exported from your logged-in browser so gated pages render authenticated (see note below) |
| **Help** | `--help` | Optional | — | print the full list of flags |

### Notes

- **Length is auto-derived by default** — from finite CSS animations, pending timers, and video durations, clamped to ≤30s, falling back to 5s. `--duration`/`--end` override.
- **Readiness is automatic** — before capturing, the tool waits until the page is visually stable (fonts loaded, network idle, no DOM mutations for a quiet window, images decoded; capped at 8s). A page can also gate capture explicitly with `window.__renderReady`. No manual wait flag is needed.
- **Codec per container** (fixed): mp4→h264, mkv→h264, webm→vp9, mov→prores. HDR is **not** supported (8-bit sRGB).
- **Caption engine** is set via env (set-once, not per-render): `BVR_ASR=whisper|openai` (default `whisper`), `BVR_LANG=<code>`. whisper.cpp needs a binary (`WHISPER_CPP` or `whisper-cli` on PATH) and a model (`WHISPER_MODEL`); `openai` needs `OPENAI_API_KEY`. If the engine or audio is missing, captions are skipped — the render never fails.
- **`--cookies` format & how to get the file:** accepts a JSON `Cookie[]` or `{ "cookies": [...] }`. On modern Chrome (v127+) cookies use App-Bound Encryption and can't be read from outside the browser, so export them from *inside* Chrome — e.g. the [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie) MV3 extension → "Download JSON". This carries `httpOnly` session cookies too; we replay them into a fresh context.
- **Bot-protected (Cloudflare) pages — automatic, no flag:** for external URLs, the renderer detects a bot wall (`cf-mitigated` header / challenge markers) and transparently switches to *stealth mode* — real Chrome (**headful**) + [rebrowser-patched](https://github.com/rebrowser/rebrowser-patches) Playwright + a *dormant-shim* load: it injects the clock shim dormant so the challenge clears on a real clock, then freezes the clock in place to capture deterministically (no reload — these sites re-challenge on every navigation). Example: `node render.js "https://codepen.io/GreenSock/full/BaarZmV"`. Beats managed/invisible challenges on a clean home IP **and needs a real desktop session** (headful — not a headless server); won't beat interactive Turnstile / Enterprise zones (use `--cookies` or capture out-of-band). Full details + the Patchright/rebrowser/nodriver rationale: [`docs/cloudflare-stealth.md`](docs/cloudflare-stealth.md).
- **Video trim-in** (no flag): a [W3C Media Fragment](https://www.w3.org/TR/media-frags/) on the page's own `<video>` — `src="clip.mp4#t=5,10"` plays the 5–10s slice (`#t=5` = from 5s to the end). Multiple videos, per-clip volume, offset, and `playbackRate` already work.
- **Animated images** (no flag): `gif` / `apng` / `webp` `<img>`s play on the browser's own clock, which the frozen virtual clock can't drive → non-deterministic frames. They're decoded up front via `ImageDecoder` and seeked to virtual time, so they animate smoothly and identically every run (`media-decoder.js`). Static images are left untouched.
- **SVG SMIL** (no flag): `<animate>` / `<animateTransform>` / `<set>` timelines are seeked to virtual time (`svg.setCurrentTime`), so SMIL-animated SVGs advance deterministically instead of freezing.
- **Transparent video** (no flag): give a `<video>` a luma-mask companion — `<video src="v.mp4" maskSrc="mask.mp4">` (or `data-mask`) — white = opaque, black = transparent. The mask's luminance becomes the canvas alpha, so the page shows through. Great for overlaying a subject with no background box.

## Visual regression workflow

A step-by-step guide to catching unintended visual changes. The everyday loop is
just two commands: `--baseline` to check, add `--update-baseline` when you meant it.

**1. Just render (no regression testing)**
```bash
node render.js https://example.com          # -> out/example.mp4 (auto-named)
node render.js mypage.html --out out/demo.mp4 --duration 8 --size 1280x720
```
No baseline, no comparison — just a video.

**2. Establish a baseline (first regression run)**
```bash
node render.js https://mypage.com --baseline baselines/mypage.mp4
```
The first time (baseline file absent), the tool renders the page, **saves** it as the
golden reference (`baselines/mypage.mp4`), **records the network** it saw
(`baselines/mypage.har`, a sibling), pins the clock, and passes — there's nothing to
compare against yet.

**3. Check for regressions (every later run)**
```bash
node render.js https://mypage.com --baseline baselines/mypage.mp4
```
Now the baseline exists, so it renders fresh (replaying the recorded network, pinning
the clock), then compares **every frame** by exact hash:
- **PASS** (`all N frames identical`, exit 0) — nothing changed.
- **FAIL** (`X/N frames changed`, exit 1) — writes `out/mypage.diff.mp4` + `out/mypage.diff.worst.png` so you can *see* what changed.

Exit 1 is your CI gate: `node render.js … --baseline … || echo "regression!"`.

**4. Update the baseline (after an *intended* change)**
```bash
node render.js https://mypage.com --baseline baselines/mypage.mp4 --update-baseline
```
Re-saves the current render as the new reference **and** re-records the `.har`. Do this
when you intentionally changed the page's look, or when a run warns `N request(s) not
in recording` (your page added a network call, so the recording went stale).

**5. Ignore a genuinely dynamic zone (optional)**
```bash
node render.js https://mypage.com --baseline baselines/mypage.mp4 --mask "#live-widget"
node render.js https://mypage.com --baseline baselines/mypage.mp4 --mask "0,140,500,60"
```
`--mask` blackens a CSS selector or `x,y,w,h` rect (repeatable) so it counts toward
neither the gate nor the diff.

**Mental model**
```
FIRST run (no baseline yet)   → save video + record .har  → PASS
LATER runs (baseline exists)  → replay .har, diff frames  → PASS or FAIL (exit 1)
After an intended change      → add --update-baseline     → re-save + re-record
Un-pinnable dynamic region    → add --mask <sel|rect>      → ignored
```

> **Why it just works:** the gate is *exact* (no tolerance to tune) because renders
> are byte-deterministic — seeded RNG + frozen clock + pinned start epoch — and network
> is recorded/replayed, so even a live counter or API-driven content on a page you own
> renders identically run to run. **Off** for PNG-sequence output and under Cloudflare
> stealth mode. Cache-busted URLs and WebSocket/SSE streams aren't pinned by replay.

## How it works

- `clock-shim.js` replaces `Date`, `performance.now`, `requestAnimationFrame`,
  `setTimeout`, `setInterval` with a fake clock, injected before page code.
- Interactions stage the shot: `--click <sel>` runs after load, before capture
  (e.g. dismiss a banner); `--click <sel> <s>` and `--scroll` run *during*
  capture, so a video can show a click on camera or a page being toured.
  `--data` sets `window.__params`
  for templated / personalized renders (URL query params also work with no code).
  Output is always video (or a PNG frame sequence for an extension-less `--out`).
- Per frame: advance the clock by `1000/fps`, fire due callbacks, seek CSS
  animations and `<video>`, capture via `page.screenshot()`, pipe to ffmpeg.
- The `--out` extension is the container; the video codec is the container's
  default (mp4/mkv→h264, webm→vp9, mov→prores). gif and PNG-sequence
  (extension-less `--out`) have their own paths.
- Repeatable capture: the shim seeds `Math.random` and `crypto.getRandomValues`
  from `window.__seed` (fixed at `1`), so renders are byte-identical run-to-run.
- Auto-readiness: after load, the renderer polls until the page is stable (fonts
  ready, network idle, no DOM mutations for a quiet window, images decoded, capped
  at 8s) before capturing — driven from Node with real timers since the page clock
  is frozen.
- Auto-duration (default): `window.__vclock.contentEndMs()` (max of pending timers,
  finite CSS-animation ends, and trimmed video durations) sets the length, clamped
  to ≤30s, falling back to 5s. On Web-Audio pages it's resolved in the audio pass
  so the visual length and the rendered audio agree. `--duration`/`--end` override.
- `<video>`: mp4box demux → WebCodecs decode → `<canvas>`, synced to the clock,
  honoring the video's start offset, `playbackRate`, and `#t=` trim window.
- **Audio (two-pass)**: if the page uses Web Audio, a first pass rebuilds its graph
  on an `OfflineAudioContext` and renders exact PCM — this runs `AudioWorkletNode`
  DSP and gain automation for real. The visual pass then feeds that PCM to a
  shimmed `AnalyserNode` at the current clock offset (via FFT), so audio-reactive
  visualizers work. The PCM is muxed as the master track. Pages without Web Audio
  (or when the length is auto-derived) fall back to the wiretap path:
  playback intent is recorded (`fetch`/`XHR`/`decodeAudioData`/`AudioNode.connect`/
  `AudioBufferSourceNode.start`/`HTMLAudioElement.play`/`OscillatorNode`), tones are
  re-synthesized, and `<audio>`/`<video>` file tracks are extracted and muxed.
- `--captions` transcribes the finished audio (whisper.cpp by default) into an
  `.srt` sidecar; `--burn` also hardsubs it.
- `OffscreenCanvas` is disabled (it would bypass main-thread capture).
- Local files are served over `http://127.0.0.1:3000` so `fetch`/WebCodecs work.

## Files

```
clock-shim.js      fake clock + seed + CSS/SVG-SMIL/video seek (w/ #t= trim) + audio (offline render, AnalyserNode, wiretap)
media-decoder.js   deterministic media: <video> (mp4box->WebCodecs, #t= trim + luma-mask transparency) + animated <img> gif/apng/webp (ImageDecoder) -> canvas, seeked to virtual time
media-fragment.js  W3C media-fragment (#t=start,end) parser
captions.js        ASR (whisper.cpp / OpenAI) -> .srt sidecar + optional burn-in
render.js          CLI: static server, two-pass audio, drive clock, capture, mux
demo-av.html       demo page
assets/            demo media (clip.mp4, beep-*.mp3)
vendor/            mp4box IIFE bundle (committed)
out/               output (gitignored)
```

## Limitations

- Frame-perfect CSS/compositor determinism needs Chrome's `beginFrame`, removed
  in Chrome 147+ and unstable on Windows/macOS. We use `page.screenshot()`
  (which already flushes the compositor); for true beginFrame, run on Linux with
  a pre-147 `chrome-headless-shell`.
- Audio-reactive visuals and `AudioWorkletNode` are captured via the Web Audio
  offline pre-render, but only for the **master mix** (no per-node analysis), only
  when the duration is known up front (not when auto-derived), and only for
  graphs that reconstruct cleanly offline (others fall back to the wiretap). The
  two-pass path also roughly doubles render time on Web-Audio pages.
- No HDR output — `page.screenshot()` yields 8-bit sRGB; there is no float readback
  path for arbitrary DOM.
- Determinism covers in-page randomness (`Math.random`/`crypto`, seeded), time
  (frozen clock; for VRT the start epoch is also pinned via `window.__epoch`, so a
  real-time counter like `base + rate*(now − t0)` renders identically), and — under
  `--baseline` — network, via HAR record/replay (record on baseline save, replay on
  compare). Caveats: replay matches by method+URL, so **cache-busted URLs** (unique
  query per load) and **WebSocket/SSE** streams aren't pinned; unrecorded requests
  fall through to live network (logged). Network record/replay is **off under
  stealth** (a recorded Cloudflare challenge is meaningless) and without `--baseline`.
- No timeline or scene-authoring model: the tool films a single page, it is not
  a video editor. Join or decorate finished clips with a general tool (ffmpeg).
- No SSRF protection, no parallelism, no server-side video fragmentation (large
  videos are loaded whole).

