# browser-video-renderer

**Automated capture-and-polish for the web: point it at any URL, get a produced, shareable video — no human recording, no rebuild.**

Screen Studio and Arcade make a screen recording *look* produced — but a human has to sit and record it. Remotion and HyperFrames make polished video — but you author every pixel inside their framework. We do neither: we **capture an existing page deterministically** (headless, frame-accurate, with real audio) and **auto-produce it** — cursor, zoom, music, reframe — from a URL, in a pipeline, at scale.

> One line: a browser where time is a variable you control + a camera that fires when you advance it, wrapped in an automated edit suite. **Arcade, minus the human.**

---

## 1. The capture core (built, working today)

A working CLI on a single machine:

- **Deterministic capture of any page.** A fake clock replaces `Date`/`rAF`/timers in headless Chrome; we step time frame-by-frame, screenshot, encode with FFmpeg. A 60-second animation renders frame-accurately regardless of machine speed — and the page never knows it's being filmed.
- **Real media.** Deterministic `<video>` decode via WebCodecs (multi-clip + trim); animated GIF/APNG/WebP on the virtual clock, even on strict-CSP sites; output mp4/webm/mov/mkv/gif, PNG sequence, transparent (alpha) — h264 (mp4/mkv), vp9 (webm), ProRes (mov).
- **Audio — the part others punt on.** Two passes: render the page's *real* Web Audio graph on an `OfflineAudioContext` (captures **`AudioWorkletNode`** DSP), then feed that PCM back to a shimmed **`AnalyserNode`** so audio-reactive visuals actually react — deterministically.
- **Reaches the real web.** Auto-detects Cloudflare and switches to a stealth path (real Chrome + deferred clock) so bot-walled / authenticated pages render instead of getting blocked.
- Interactions (`--click`, `--scroll`), captions from the page's own audio, templated (`--data`) and baseline (`--baseline`) renders.

---

## 2. The honest competitive reality (read this first)

The capture *engine* is **not** a moat. The core technique — time virtualization — was pioneered by the OSS project **WebVideoCreator**, and independently productionized by **Replit** (["We Built a Video Rendering Engine by Lying to the Browser About What Time It Is,"](https://replit.com/blog/browsers-dont-want-to-be-cameras) Feb 2026) for the *same* use case (AI-agent-generated video) — and **they're planning to open-source it.** Deterministic web→video is becoming free and commodity.

That's clarifying, not fatal. Replit's own post shows exactly where we still win:

- **Audio.** Replit explicitly *cannot* capture `AudioWorkletNode`, `OscillatorNode`, or `<video>` audio — their "spy on playback intent" approach needs a fetchable source URL. Our `OfflineAudioContext` pass does. **Their documented gap is our edge.**
- **Reach.** Replit renders pages *it* hosts; there's no bot-wall stealth. We capture *external / gated* pages.

**So the defensible layer isn't "we have the engine."** It's **audio-complete + real-web reach + an automated production layer** sitting on top of a soon-commodity core.

---

## 3. Positioning — three lanes; we're the automated one

| Lane | Who authors the visual? | Examples |
|---|---|---|
| Author-from-code | you build every pixel in a framework | Remotion, HyperFrames |
| Manual capture + polish | a human records real content, then polishes | Screen Studio, Arcade, Loom |
| **Automated capture + polish (us)** | a machine captures a real page, then polishes | *(open)* |

Cursor + auto-zoom + reframe + music is **Screen Studio's** feature set, not Remotion's — and Screen Studio doesn't compete with Remotion. So these features place us with the **capture-and-polish** lane, differentiated by being **headless, programmatic, at scale** (URL in → produced video out, no human), with deterministic frames + real audio a screen recorder can't get.

**The bright line we will not cross:** we never author the content. The core visual is always a *captured real page*; we only add production around it. Cross into "design the content from scratch" and we become a worse Remotion.

---

## 4. The product — the polish layer above the commodity core

The capture core is table stakes; these turn "a deterministic screen grab" into "a video people share" — and they're exactly what an engine-only OSS (WebVideoCreator, Replit's) omits. Each is a parameter on one `POST /render`:

- **Synthetic cursor + auto-zoom-to-click** — Screen-Studio-style punch-ins.
- **Multi-scene journeys + timeline** — a whole user flow across navigations into one video.
- **Background music + TTS narration**, synced to the timeline.
- **Auto-reframe + multi-output** — 16:9 / 9:16 / 1:1 / GIF / thumbnail from a single capture.
- **Matrix / templated batch** — one template × N data rows → N personalized videos.

---

## 5. Wedge & demand (honest)

**Primary wedge: AI-generated content → shareable video, automatically.** AI builders (v0, Lovable, Bolt, Replit) generate web UIs faster than anyone will re-author them in a video framework, and their share/preview is admittedly weak. This is the one place "record, not author" is *forced* — there's no author to cooperate with — and it's *growing*.

Two honest caveats:
- **The biggest AI builders may build capture in-house** (Replit did). Our buyer is therefore the **long tail** that won't run Chrome + FFmpeg + audio + stealth themselves — plus anyone who needs the audio/reach superset. (OSS existing sets a price floor, not a ceiling; hosted-OSS businesses are routine.)
- **The core unknown is demand for *automated* polish** vs a human doing it in Screen Studio.

We pressure-tested narrow verticals — animation visual-regression, data-viz-to-video, music/audio-reactive export, competitive monitoring. Each is a real market, but the buyer is either served by good-enough/cheaper tools (screen-record, screenshots, $10 templates) or too thin. So we lead with the **horizontal API**, not a vertical.

---

## 6. Validation plan (cheap, before building more)

1. Landing page + `POST /render {url, …}` over the **existing** engine. Does anyone integrate the free tier?
2. Cold-reach ~15 AI-builder / preview-platform teams with a produced video *of their own generated app*.
3. Land 2 design partners on a free integration.

- **Green** → build the §4 polish features in the order users pull them (each = a new `/render` param).
- **Flat** → it's an excellent open-source engine and the exact systems résumé Replit is hiring for. A clear, cheap answer either way.

No revenue curve from a 0-star demo — the next milestone is **validated demand**, not projections.

---

## 7. Team

**Ankit Pandey** — *[FILL IN: 1–2 lines — prior roles, and the browser/rendering, media, or dev-tools background that makes you the right person to build this.]* *[Co-founders / advisors, if any — otherwise "solo founder, hiring 1–2 with the round."]*

---

## 8. Ask

Pre-seed, ~12 months, 2–3 people: run the demand test, build the production layer users pull, and turn the audio/reach superset into design partners.

**One line:** the automated way to turn any live web page into a *produced* video — Arcade without the human — differentiated exactly where even Replit's engine punts: **real audio and the real web.**

---

*2026-07-06 · single-machine CLI, MIT · [github.com/ankitpandey2708/browser-video-renderer](https://github.com/ankitpandey2708/browser-video-renderer)*
