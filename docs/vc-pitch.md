# browser-video-renderer

**Turn any web page into a repeatable, frame-accurate video — without changing the page.**

Point it at a URL or an AI-generated HTML file; it films the page as video — scrolling, clicking, and driving the UI first — and captures animation, embedded video, and audio-reactive visuals with frame-accurate *timing*, the same way every run (byte-identical on a given machine). No SDK, no rewrite, no timing marks.

> **The primitive, in one line:** a browser where time is a variable you control, plus a camera that fires every time you advance it — a `<video>` camera for any webpage, running at any speed, forward-only, deterministic, with no human watching.

---

## 1. What we've built

A working CLI today (single machine, MIT):

- **Deterministic capture of *any* page.** A fake clock replaces `Date`/`rAF`/timers in headless Chrome; we step time frame-by-frame, screenshot, encode with FFmpeg. A 60-second animation renders frame-accurately regardless of machine speed — and the page never knows it's being filmed.
- **Drive it first** — click to dismiss/open (`--click`), tour the page (`--scroll`), or click on camera at a timestamp (`--click .play 2`).
- **Repeatable renders** — seeded `Math.random`/`crypto` + a frozen clock make a page render byte-identical on the same machine/Chrome build; the basis for reliable visual diffing. (Pixel-perfect *compositor* determinism would need Chrome's `beginFrame`, removed in 147+; we pin the *timing* via `page.screenshot()`, not the compositor.)
- **Real media** — deterministic `<video>` decode via WebCodecs, multi-clip + trim; animated GIF/APNG/WebP decoded onto the virtual clock (even on strict-CSP sites, via a CSP-exempt injection path); output mp4/webm/mov/mkv/gif, PNG sequence, transparent (alpha), and stills across h264/h265/av1/vp9/vp8/prores.
- **The hard part — audio.** Two passes: render the page's *real* Web Audio graph on an `OfflineAudioContext` (captures **`AudioWorkletNode`** DSP), then feed that PCM back to a shimmed **`AnalyserNode`** so audio-reactive visualizers actually react — deterministically.
- **Reaches the real web** — auto-detects Cloudflare and switches to a stealth path (real Chrome + deferred clock) so bot-walled pages (CodePen, Stripe, product pages) render instead of getting blocked.
- Plus captions from the page's own audio, and batch/templated renders.

**We've found no other tool that captures AudioWorklet DSP or audio-reactive visuals from a page it didn't author** — and we've verified ours does, end-to-end.

---

## 2. Why it's ours

Browsers are real-time systems, not frame-accurate recorders — filming a page means controlling time, audio, and rendering *from the outside*. Incumbents dodge this by making the **author build for capture** (Remotion = React `useCurrentFrame`; HyperFrames = HTML `data-*` marks). That breaks on AI-generated pages, where there's no author to cooperate. **Our bet: the page shouldn't have to** — the axis they're not architected for.

The barrier was never *"can I build this visual?"* — the web renders SVG, Canvas, WebGL, CSS, DOM, fonts, video, audio, and 3D on one composable surface. The barrier has always been **getting it out as video.** We are that missing pipe.

---

## 3. The wedge

> **Preview what an AI coding agent just built — as video.** Cursor, v0, Replit, Codex ship UIs constantly; a screenshot misses the motion and the interaction. We film the generated page as-is, zero cooperation required.

**Adjacent, same capability:** deterministic visual-regression of *animation* in CI — today's tools disable animation because it makes screenshot tests flaky; our byte-identical renders don't have to.

**Market status, honestly:** demand is *inferred*, not yet proven by us. HyperFrames hit ~33k stars in ~2 years (as of Jul 2026) and Replit's "browsers don't want to be cameras" post went wide — the *problem* is felt. Whether teams pay for *video specifically* is what we test first.

---

## 4. Where it applies — the demand surface

The primitive is horizontal: URL in, video out. We test the AI-preview wedge (§3) first, but the *same capability, no new code* serves a broad surface. Each of these is a place a team currently screen-records, hires an editor, hand-writes export code, or gives up:

- **Automated data-viz & chart video** (finance / analytics / BI). A team generating ~50 animated ECharts/D3 chart videos per quarter loops one command instead of screen-recording 50× or writing per-library Canvas export. `for chart in charts/*.html; do node render.js "$chart" --duration 5 ...; done`
- **Product-demo generation** (SaaS marketing). An interactive demo goes stale on every ship; an editor costs ~$500/round. Script the UI on a timeline, regenerate on every deploy, and let `--baseline` catch visual regressions — the demo stays in sync at **zero marginal cost**.
- **Animation regression testing in CI** (design systems). A `cubic-bezier` tweak subtly breaks a button animation — invisible to a screenshot test. `--baseline` extends snapshot testing into the **time dimension**, fails the PR, and surfaces the worst-differing frame before it ships.
- **Competitive & product intelligence.** Every competitor landing page is Cloudflare-walled. A weekly cron captures them frame-accurately in stealth mode; teams diff week-over-week. **Impossible without the stealth path** — which is the point.
- **Audio-reactive export** (creator / edtech). A browser DAW or music-ed platform lets students export a project with the waveform display animating *in sync* with the audio. The two-pass audio pipeline captures both; screen-recording a tab can't.
- **Automated social content** (marketing / media). Nightly: fetch headlines → render an animated-typography template with `--data '{...}'` → post to Reels/Shorts via API. **No designer, no editor, no After Effects license** — just HTML, CSS, and cron.

The addressable surface is the union of the above plus everything adjacent to screen recording, motion graphics, and programmatic-video APIs — large and expanding, because the trigger is always the same unmet need: *turn a web page into video, by code, reliably.*

---

## 5. The competitive field

Partition by the job the buyer is doing. Two jobs, mutually exclusive: **create** a video from scratch, or **record** a page that already exists. Every tool sits in exactly one; we are the only one built to *deterministically record a page that never cooperated*.

### Create (authoring) — a different job that shares our budget

You write the video in their format; the composition *is* the source. Not our lane, but named because agent-video spend often starts here.

| | Remotion | HyperFrames | us |
|---|---|---|---|
| Input | React code | HTML + `data-*` marks | **any URL / HTML** |
| Films pages not built for capture? | No | No | **Yes** |
| AudioWorklet / audio-reactive capture | No | No | **Yes** |
| Reaches bot-walled pages? | N/A | N/A | **Yes (stealth)** |
| Repeatability | `useCurrentFrame` | seekable libs | frozen clock + seeded RNG |
| Maturity | v4, 52k★ | v0.7, 33k★ | **working demo, 0★** |
| Scale | Lambda / Cloud Run | Lambda / Cloud Run | **single machine** |
| License | paid >3 staff | Apache-2.0 | MIT |

They can't add zero-touch capture without cutting against their core assumption (a cooperating author). Different product, not a sprint feature.

### Record (capture) — our job. Partition by *output*: only video-output tools compete head-on

| Who | Does | Missing vs. us |
|---|---|---|
| **timecut / timesnap**, CCapture.js | same trick — hijacks `Date`/`rAF` for deterministic video | canvas/simple pages only — no auth, stealth, media decode, or audio |
| **Playwright / Puppeteer** `recordVideo` | records a session; built-in, free | real-time, non-deterministic, flaky |
| **urlbox, Browserless** (clip/GIF mode) | URL → short clip at scale; handles auth | no frame-accurate animation freeze, no audio; image-first |

**Moat = the bundle, not any one trick:** clock-freeze + media seek + auth + stealth + real audio, together, on a page that never cooperated. Each row nails *one*; none has all.

*Image-output tools are not video competitors — they overlap only via our optional `--baseline`:* Percy / Chromatic / Applitools / BackstopJS and screenshot APIs do deterministic **stills**. So determinism alone isn't the wedge — they have it for images — **video + determinism + uncooperative page** is.

**Verdict:**
- **Direct competitor:** timecut/timesnap — same idea, narrower; we win on real-world pages.
- **Real threat:** the free primitive — "just use Playwright `recordVideo` + a DIY clock shim" is the actual build-vs-buy call.
- **Adjacent:** capture-SaaS clip mode (thin video sliver); image-diff tools (only where `--baseline` reaches).
- **Not competitors:** Remotion / HyperFrames — create ≠ record.

(★ counts as of Jul 2026.)

---

## 6. Today → next

- **Today:** §1 works on one machine, verified end-to-end.
- **Not yet (pre-product):** cloud/parallel rendering, an HTTP render API, SSRF protection, GTM. Determinism also excludes live network data — a limit the competitors share.
- **Plan — validation, not projections:** (1) ship a GitHub Action ("PR → preview video") + an AudioWorklet-capture writeup, and measure install/inbound signal; (2) land 5–10 design partners in AI-coding / CI; (3) *then* build the cloud render API the demand justifies.

No revenue curve from a 0-star demo — the next milestone is validated demand.

---

## 7. Team

**Ankit Pandey** — *[FILL IN: 1–2 lines — prior roles, and the browser/rendering, media, or dev-tools background that makes you the right person to build this.]* *[Co-founders / advisors, if any — otherwise state "solo founder, hiring 1–2 with the round."]*

---

## 8. Ask

Pre-seed. ~12 months, 2–3 people, to harden the engine, ship the Action + render API, and turn the technical story into design partners. If demand is real, that's the seed; if not, we'll have a great open-source tool and a cheap, clear answer.

**In one line:** we built the one thing Remotion and HyperFrames can't — frame-accurate, audio-complete video from a page nobody built for capture — and we're raising a small round to learn how many people need it.

---

*2026-07-05 · single-machine CLI, MIT · [github.com/ankitpandey2708/browser-video-renderer](https://github.com/ankitpandey2708/browser-video-renderer)*
