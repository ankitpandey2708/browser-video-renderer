# Reaching bot-protected pages (Cloudflare) — stealth mode

*How the renderer captures pages behind Cloudflare's managed/invisible bot check,
why it's hard for **this** tool specifically, and why we chose rebrowser-patches
over Patchright and nodriver.*

## The problem

A fresh headless Chromium is flagged by Cloudflare's bot management. Worse, this
renderer **freezes the clock** (replaces `Date`/`rAF`/timers) and steps virtual
time frame-by-frame for deterministic capture — and a frozen clock **can't run**
Cloudflare's JS challenge. So a naive capture just films the "Verifying you are
human" interstitial.

## The core constraint (why the "best" stealth tool isn't the best *here*)

The clock shim **must run in the page's main world, before page code**, so it can
replace `Date`/`rAF` and expose `window.__vclock`. That single requirement decides
everything — because the strongest stealth tools work by doing the opposite
(isolating injected scripts away from the page's main world).

## The three tools, evaluated (verified this session, not from docs)

| Tool | Stealth | Main-world injection (our dealbreaker) | Stack | Verdict |
|---|---|---|---|---|
| **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)** | Excellent | ❌ **Isolates everything** — tested: `addInitScript` **and** raw CDP `addScriptToEvaluateOnNewDocument` both returned `undefined` in the main world | Node / Playwright drop-in (Apache-2.0) | **Rejected — incompatible** |
| **[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)** | Good (fixes `Runtime.enable` CDP leak) | ✅ **Preserved** — tested: `addInitScript → 42` in `addBinding` mode | Node / patch to `playwright-core` | ✅ **Chosen** |
| **[nodriver](https://github.com/ultrafunkamsterdam/nodriver)** | Strongest (even clicks the CF checkbox) | ✅ (own CDP, real Chrome) | ❌ **Python** (rewrite or 2-language sidecar), **AGPL-3.0** | Not needed |

**Why Patchright fails:** its stealth *is* main-world isolation → the shim never
patches the page → `window.__vclock` is undefined → capture dies. Not fixable.

**Why not nodriver:** strongest evader, but Python + AGPL means a two-language
sidecar and a license clash with this MIT tool. Overkill; never needed.

**Why rebrowser wins:** the only option that keeps main-world injection **and**
adds real stealth. "Best raw stealth" is worthless if it breaks the shim.

## Architecture

Stealth is **automatic — there is no flag.** External URLs are checked; a detected
wall transparently upgrades that render to stealth. Local files never trigger it.

1. **Pre-flight detection** (`detectBotWall`) — for `http(s)` URLs only, do a quick
   plain load and check for a wall (below). Sets an internal `args._stealth`.
2. **Stealth browser** — real Chrome (`channel: "chrome"`, real TLS/UA) launched
   **headful** with `--disable-blink-features=AutomationControlled`
   (`navigator.webdriver` → `false`). `playwright-core` is rebrowser-patched
   (`Runtime.enable` leak fixed, main-world injection preserved via `addBinding`
   mode, set in `render.js`). **Headful is mandatory:** real Cloudflare blocks a
   headless real-Chrome *indefinitely* (the managed challenge never issues
   `cf_clearance`); a headful window clears it instantly. Stealth therefore needs a
   real desktop session, not a headless server.
3. **Deferred-arm "dormant shim" load** (`navigateWithInit`) — the key trick:
   - **Inject the shim dormant:** set `window.__vclockDeferred` and add the shim as
     init scripts *before* the first navigation. In this mode the shim touches
     nothing — the page keeps the **real clock** — so Cloudflare's JS challenge can
     run and clear.
   - **One live navigation:** `goto(url)` → the challenge runs on the real clock.
   - **Clearance wait** (`waitForClearance`): poll until challenge markers vanish
     (~25s timeout).
   - **Arm the frozen clock in-place:** call `window.__vclock.arm()` — the shim now
     installs (Date/rAF/timers frozen, anchored at this moment, `elapsed = 0`) and
     deterministic capture proceeds. **No reload.**

   **Why not the old goto-then-reload?** A frozen clock can't complete the
   challenge, and these sites (CodePen `/full/` included) **re-challenge on every
   navigation** — `cf_clearance` does *not* let a reload skip it (verified: even a
   fresh context with a harvested `cf_clearance` + `__cf_bm` still gets a fresh
   403). So reloading a shimmed page just re-triggers the challenge against a frozen
   clock and deadlocks. Injecting dormant keeps the clock real through the whole
   challenge and freezes it only for capture.

**Determinism:** captured frames are internally deterministic (virtual-clock
stepping) as before. The **tradeoff vs. the non-stealth path:** the freeze is armed
*after* clearance rather than at the page's absolute t=0, so any animation that ran
during the brief real-clock window before `arm()` starts slightly phase-shifted —
cross-run start state can vary. Best-effort, by design, for walled pages.
**Audio capture is also best-effort in stealth:** the audio wiretap installs at
`arm()`, so a page that builds its audio graph before clearance may not be captured.

## Wall detection (layered, cheapest + most reliable first)

- **Primary — response:** Cloudflare's `cf-mitigated` response header (definitive),
  or HTTP `403`/`503`/`429` with `server: cloudflare`. No false-positives on pages
  that merely *embed* a Turnstile widget (those are `200`, no `cf-mitigated`).
- **Secondary — DOM/title:** `document.title` matching `just a moment` /
  `verifying you are human` / `security verification`, or `#challenge-running` /
  `#challenge-stage` / `iframe[src*="challenges.cloudflare.com"]`.

## The honest ceiling

- ✅ Beats **managed / invisible** challenges (what most sites, incl. CodePen
  `/full/`, throw) — on a **clean residential IP** (i.e. your home machine; the
  paid residential-proxy requirement only bites datacenter runs) **running
  headful** (see Architecture #2). Verified end-to-end against live CodePen
  `/full/`: detected → stealth → cleared on the real clock → armed → captured the
  real animation deterministically.
- ❌ Won't beat **interactive Turnstile checkboxes** or **Enterprise behavioral**
  zones — those need real-time human interaction, which fights the frozen clock.
  Fallbacks: `--cookies` (inject a `cf_clearance` from a real browser; UA-bound,
  finicky), or out-of-band capture (record once in a real browser, composite the
  clip). nodriver / a paid cloud browser would be the next rung, at real cost.
- Success is **not guaranteed** — test against your specific URL.

## Setup / dependencies

- **Playwright is pinned to `1.52.0`** — rebrowser-patches' latest supported
  version (it can't patch 1.61+). Don't bump it without checking rebrowser support.
- **rebrowser-patches** is a devDependency; a **`postinstall`** hook re-applies the
  patch after every `npm install` (`rebrowser-patches patch --packageName
  playwright-core`). It fails gracefully — if the patch can't apply, stealth just
  degrades (main-world still works via native Playwright; only the CDP-leak fix is
  lost).
- **Real Chrome must be installed** (stealth uses `channel: "chrome"`).
- **Windows caveat:** rebrowser shells out to the `patch` CLI (ships with Git). If
  `patch` isn't on PATH during `npm install`, the postinstall degrades gracefully;
  re-run it from a Git Bash shell to apply.

## Testing

Verified end-to-end against **live CodePen `/full/`** (a real Cloudflare managed
challenge, headful, residential IP): detected the wall → switched to stealth →
injected the shim dormant → the challenge cleared on the real clock → armed the
frozen clock → **captured the real animation deterministically** (frames showed the
GSAP WebGL sphere animating, not the "Just a moment…" interstitial). The normal
(non-stealth) render path — including virtual `setTimeout`/CSS-animation seeking —
was unaffected. Real-world success depends on the site and your IP — test your
actual URL.

## Where it lives (`render.js`)

- `detectBotWall(url)` / `isBotWall(resp, page)` — detection.
- `waitForClearance(page)` — poll until the challenge clears.
- `navigateWithInit(page, url, initScripts, args)` — normal vs dormant-shim +
  `arm()` load.
- `openBrowserContext(args, {headless})` — stealth launch options (forces headful).
- `clock-shim.js` — `window.__vclockDeferred` / `__vclock.arm()` deferred install.
- pre-flight in `main()` sets `args._stealth` for external URLs.
- `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding` set at the top of `render.js`.
