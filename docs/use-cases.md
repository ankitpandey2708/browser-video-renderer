# Use Cases — First Principles

> What is this tool, really? Strip away the code. The fundamental primitive is:
>
> **A browser where time is a variable you control, combined with a camera that fires every time you advance it.**
>
> A `<video>` camera for a webpage that can run at any speed, forward only, deterministically, without a human watching.

---

## Principle 1: The web is the richest rendering platform ever built

There is no other single system that can render SVG, Canvas, WebGL, CSS animations, DOM layout, text with web fonts, video, audio analysis, 3D scenes, data visualizations, and interactive UI — all composable on one surface. The barrier has never been "can I build this visual?" — it's always been "can I get this out of the browser as a video?"

**This tool removes that barrier.**

### Concrete use case — automated chart animations

A team at a financial data company builds earnings report dashboards in ECharts/D3. Every quarter, they generate 50 animated chart videos (one per metric, showing 5 years of data unfolding).

Before this tool, a human would either screen-record 50 times (wasting hours), or a developer would write custom frame-by-frame Canvas export code for each chart library.

With this tool, they serve each chart as an HTML page with a CSS animation that reveals data over 5 seconds, run `node render.js` for each URL, and get 50 MP4s. Automation handles the whole pipeline.

```bash
for chart in charts/*.html; do
  node render.js "$chart" --duration 5 --out "videos/$(basename $chart .html).mp4"
done
```

---

## Principle 2: If you can script a browser, you can script video production

The `--do` flag means you can drive a UI like a robot. Click here at second 1, type text at second 3, scroll at second 5. This turns any interactive web app into a video source.

### Concrete use case — product demo generation

A SaaS company's marketing site has an interactive demo (`#start`, `#step-1`, `#step-2` buttons). Every time they ship a UI change, the old demo video is stale. Hiring a video editor costs $500/round.

Instead:

```bash
node render.js demo-page.html \
  --do "click #start@0.5" \
  --do "click #step-1@2" \
  --do "click #step-2@4" \
  --duration 6 \
  --baseline demo-baseline.mp4 --threshold 16
```

The tool produces a fresh MP4 on every deploy, and `--baseline` catches visual regressions automatically. The demo video stays in sync with the product at zero marginal cost.

---

## Principle 3: Deterministic output turns video into a testable artifact

Most teams test UI with screenshots (snapshot tests). But behavior *over time* — a hover transition, a loading spinner, a scroll-triggered animation — can't be captured in a single frame. The `--baseline` feature extends the snapshot-test idea to the time dimension.

### Concrete use case — animation regression testing in CI

A design system team ships CSS keyframe animations for button press states, modal entrances, and page transitions. A junior dev changes a `cubic-bezier` from `ease-out` to an aggressive bounce curve. The change looks fine in their browser but makes the animation feel wrong.

CI runs:

```bash
node render.js button-demo.html --duration 1.5 --baseline button-anim-baseline.mp4
```

The diff video catches the difference, marks the PR as failing, surfaces the worst-differing frame. Without this, the animation would ship and degrade UX for thousands of users.

---

## Principle 4: The real web is behind bot walls — stealth mode makes this a production tool

Every interesting public URL — CodePen, Stripe docs, D3 examples, product pages — sits behind some form of bot protection. A headless browser gets blocked instantly. The stealth mode (real Chrome + deferred clock) means the tool works on the actual internet.

### Concrete use case — capture competitor product UIs

A product intelligence team tracks how competitor landing pages evolve. They run a weekly cron job:

```bash
node render.js "https://competitor.com/landing" --duration 8
```

The tool auto-detects Cloudflare, switches to headful real Chrome, lets the challenge clear, and captures frame-accurately. The team compares week-over-week videos to see what changed. Without stealth mode, this workflow is impossible — every competitor uses Cloudflare.

---

## Principle 5: Web Audio + offline renderer means audio-reactive visuals are captured correctly

This is a genuinely hard problem that most tools don't solve. A page with an audio visualizer (bars dancing to music) needs the audio and visuals to agree. The two-pass approach (OfflineAudioContext pre-render → PCM feed → AnalyserNode shim) means you capture both the sound and the visualizer's reaction to it.

### Concrete use case — music education platform

A startup teaches music production in the browser. Students build beats in a Web Audio-powered DAW with an oscilloscope visualizer. The "export video" feature uses this tool to render the student's project to a shareable MP4 — the waveform display animates in sync with the audio, all deterministically.

The alternative is the student screen-recording their browser tab (low quality, unsynced, huge files).

---

## Principle 6: The tool composes with other tools

It's a CLI — it reads a URL, writes a file. This means it fits into any pipeline.

### Concrete use case — automated social media content

A marketing team runs a daily script:

1. Fetch today's top news via API
2. Render headlines into an HTML template (animated typography)
3. `node render.js today.html --duration 15 --out out/today.mp4 --data '{"headlines": [...]}'`
4. Post to TikTok/Instagram Reels via API

No designer, no video editor, no After Effects license. Just HTML, CSS, and a nightly cron job.

---

## The Thesis

> The web browser is the most expressive renderer ever built. The only thing missing has been a way to extract its output as video — deterministically, at any speed, programmatically. This tool is that missing pipe.

The use cases are everywhere a human currently:

- **Screen-records their browser** — and accepts the quality/determinism loss
- **Hires a video editor** to animate something that already exists as a web page
- **Writes custom Canvas export code** for a specific visualization library
- **Avoids animating something** because "it would be too hard to capture as video"

Every one of those is a use case for this tool.
