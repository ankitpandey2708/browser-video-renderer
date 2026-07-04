#!/usr/bin/env node
// render.js -- render a URL or local HTML page to MP4 by virtualizing time in
// headless Chrome. See README for arguments.
//
// Also supports (all optional, default = current behavior):
//   #1 --do "<action>@<seconds>"  timed mid-capture interaction (repeatable);
//       action = click|hover|scrollto|type|press <sel> [text/Key] | key <Key>.
//   #4 --data <json|@file>  injected as window.__params before page scripts.
//       (URL query params already work with no code.)

// rebrowser-patches keeps injected scripts in the MAIN world so the clock shim can
// patch the page, while still fixing the Runtime.enable CDP leak. Its default
// fixMode is already "addBinding" (main-world) -- exactly what the shim needs -- so
// we rely on that default. Set REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated
// only if you deliberately want isolated-world injection (which breaks the shim).

// rebrowser-patches emits an ungated console.error when a browser is torn down
// mid-navigation on a bot-challenge page -- exactly what the disposable
// detectBotWall probe does (goto the wall, read the response, close). The error
// is caught internally and doesn't affect the render, so drop that one benign
// line; everything else still logs.
{
  const origError = console.error.bind(console);
  console.error = (...a) => {
    if (typeof a[0] === "string" && a[0].includes("[rebrowser-patches][frames._context] cannot get world")) return;
    origError(...a);
  };
}
const { chromium } = require("playwright");
const { spawn, execFileSync, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { generateCaptions } = require("./captions"); // #5

// #3: shared browser helpers (parseMediaFragment / videoShownSourceTime). The
// shims run in the page as injected strings and can't require(), so we prepend
// this module's source to them (stripping its Node module.exports tail). One
// copy lives in media-fragment.js instead of being re-inlined per shim.
const SHARED_BROWSER_SRC = fs
  .readFileSync(path.join(__dirname, "media-fragment.js"), "utf8")
  .replace(/if \(typeof module[\s\S]*$/, "");
// Read a page shim and prepend the shared browser helpers it depends on.
function loadShim(file) {
  return SHARED_BROWSER_SRC + "\n" + fs.readFileSync(path.join(__dirname, file), "utf8");
}

// Strip a file's extension; sibling() derives a companion path next to it
// (e.g. sibling(outAbs, ".silent.mp4")). Used pervasively for intermediates.
const stripExt = (p) => p.replace(/\.[^./\\]+$/i, "");
const sibling = (p, suffix) => stripExt(p) + suffix;

// #6: fixed RNG seed injected as window.__seed, so Math.random/crypto are
// deterministic and renders are byte-identical (the basis for --baseline VRT).
const SEED_VALUE = 1;

// Advance the virtual clock by n frame-sized ticks (the page's own timers are
// frozen, so time only moves when we tick it from Node).
async function tickFrames(page, dt, n) {
  for (let i = 0; i < n; i++)
    await page.evaluate((d) => window.__vclock.tick(d), dt).catch(() => {});
}

// Ask the page how long its content runs (ms), or 0 if it can't say.
const contentEndMs = (page) => page.evaluate(() =>
  (window.__vclock && window.__vclock.contentEndMs) ? window.__vclock.contentEndMs() : 0).catch(() => 0);

function parseArgs(argv) {
  const args = { url: null, fps: 30, duration: null, width: 1280, height: 720, out: null,
                 start: 0, end: null, warmup: 10000,
                 // A: scripted interactions
                 clicks: [], scroll: false, wait: 0,
                 // F: container inferred from --out (see renderOne)
                 // C: duration/end null => auto-derive the length from page content
                 // #1: timed mid-capture interactions (each "<action>@<seconds>")
                 doActions: [],
                 // #4: parametrization
                 data: null,
                 // NEW: captions (#5), audio (#2/#4)
                 captions: false, burn: false,
                 // visual-regression (#1): render, then compare to a baseline
                 baseline: null, threshold: null, updateBaseline: false, masks: [],
                 // auth/session: inject cookies exported from a logged-in browser
                 cookies: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--fps") args.fps = Number(rest[++i]);
    else if (a === "--duration") args.duration = Number(rest[++i]); // explicit length (else auto)
    else if (a === "--size") { const [w, h] = (rest[++i] || "").split(/[x×]/i); if (w && h) { args.width = Number(w); args.height = Number(h); } } // WxH
    else if (a === "--out") args.out = rest[++i];
    else if (a === "--start") args.start = Number(rest[++i]); // C1: record window start (s)
    else if (a === "--end") args.end = Number(rest[++i]); // C1: explicit record-window end (s)
    else if (a === "--click") args.clicks.push(rest[++i]); // A: repeatable click selector
    else if (a === "--scroll") args.scroll = true; // #3: scroll through the page DURING capture (a page tour; auto-scales length)
    else if (a === "--wait") args.wait = Number(rest[++i]); // A: extra real-time wait (ms)
    else if (a === "--do") args.doActions.push(rest[++i]); // #1: repeatable "<action>@<seconds>"
    else if (a === "--data") args.data = rest[++i]; // #4: inline JSON or @path -> window.__params
    else if (a === "--captions") args.captions = true; // #5: transcribe page audio -> .srt sidecar (engine via BVR_ASR/BVR_LANG env)
    else if (a === "--burn") args.burn = true; // #5: also hardsub captions into the video
    else if (a === "--baseline") args.baseline = rest[++i]; // #1: after rendering, compare to this baseline; exit 1 on regression
    else if (a === "--threshold") args.threshold = Number(rest[++i]); // #1: max peak pixel diff (0..255) to still PASS (default 8)
    else if (a === "--update-baseline") args.updateBaseline = true; // FR-B1: (re)save the render as the baseline
    else if (a === "--mask") args.masks.push(rest[++i]); // FR-B2: ignore a region in the diff (CSS selector or x,y,w,h) (repeatable)
    else if (a === "--cookies") args.cookies = rest[++i]; // auth: inject a cookies JSON exported from your logged-in browser (sweet-cookie format)
    else if (!a.startsWith("--") && !args.url) args.url = a;
  }
  return args;
}

// F: format -> ffmpeg encoding parameters. Each format's audio codec is chosen
// for its container; gif/png carry no audio.
const FORMATS = { mp4: 1, webm: 1, mov: 1, mkv: 1, gif: 1, png: 1 };
// Fixed high-quality encode settings (the former --quality "high"; always used).
const CRF = 14;           // x264/vp9 constant rate factor (lower = higher quality)
const PRORES_PROFILE = 3; // prores_ks HQ
// Default video codec per container (gif/png carry no video codec).
const DEFAULT_CODEC = { mp4: "h264", mkv: "h264", webm: "vp9", mov: "prores" };
function containerCodec(container) {
  return DEFAULT_CODEC[container] || null; // null for gif/png
}
// ffmpeg video-encode args for a container's codec.
function videoEncodeArgs(container, codec, silent) {
  if (codec === "prores")
    return ["-c:v", "prores_ks", "-profile:v", String(PRORES_PROFILE), "-pix_fmt", "yuv420p10le", silent];
  if (codec === "vp9")
    return ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", String(CRF), "-b:v", "0", silent];
  return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(CRF), silent]; // h264 default (mp4/mkv)
}
function audioCodecFor(format) {
  if (format === "mp4" || format === "mov" || format === "mkv") return "aac";
  if (format === "webm") return "libopus";
  return null; // gif / png: no audio
}

// Serve a local directory over HTTP so pages behave like real sites:
// fetch()/XHR of audio work (blocked on file://), and audio/video URLs become
// http:// so ffmpeg can read them back for muxing.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif" };
function startStaticServer(root, port = 3000) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const srv = http.createServer((req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split("?")[0]);
        const fp = path.normalize(path.join(root, rel));
        if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
          res.writeHead(404); return res.end("not found");
        }
        const data = fs.readFileSync(fp);
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
          "Content-Length": data.length, "Accept-Ranges": "bytes", "Connection": "close" }); // no keep-alive
        res.end(data);
      } catch (e) { res.writeHead(500); res.end("error"); }
    });
    srv.keepAliveTimeout = 1;
    srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    srv.once("error", (e) => {
      if (e.code === "EADDRINUSE" && port !== 0) { console.log(`  (port ${port} busy -> using a random port)`); resolve(startStaticServer(root, 0)); }
      else reject(e);
    });
    // close() force-destroys any lingering sockets so server.close never hangs
    // waiting on a keep-alive connection the browser left open.
    const close = () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      if (srv.closeAllConnections) srv.closeAllConnections();
      srv.close(() => r());
    });
    srv.listen(port, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${srv.address().port}`, root, close }));
  });
}

// Resolve args.url to a navigable URL. http(s)/file URLs pass through; a local
// path is served over HTTP (so fetch/XHR and media work) and mapped to a URL.
// Returns { url, server } where server is null for remote URLs.
async function resolveUrl(args) {
  if (/^https?:\/\//i.test(args.url) || /^file:/i.test(args.url)) return { url: args.url, server: null };
  const abs = path.resolve(args.url);
  const server = await startStaticServer(path.dirname(abs));
  server.root = path.dirname(abs); // so mux can resolve served URLs to disk
  return { url: `${server.base}/${encodeURIComponent(path.basename(abs))}`, server };
}

// Poll from Node with REAL timers. We can't use page.waitForFunction here:
// its polling loop runs on the page's requestAnimationFrame/setTimeout, which
// the clock shim has frozen -- so it would block for the full timeout every
// frame. This is the difference between "instant" and "stuck".
async function waitVideosReady(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(() => window.__vclock.videosReady())) return;
    await new Promise((r) => setTimeout(r, 8));
  }
}

function runFfmpeg(ffArgs, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ffArgs, { stdio: [input ? "pipe" : "ignore", "ignore", "ignore"] });
    // Guard against ffmpeg intermittently deadlocking: kill it if it stalls.
    const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch (e) {} reject(new Error("ffmpeg timed out")); }, timeoutMs);
    ff.on("close", (c) => { clearTimeout(timer); c === 0 ? resolve() : reject(new Error("ffmpeg exited " + c)); });
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    if (input) input(ff.stdin);
  });
}

// Retry a flaky async step a couple of times (the mux can deadlock ~1-in-3).
async function withRetry(label, fn, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < tries) console.log(`  (${label} ${e.message}; retry ${i}/${tries - 1})`); }
  }
  throw lastErr;
}

// True if the file has at least one audio stream (used to skip <video> files
// that carry no soundtrack, whose [n:a] reference would otherwise fail ffmpeg).
function hasAudioStream(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { encoding: "utf8" });
    return out.trim().length > 0;
  } catch (e) { return false; }
}

// #1: video dimensions, or null.
function ffprobeDims(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const [w, h] = out.split(",").map(Number);
    if (w && h) return { w, h };
  } catch (e) {}
  return null;
}

// #1: frame-diff / visual-regression. Compares two videos frame-by-frame via a
// difference blend. Returns { pass, maxDiff, avgDiff, frames, diffOut } where
// maxDiff is the peak mean per-frame luma difference (0 = pixel-identical). Also
// writes an amplified "difference video" so you can see exactly where/when they
// diverge. Deterministic (seeded) renders of the same page diff to 0.
async function diffVideos(a, b, opts = {}) {
  // Peak allowed per-pixel difference (0..255) to still PASS. Small default
  // tolerates trivial encode noise; any real visual change blows past it.
  const threshold = opts.threshold != null ? Number(opts.threshold) : 8;
  if (!fs.existsSync(a)) throw new Error(`baseline not found: ${a}`);
  if (!fs.existsSync(b)) throw new Error(`file not found: ${b}`);
  const da = ffprobeDims(a), db = ffprobeDims(b);
  if (da && db && (da.w !== db.w || da.h !== db.h))
    return { pass: false, reason: `dimension mismatch (${da.w}x${da.h} vs ${db.w}x${db.h})`, maxDiff: 255, avgDiff: 255, frames: 0 };

  // FR-B2: mask ignored regions on BOTH inputs (identical black boxes -> those
  // pixels diff to 0). Difference is computed in RGB -- a YUV difference blend
  // zeroes the chroma planes and fabricates color even for identical frames.
  const PAD = 16; // cover JPEG block noise/ringing just outside the region
  const box = (opts.masks || []).map((r) => {
    const x = Math.max(0, Math.round(r.x) - PAD), y = Math.max(0, Math.round(r.y) - PAD);
    return `,drawbox=x=${x}:y=${y}:w=${Math.round(r.w) + 2 * PAD}:h=${Math.round(r.h) + 2 * PAD}:color=black:t=fill`;
  }).join("");
  const prep = `[0:v]format=rgb24${box}[a];[1:v]format=rgb24${box}[b];`;

  // Amplified difference video artifact (contrast-boosted so small diffs show).
  const diffOut = opts.out || sibling(b, ".diff.mp4");
  fs.mkdirSync(path.dirname(path.resolve(diffOut)), { recursive: true });
  await withRetry("diff-video", () => runFfmpeg(["-nostdin", "-y", "-i", a, "-i", b,
    "-filter_complex", `${prep}[a][b]blend=all_mode=difference,eq=contrast=4:brightness=0.06,format=yuv420p`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", diffOut], { timeoutMs: 60000 }));

  // Per-frame difference metric. Equalize R,G,B into gray so chroma-only changes
  // (a color swap at the same luma) still register; read peak (YMAX) per frame,
  // its frame index, and mean (YAVG). Metadata prints to stderr.
  const mix = "colorchannelmixer=.3333:.3333:.3333:0:.3333:.3333:.3333:0:.3333:.3333:.3333:0";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", a, "-i", b,
    "-filter_complex", `${prep}[a][b]blend=all_mode=difference,${mix},format=gray,signalstats,metadata=print`,
    "-f", "null", "-"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const txt = (r.stderr || "") + (r.stdout || "");
  let peak = 0, peakIdx = -1, sum = 0, n = 0, idx = 0, m;
  const reMax = /lavfi\.signalstats\.YMAX=([0-9.]+)/g;
  while ((m = reMax.exec(txt))) { const v = Number(m[1]); if (v > peak) { peak = v; peakIdx = idx; } idx++; }
  const reAvg = /lavfi\.signalstats\.YAVG=([0-9.]+)/g;
  while ((m = reAvg.exec(txt))) { sum += Number(m[1]); n++; }
  const pass = peak <= threshold;

  // FR-B3: on a regression, save the single worst-diff frame as an image.
  let worstFrame = null;
  if (!pass && peakIdx >= 0) {
    worstFrame = sibling(diffOut, ".worst.png");
    try {
      await runFfmpeg(["-nostdin", "-y", "-i", diffOut, "-vf", `select=eq(n\\,${peakIdx})`, "-frames:v", "1", worstFrame], { timeoutMs: 30000 });
    } catch (e) { worstFrame = null; }
  }
  return { pass, maxDiff: peak, avgDiff: n ? sum / n : 0, frames: n, diffOut, worstFrame, worstIndex: peakIdx };
}

// #1: print a VRT verdict.
function reportDiff(res) {
  if (res.reason) { console.log(`\nVRT FAIL: ${res.reason}`); return; }
  console.log(`\nVRT ${res.pass ? "PASS" : "FAIL"}: peak pixel diff ${res.maxDiff.toFixed(1)}/255, mean ${res.avgDiff.toFixed(3)} over ${res.frames} frames`);
  console.log(`  difference video -> ${res.diffOut}`);
  if (res.worstFrame) console.log(`  worst frame (#${res.worstIndex}) -> ${res.worstFrame}`);
}

// Replace dest with src, tolerating Windows EPERM when dest is briefly locked
// (media player / Explorer preview / antivirus / indexer). Retries, then falls
// back to copy; finally throws a clear, actionable error rather than crashing
// after all the render work is done.
async function safeReplace(src, dest, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      if (fs.existsSync(dest)) { try { fs.rmSync(dest, { force: true }); } catch (e) {} }
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      if (i < tries - 1) { await new Promise((r) => setTimeout(r, 250)); continue; }
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); return; }
      catch (e2) {
        throw new Error(`could not write ${dest} -- is it open in another program (video player / Explorer preview)? Close it and re-run. [${e.message}]`);
      }
    }
  }
}

// Mux the wiretapped audio (element / Web Audio / <video> track / oscillator)
// onto the silent video. windowMs = { startMs, endMs } clips to the record
// window, re-bases delays. audioCodec/container are chosen by the output format
// (mp4/mov -> aac, webm -> libopus).
async function muxAudio(silentVideo, finalOut, events, windowMs) {
  const { startMs = 0, endMs = Infinity, durationSec, server, audioCodec = "aac",
          masterWav = null, masterTrimStart = 0 } = windowMs || {};
  // Resolve a source URL to a local file path. URLs served by our own static
  // server map straight to disk -- ffmpeg reading them back over HTTP is flaky
  // and can hang, so we give it a plain file path instead.
  const toFile = (src) => {
    if (src.startsWith("file:")) return fileURLToPath(src);
    if (server && src.startsWith(server.base)) return path.join(server.root, decodeURIComponent(new URL(src).pathname));
    return src; // genuinely remote http(s) -- ffmpeg fetches it
  };
  // In-window events. Two families:
  //   - file-backed (src): element / Web Audio / <video>, resolved to disk.
  //   - synthesized (D: oscillator): generated by ffmpeg's sine source, no URL.
  // #2/#4: when a pass-1 master WAV covers the Web Audio graph, drop the wiretap
  // oscillator/Web-Audio events (already baked into the WAV); keep element/video.
  const srcEvents = masterWav ? events.filter((e) => e && e.kind !== "oscillator" && e.kind !== "webaudio") : events;
  const inWindow = srcEvents.filter((e) => e && e.startMs >= startMs && e.startMs < endMs);
  const fileEvents = inWindow
    .filter((e) => e.src) // any source with a URL
    .map((e) => ({ ...e, file: toFile(e.src) }))
    .filter((e) => (e.file.startsWith("http") ? true : fs.existsSync(e.file)))
    .filter((e) => e.kind !== "video" || hasAudioStream(e.file)); // skip silent/audio-less videos
  // D: OscillatorNode events -> ffmpeg lavfi sine sources (defensive: tolerate
  // missing fields). Requires a positive frequency to be meaningful.
  const oscEvents = inWindow.filter((e) => e.kind === "oscillator" && Number(e.frequency) > 0);
  const muxable = [...fileEvents, ...oscEvents];
  // #2/#4: the pass-1 master WAV plays from the record-window start (seek in by
  // masterTrimStart so it aligns with the visual window).
  if (masterWav) muxable.unshift({ file: masterWav, startMs: startMs, volume: 1, trimStart: masterTrimStart || 0 });

  const skipped = Math.max(0, srcEvents.length - muxable.length);
  if (muxable.length === 0) {
    await safeReplace(silentVideo, finalOut); // robust vs. locked/existing dest
    return { muxed: 0, skipped };
  }

  // Two-pass mux. A single ffmpeg that stream-copies video AND runs a complex
  // audio filtergraph could intermittently deadlock on Windows (the two stages
  // waiting on each other). Splitting into two dead-simple calls avoids it.
  // -nostdin on both so ffmpeg never blocks reading interactive keypresses.
  const dur = durationSec ? durationSec.toFixed(3) : null;
  const mixWav = sibling(finalOut, ".mix.wav");

  // Pass 1: mix all sounds into a standalone, finite WAV (no video involved).
  const aInputs = [];
  const filters = [];
  muxable.forEach((e, i) => {
    if (e.kind === "oscillator") {
      // D: synthesize a sine tone. Defensive on stopMs (default 250ms tone).
      const stop = Number(e.stopMs) || (Number(e.startMs) + 250);
      const toneSec = Math.max(0.01, (stop - Number(e.startMs)) / 1000);
      aInputs.push("-f", "lavfi", "-i", `sine=frequency=${Number(e.frequency)}:duration=${toneSec.toFixed(3)}`);
    } else {
      if (e.loop) aInputs.push("-stream_loop", "-1"); // loop looping <video> audio
      // #3: trim-in -- seek into the source and cap to the trimmed window so the
      // muxed audio aligns with the trimmed video.
      if (e.trimStart) aInputs.push("-ss", String(e.trimStart));
      if (e.trimEnd) aInputs.push("-t", String(e.trimEnd - (e.trimStart || 0)));
      aInputs.push("-i", e.file);
    }
    const d = Math.max(0, Math.round(e.startMs - startMs)); // re-base to window start
    const vol = (e.volume != null ? e.volume : 1);
    // E: playbackRate on a <video>/element input -> atempo speeds up its audio.
    const rate = Number(e.playbackRate);
    const tempo = (rate && rate !== 1) ? `,atempo=${rate}` : "";
    filters.push(`[${i}:a]adelay=${d}|${d}${tempo},volume=${vol.toFixed(3)}[a${i}]`);
  });
  const mixIn = muxable.map((_, i) => `[a${i}]`).join("");
  // Plain amix -> ends at the last sound (finite, terminates fast). No apad:
  // apad generates infinite silence and intermittently deadlocks even with
  // atrim. Pass 2's -t caps the final length to the video, so no pad is needed.
  filters.push(`${mixIn}amix=inputs=${muxable.length}:normalize=0[aout]`);
  // -t caps pass 1 too: a looping <video> uses -stream_loop -1 (infinite input),
  // so the mix must be bounded here or amix would never end.
  const dt = dur ? ["-t", dur] : [];
  await withRetry("audio-mix", () =>
    runFfmpeg(["-nostdin", "-y", ...aInputs, "-filter_complex", filters.join(";"), "-map", "[aout]", ...dt, mixWav], { timeoutMs: 30000 }));

  // Pass 2: mux to a temp, then robustly replace the (possibly locked) output.
  const durArgs = dur ? ["-t", dur] : [];
  const muxedTmp = sibling(finalOut, ".muxed" + path.extname(finalOut));
  await withRetry("mux", () =>
    runFfmpeg(["-nostdin", "-y", "-i", silentVideo, "-i", mixWav,
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", audioCodec, ...durArgs, muxedTmp], { timeoutMs: 30000 }));
  await safeReplace(muxedTmp, finalOut);
  fs.unlinkSync(silentVideo);
  fs.unlinkSync(mixWav);
  return { muxed: muxable.length, skipped };
}

// A + G: run scripted interactions after readiness and before capture. All
// best-effort: a missing selector or a page that rejects an action never throws.
// The page's setTimeout/rAF are frozen by the clock shim, so pacing is driven
// from Node with REAL timers, and the virtual clock is ticked between steps so
// scroll/IntersectionObserver handlers (often scheduled via rAF) actually run.
async function runInteractions(page, args, tickMs) {
  const tick = () => page.evaluate((dt) => window.__vclock && window.__vclock.tick(dt), tickMs).catch(() => {});
  for (const sel of args.clicks) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ timeout: 2000 }).catch(() => {}); await tick(); }
    } catch (e) {}
  }
  // #3: --scroll is now a during-capture tour (handled in the capture loop), not
  // a pre-capture warm-up -- so nothing to do here for it.
  if (args.wait > 0) await new Promise((r) => setTimeout(r, args.wait));
}

// #1: parse a "--do" spec "<action>@<seconds>" into { atMs, verb, sel, arg }.
// Verbs: click <sel> | type <sel> <text...> | hover <sel> | scrollto <sel> |
// press <sel> <Key> | key <Key>. The @<seconds> suffix is a point on the RECORD
// timeline (same units as --duration). Returns null on a malformed spec.
function parseDoAction(spec) {
  const at = spec.lastIndexOf("@");
  if (at < 0) { console.log(`  (--do "${spec}" missing @<seconds>; ignored)`); return null; }
  const seconds = Number(spec.slice(at + 1));
  const body = spec.slice(0, at).trim();
  if (!isFinite(seconds)) { console.log(`  (--do "${spec}" bad seconds; ignored)`); return null; }
  const sp = body.indexOf(" ");
  const verb = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const remainder = sp < 0 ? "" : body.slice(sp + 1).trim();
  const action = { atMs: seconds * 1000, verb, sel: null, arg: null };
  if (verb === "key") {
    action.arg = remainder; // global keyboard press: the Key name
  } else if (verb === "type" || verb === "press") {
    // "type <sel> <text...>" / "press <sel> <Key>": split off the first token.
    const s = remainder.indexOf(" ");
    action.sel = s < 0 ? remainder : remainder.slice(0, s);
    action.arg = s < 0 ? "" : remainder.slice(s + 1); // text may contain spaces
  } else if (verb === "click" || verb === "hover" || verb === "scrollto") {
    action.sel = remainder;
  } else {
    console.log(`  (--do "${spec}" unknown verb "${verb}"; ignored)`); return null;
  }
  return action;
}

// #1: execute one timed action via Playwright. Best-effort: a missing selector
// or a rejected action logs and returns (never throws). The page's resulting
// timers/animations are captured by the virtual clock on subsequent frames.
async function runDoAction(page, action) {
  try {
    if (action.verb === "key") { await page.keyboard.press(action.arg); return; }
    const el = await page.$(action.sel);
    if (!el) { console.log(`\n  (--do ${action.verb} "${action.sel}": no match)`); return; }
    if (action.verb === "click") await el.click({ timeout: 2000 });
    else if (action.verb === "hover") await el.hover({ timeout: 2000 });
    else if (action.verb === "scrollto") await el.scrollIntoViewIfNeeded({ timeout: 2000 });
    else if (action.verb === "type") await el.type(action.arg, { timeout: 2000 });
    else if (action.verb === "press") await el.press(action.arg, { timeout: 2000 });
  } catch (e) {
    console.log(`\n  (--do ${action.verb} "${action.sel || action.arg}": ${e.message})`);
  }
}

// #4: resolve the effective window.__params object from --data (inline JSON or
// @path). Returns null when not given (so no init script is injected).
function resolveParams(args) {
  if (args.data == null) return null;
  try {
    const raw = args.data.startsWith("@")
      ? fs.readFileSync(args.data.slice(1), "utf8")
      : args.data;
    return JSON.parse(raw);
  } catch (e) { console.error(`--data parse error: ${e.message}`); process.exit(1); }
}

// --- smart defaults: readiness + auto-duration ---------------------------
const READY_MAX_MS = 8000;   // cap on the auto-wait-until-stable
const READY_QUIET_MS = 400;  // page must be quiet this long to count as stable
const AUTO_DURATION_CAP = 30; // seconds; upper bound when derived from the page
const DEFAULT_DURATION = 5;  // seconds; fallback when auto-derivation finds nothing
const WALK_SPEED = 500; // #3: walkthrough auto-scroll speed (px/s) for auto-duration

// Injected before page code: count DOM mutations so the Node side can tell when
// the page has settled (the page clock is frozen, so we can't time this in-page).
const MUTATION_PROBE = "window.__mutationCount=0;(function(){try{var o=new MutationObserver(function(m){window.__mutationCount+=m.length;});var s=function(){o.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});};if(document.documentElement)s();else addEventListener('DOMContentLoaded',s);}catch(e){}})();";

// Auto-wait until the page is visually stable: fonts ready, network idle, no DOM
// mutations for a quiet window, and images decoded. Bounded by maxMs, driven from
// Node with REAL timers. Replaces guessing --wait for most pages.
async function autoWaitStable(page, maxMs = READY_MAX_MS, quietMs = READY_QUIET_MS) {
  const start = Date.now();
  await page.waitForLoadState("networkidle", { timeout: maxMs }).catch(() => {});
  await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => true) : true).catch(() => {});
  let last = -1, quietStart = 0;
  while (Date.now() - start < maxMs) {
    const st = await page.evaluate(() => ({
      m: window.__mutationCount || 0,
      imgs: Array.from(document.images || []).some((i) => i.src && !i.complete),
    })).catch(() => ({ m: last, imgs: false }));
    if (st.m === last && !st.imgs) {
      if (!quietStart) quietStart = Date.now();
      if (Date.now() - quietStart >= quietMs) return;
    } else { quietStart = 0; last = st.m; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Clamp a content-end estimate (ms) to a sane render length (s), or null.
function autoDurationSec(endMs) {
  if (!endMs || endMs <= 0) return null;
  return Math.min(AUTO_DURATION_CAP, Math.max(1, Math.ceil(endMs / 1000)));
}

const DWELL_S = 0.7; // FR-C2: seconds to pause at each section during a tour
// FR-C2: scroll Y at a normalized progress (0..1) from a keyframe plan
// [{t,y}...]; piecewise-linear so the tour dwells at sections and glides between.
function scrollYAtProg(prog, kf) {
  if (!kf || !kf.length) return 0;
  for (let k = 1; k < kf.length; k++) {
    if (prog <= kf[k].t) {
      const a = kf[k - 1], b = kf[k], span = (b.t - a.t) || 1;
      return a.y + (b.y - a.y) * ((prog - a.t) / span);
    }
  }
  return kf[kf.length - 1].y;
}

// --cookies support -------------------------------------------------------
// Reach auth-gated / Cloudflare-cleared pages by replaying a cookies payload
// exported from your logged-in browser (e.g. via the sweet-cookie extension)
// into a fresh context. The browser exports its own already-decrypted cookies,
// so this sidesteps Chrome 127+ App-Bound Encryption entirely -- we never try to
// read or launch your real profile, we just inject the cookies it handed us.

// Parse an exported cookie payload -- a Cookie[] or { cookies: Cookie[] } (the
// sweet-cookie inline format) -- into Playwright context.addCookies() shape.
function loadCookies(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.cookies) ? raw.cookies : null);
  if (!list) throw new Error(`${file}: expected a cookie array or { cookies: [...] }`);
  // chrome.cookies / sweet-cookie sameSite spellings -> Playwright's.
  const ss = { no_restriction: "None", lax: "Lax", strict: "Strict", none: "None", unspecified: null };
  return list.map((c) => {
    if (!c || !c.name) throw new Error(`${file}: a cookie is missing "name"`);
    const out = { name: c.name, value: String(c.value ?? "") };
    if (c.domain) { out.domain = c.domain; out.path = c.path || "/"; }
    else if (c.url) out.url = c.url;
    else throw new Error(`${file}: cookie "${c.name}" needs a domain or url`);
    if (typeof c.expires === "number" && c.expires > 0) out.expires = c.expires;
    if (typeof c.httpOnly === "boolean") out.httpOnly = c.httpOnly;
    if (typeof c.secure === "boolean") out.secure = c.secure;
    const s = typeof c.sameSite === "string" ? (ss[c.sameSite.toLowerCase()] ?? c.sameSite) : null;
    if (s) out.sameSite = s;
    if (out.sameSite === "None") out.secure = true; // Playwright requires it
    return out;
  });
}

// Open a browser context for a render pass, injecting --cookies if provided.
// In stealth mode (auto-enabled on a detected bot wall) it launches real Chrome
// (channel) with automation flags disabled; rebrowser-patches (applied to
// playwright-core) already fix the Runtime.enable CDP leak in the main world.
// Returns { context, browser, close }.
async function openBrowserContext(args, { headless }) {
  // Stealth must run headful: real Cloudflare blocks headless real-Chrome
  // indefinitely (the challenge never issues cf_clearance), whereas a headful
  // window clears the managed challenge instantly. This is why stealth needs a
  // real desktop session (see docs/cloudflare-stealth.md).
  const launchOpts = args._stealth
    ? { headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] }
    : { headless };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height }, deviceScaleFactor: 1 });
  if (args.cookies) await context.addCookies(loadCookies(args.cookies));
  return { context, browser, close: () => browser.close() };
}

// --- bot-wall auto-detection + stealth dormant-shim load ------------------
// Some public URLs sit behind Cloudflare/bot walls. A headless browser gets
// flagged indefinitely, and our frozen clock can't complete the JS challenge.
// When a wall is detected we switch to real Chrome (HEADFUL) + rebrowser-patched
// Playwright (main-world injection preserved, CDP leak fixed) and inject the clock
// shim DORMANT: the page keeps a real clock so the challenge can clear, then we
// arm() the frozen clock in-place for deterministic capture -- no reload (these
// sites re-challenge on every navigation). See docs/cloudflare-stealth.md.

const CHALLENGE_DOM = "#challenge-running, #challenge-stage, iframe[src*='challenges.cloudflare.com']";
// Evaluated in-page: is this currently a bot-wall/challenge screen?
const CHALLENGE_PROBE = (sel) => {
  const re = /just a moment|attention required|verifying you are human|security verification|checking your browser/i;
  return re.test(document.title || "") || !!document.querySelector(sel);
};

// Is `page` showing a bot wall? Response signals first (Cloudflare's cf-mitigated
// header / 403/503 + server), then in-page title/DOM markers.
async function isBotWall(resp, page) {
  try {
    const h = resp ? resp.headers() : {};
    const status = resp ? resp.status() : 0;
    if ("cf-mitigated" in h) return true;
    if ([403, 503, 429].includes(status) && /cloudflare/i.test(h["server"] || "")) return true;
  } catch {}
  return page.evaluate(CHALLENGE_PROBE, CHALLENGE_DOM).catch(() => false);
}

// Pre-flight: load `url` in a plain browser and report whether it's walled.
async function detectBotWall(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    return await isBotWall(resp, page);
  } catch { return false; } finally { await browser.close().catch(() => {}); }
}

// Wait for a live challenge to clear (markers disappear), or time out.
async function waitForClearance(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const walled = await page.evaluate(CHALLENGE_PROBE, CHALLENGE_DOM).catch(() => false);
    if (!walled) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Navigate `page` to `url`, injecting `initScripts` (strings) before page code.
// Normal: inject, then goto. Stealth: inject the shim DORMANT (real clock, page
// left pristine), do ONE live navigation so Cloudflare's challenge clears on a
// real clock, THEN arm the frozen clock in-place -- no reload.
//
// Why not the old goto-then-reload? A frozen clock can't complete the challenge,
// and this site (e.g. CodePen /full/) re-challenges on EVERY navigation --
// cf_clearance does NOT let a reload skip it -- so reloading a shimmed page just
// re-triggers the challenge against a frozen clock (deadlock). Injecting dormant
// and arming after clearance keeps the clock real for the whole challenge and
// frozen only for capture. See docs/cloudflare-stealth.md.
async function navigateWithInit(page, url, initScripts, args) {
  if (!args._stealth) {
    for (const s of initScripts) await page.addInitScript(s);
    return page.goto(url, { waitUntil: "load" });
  }
  await page.addInitScript("window.__vclockDeferred = true;"); // shim stays dormant
  for (const s of initScripts) await page.addInitScript(s);
  await page.goto(url, { waitUntil: "load" }).catch(() => {}); // challenge runs on real clock
  if (!(await waitForClearance(page, 25000)))
    throw new Error(
      "Cloudflare challenge did not clear -- likely an interactive Turnstile or an Enterprise zone " +
      "that a free automated stack can't pass.\n" +
      "  Try:  --cookies <file>  with a cf_clearance exported from your real Chrome (its UA now matches\n" +
      "        stealth mode's real Chrome), or capture the page out-of-band. See docs/cloudflare-stealth.md");
  // Cleared on the real clock -> freeze the clock in-place for deterministic capture.
  await page.evaluate(() => { if (window.__vclock && window.__vclock.arm) window.__vclock.arm(); });
}

async function renderAudioPass(url, args, params, shim, seedVal, plannedEndSec) {
  const { context, close } = await openBrowserContext(args, { headless: true });
  try {
    const page = await context.newPage();
    // The OfflineAudioContext length is fixed when AudioContext is constructed,
    // before we know an auto-duration -- so size it to the cap and trim later.
    const auto = args.duration == null && args.end == null; // no explicit length
    const bufSec = auto ? AUTO_DURATION_CAP : plannedEndSec;
    const initScripts = [
      `window.__seed = ${seedVal};`,
      `window.__audioCaptureMode = true; window.__audioDurationSec = ${bufSec};`,
      MUTATION_PROBE,
      shim,
    ];
    if (params != null) initScripts.push(`window.__params = ${JSON.stringify(params)};`);
    await navigateWithInit(page, url, initScripts, args);
    await autoWaitStable(page);
    await runInteractions(page, args, 1000 / args.fps); // same triggers as the visual pass
    // Resolve the render length: auto -> the page's contentEndMs, else planned.
    let endSec = plannedEndSec;
    if (auto)
      endSec = autoDurationSec(await contentEndMs(page)) || plannedEndSec;
    const frameInterval = 1000 / args.fps;
    await tickFrames(page, frameInterval, Math.round(endSec * args.fps));
    const used = await page.evaluate(() => !!window.__audioUsed).catch(() => false);
    if (!used) return { pcm: null, endSec };
    const pcm = await page.evaluate(() => window.__renderAudio()).catch(() => null);
    if (pcm && pcm.channels) { // trim the cap-sized buffer back to endSec
      const n = Math.min(pcm.length || 0, Math.ceil(endSec * pcm.sampleRate));
      pcm.channels = pcm.channels.map((c) => c.slice(0, n));
      pcm.length = n;
    }
    return { pcm, endSec };
  } finally { await close(); }
}

// Serialize rendered PCM to a 16-bit WAV (for muxing + captions).
function writeWav(pcm, outPath) {
  const { channels, sampleRate } = pcm;
  const numCh = channels.length, len = channels[0] ? channels[0].length : 0;
  const blockAlign = numCh * 2, dataLen = len * blockAlign;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numCh, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i] || 0));
      buf.writeInt16LE(s < 0 ? s * 32768 : s * 32767, off); off += 2;
    }
  fs.writeFileSync(outPath, buf);
}

// Downmix rendered PCM to a mono Int16 base64 blob for the pass-2 AnalyserNode
// shim (compact enough to inject as an init script).
function pcmToMonoB64(pcm) {
  const ch = pcm.channels, n = ch.length, len = ch[0] ? ch[0].length : 0;
  const buf = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    let s = 0; for (let c = 0; c < n; c++) s += ch[c][i] || 0; s /= n || 1;
    s = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(s < 0 ? s * 32768 : s * 32767, i * 2);
  }
  return buf.toString("base64");
}

// Full help: lists every flag. Common ones first, then the advanced groups
// (captions, interaction, data, audio, regression, auth).
function printHelp() {
  const p = (s) => console.log(s);
  p("browser-video-renderer -- film any web page as video\n");
  p("Usage: node render.js <url|file> [options]\n");
  p("Common options:");
  p("  --out <path>       output file; extension picks the format");
  p("                     (.mp4/.webm/.mov/.mkv/.gif; a directory = PNG frame sequence)");
  p("  --duration <s>     fixed clip length (default: auto — derived from the page)");
  p("  --fps <n>          frames per second (default 30)");
  p("  --size <WxH>       frame size (default 1280x720)");
  p("  --scroll           tour the page: auto-scroll top->bottom during capture (auto-scales length)");
  p("\nJust the URL usually works — length and readiness are detected automatically:");
  p("  node render.js https://example.com");
  p("\nTiming (length is auto-derived from the page unless you set one of these):");
  p("  --start <s>        start of the record window (default 0)");
  p("  --end <s>          end of the record window (length = end - start)");
  p("\nInteraction:");
  p("  --click <sel>      click a selector before capture (repeatable)");
  p("  --wait <ms>        extra wait before capture (readiness is auto-detected; this is a manual pad)");
  p('  --do "<act>@<s>"   timed action during capture: click/type/hover/scrollto/press/key (repeatable)');
  p("\nData (templated renders):");
  p("  --data <json|@file>  inject as window.__params (URL query params also work)");
  p("\nCaptions (transcribe the page's own audio):");
  p("  --captions         write <out>.srt (whisper.cpp default; needs WHISPER_MODEL)");
  p("  --burn             also hardsub captions into the video");
  p("                     engine/language via env: BVR_ASR=whisper|openai, BVR_LANG=<code>");
  p("\nVisual regression (deterministic renders diff to zero):");
  p("  --baseline <file>  after rendering, compare to this baseline; exit 1 on regression");
  p("                     (missing baseline is saved automatically); writes <out>.diff.mp4");
  p("                     + <out>.diff.worst.png; catches motion + color changes");
  p("  --update-baseline  (re)save this render as the baseline");
  p("  --mask <sel|x,y,w,h>  ignore a region in the diff (CSS selector or rect; repeatable)");
  p("  --threshold <n>    max peak pixel diff (0..255) to still PASS (default 8)");
  p("\nAuth:");
  p("  --cookies <file>   inject cookies exported from your logged-in browser so gated");
  p("                     pages render authenticated (JSON: a cookie array or {cookies:[..]},");
  p("                     e.g. from the sweet-cookie extension)");
  p('\nVideo trim-in: media fragment on the page\'s <video> -- src="clip.mp4#t=5,10"');
  p('Transparent video: a luma-mask companion -- <video src="v.mp4" maskSrc="mask.mp4">');
  p("Animated GIF/APNG/WebP and SVG SMIL (<animate>) are captured deterministically.");
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(process.argv);
  // Explicit --help/-h, or a bare invocation with no input, prints help.
  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs.length === 0) {
    printHelp();
    return;
  }
  if (!args.url) { printHelp(); process.exit(1); }

  // This tool renders video. A single image output (poster.png / .jpg) is not
  // supported; an extension-less --out (a directory) is a PNG frame *sequence*.
  if (args.out && /\.(png|jpe?g)$/i.test(args.out)) {
    console.error("Image output (.png/.jpg) is not supported -- this tool renders video. Use a video extension (.mp4/.webm/.mov/.mkv/.gif), or an extension-less --out for a PNG frame sequence.");
    process.exit(1);
  }

  // #1: parse timed mid-capture actions up front.
  args.doList = args.doActions.map(parseDoAction).filter(Boolean);

  // Auto-detect a bot wall on external URLs; if walled, transparently switch to
  // stealth mode (patched Chrome + deferred clock). Local files never trigger it.
  if (/^https?:\/\//i.test(args.url)) {
    args._stealth = await detectBotWall(args.url);
    if (args._stealth)
      console.log("  bot protection detected -> stealth mode (patched Chrome; live-clear then deterministic capture)");
  }

  // #4: single render with params from --data (or null). URL query params also
  // work with no code -- we navigate to the URL verbatim, so "page.html?x=1"
  // reaches the page as-is.
  await renderOne(args, resolveParams(args));
}

// The full per-render pipeline (previously the body of main). Renders one video
// for the given args + params object.
async function renderOne(args, params) {

  // F: the container is inferred from the --out extension (default mp4); an
  // extension-less --out (a directory) means a PNG frame sequence.
  let format = "mp4";
  if (args.out) {
    const ext = path.extname(args.out).slice(1).toLowerCase();
    if (ext && FORMATS[ext]) format = ext;
    else if (!ext) format = "png"; // directory of frames
  }
  // Video codec is the container's default (mp4/mkv->h264, webm->vp9, mov->prores).
  const vcodec = containerCodec(format);
  const isSequence = format === "png"; // png = numbered image sequence in out dir

  // Resolve the target URL, auto-serving local files over HTTP.
  const { url, server } = await resolveUrl(args);

  // Default output: derive a name from the input -> out/<name>.<format>
  if (!args.out) {
    let name = "video";
    try {
      const seg = server ? path.basename(args.url) : (new URL(url).pathname.split("/").filter(Boolean).pop() || new URL(url).hostname);
      name = (seg || "video").replace(/\.[^.]+$/, "") || "video";
    } catch (e) {}
    // png sequence: out is a directory; frames land inside as %06d.png.
    args.out = isSequence ? `out/${name}` : `out/${name}.${format}`;
  }

  const frameInterval = 1000 / args.fps;
  const shim = loadShim("clock-shim.js");
  const seedVal = SEED_VALUE;

  const outAbs = path.resolve(args.out);
  // png sequence: outAbs is a directory of frames; others: a single file.
  fs.mkdirSync(isSequence ? outAbs : path.dirname(outAbs), { recursive: true });
  // Silent intermediate lives next to the output; extension picked so the
  // container matches the video codec (vp9->webm, prores->mov, else mp4).
  const silentExt = format === "gif" ? "mkv" // ffv1 lossless intermediate
                  : (format === "webm" ? "webm" : format === "mov" ? "mov" : format === "mkv" ? "mkv" : "mp4");
  const silent = sibling(outAbs, ".silent." + silentExt);

  // #2/#4: pass 1 -- pre-render the page's Web Audio graph to exact PCM (runs
  // AudioWorklets). Also resolves auto-duration up front (from its own load), so
  // the visual pass and the PCM agree. Skipped for gif / png sequence.
  const auto = args.duration == null && args.end == null; // no explicit --duration/--end
  let audioPCM = null;
  const audioEligible = !isSequence && format !== "gif";
  if (audioEligible) {
    const plannedEndSec = args.end != null ? args.end : args.start + (args.duration ?? DEFAULT_DURATION);
    try {
      const res = await renderAudioPass(url, args, params, shim, seedVal, plannedEndSec);
      if (res) {
        // Adopt the resolved auto-duration so the record window matches the PCM.
        if (auto) args.duration = Math.max(1, res.endSec - args.start);
        if (res.pcm && res.pcm.channels && res.pcm.length) {
          audioPCM = res.pcm;
          console.log(`  audio: pre-rendered Web Audio graph (${res.pcm.length} samples @ ${res.pcm.sampleRate}Hz)`);
        }
      }
    } catch (e) { console.log(`  (audio pre-render skipped: ${e.message})`); }
  }

  const { context, close } = await openBrowserContext(args, { headless: true });
  const page = await context.newPage();
  // Ordered init scripts (seed BEFORE shim; PCM before shim; params after shim),
  // built as a list so the stealth two-phase loader can defer them past the wall clear.
  const initScripts = [`window.__seed = ${seedVal};`]; // #6
  if (audioPCM) // #2: feed pass-1 PCM to the AnalyserNode shim before it installs
    initScripts.push(`window.__audioPCM = { b64: ${JSON.stringify(pcmToMonoB64(audioPCM))}, sampleRate: ${audioPCM.sampleRate} };`);
  initScripts.push(MUTATION_PROBE, shim);
  if (params != null) initScripts.push(`window.__params = ${JSON.stringify(params)};`); // #4
  await navigateWithInit(page, url, initScripts, args);
  // Smart readiness: wait until the page is visually stable before capturing
  // (fonts, network idle, DOM quiet, images decoded) -- no manual --wait needed.
  await autoWaitStable(page);

  // FR-B2: resolve --mask entries to pixel rects while the page is live. A
  // "x,y,w,h" mask is literal; anything else is a CSS selector -> its bounding
  // box (used at diff time to ignore that region).
  let maskRects = [];
  if (args.baseline && args.masks.length) {
    for (const spec of args.masks) {
      const nums = spec.split(",").map(Number);
      if (nums.length === 4 && nums.every((v) => !isNaN(v))) {
        maskRects.push({ x: nums[0], y: nums[1], w: nums[2], h: nums[3] });
      } else {
        const rect = await page.evaluate((sel) => {
          const el = document.querySelector(sel); if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }, spec).catch(() => null);
        if (rect && rect.w > 0 && rect.h > 0) maskRects.push(rect);
        else console.log(`  (mask "${spec}" matched nothing; ignored)`);
      }
    }
  }

  // Auto-decode: if the page has a <video>, decode it deterministically via
  // WebCodecs (mp4box + our decoder). Inject with addScriptTag (real <script>,
  // global scope) -- addInitScript wraps code in a function, so mp4box's global
  // would never reach window.
  // Deterministic media: decode <video> (mp4box+WebCodecs) and animated <img>
  // (gif/apng/webp via ImageDecoder) onto canvases seeked to virtual time --
  // media-decoder.js handles both. mp4box is only needed for the <video> path.
  // addScriptTag (real <script>, global scope) -- addInitScript wraps in a
  // function, so mp4box's global would never reach window.
  const hasVideo = await page.evaluate(() => !!document.querySelector("video"));
  const hasAnimImg = await page.evaluate(() =>
    [...document.querySelectorAll("img")].some((i) => /\.(gif|apng|webp|png)(\?|#|$)/i.test(i.currentSrc || i.src || "")));
  // The decoder is injected as a real <script> (addScriptTag) so mp4box's global
  // reaches window -- but that path is subject to the page's CSP. On strict-CSP
  // sites (codepen, stripe, ...) the inline <script> is refused; decode is only
  // an enhancement, so degrade to native <video>/<img> rendering instead of
  // aborting the whole render (mirrors the h264 -> native seek fallback).
  let decodeInjected = hasVideo || hasAnimImg;
  if (decodeInjected) {
    try {
      if (hasVideo)
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "vendor/mp4box.iife.js"), "utf8") });
      await page.addScriptTag({ content: loadShim("media-decoder.js") });
    } catch (e) {
      decodeInjected = false;
      console.log(`  (media decode unavailable: ${String(e.message || e).split("\n")[0]}; using native playback)`);
    }
  }
  if (decodeInjected) await waitVideosReady(page, hasVideo ? 20000 : 8000); // decode needs longer

  // A: scripted interactions -- after load/readiness, before the capture loop.
  await runInteractions(page, args, frameInterval);

  // C: auto-duration -- ask the page how long its content runs (default ON). When
  // the audio pass ran it already resolved this up front, so only do it here for
  // the non-audio path (gif/png sequence). Falls back to the
  // 5s default when the page reports nothing.
  if (auto && !audioEligible) {
    const s = autoDurationSec(await contentEndMs(page));
    if (s) args.duration = s;
  }

  // #3/FR-C2: --scroll -- tour the page top->bottom during capture, pausing at
  // each major section. Length scales to distance + dwell (auto) unless a fixed
  // --duration/--end was given. Falls back to a linear scroll if no clear
  // sections. scrollPlan is a normalized [{t,y}] keyframe list, or null (linear).
  let maxScroll = 0, scrollPlan = null;
  if (args.scroll) {
    const info = await page.evaluate(() => {
      const max = Math.max(0, (document.documentElement.scrollHeight || document.body.scrollHeight || 0) - window.innerHeight);
      const tops = Array.from(document.querySelectorAll("section, header, footer, main, article"))
        .map((el) => Math.round(el.getBoundingClientRect().top + window.scrollY))
        .filter((t) => t >= 0 && t <= max);
      return { max, vh: window.innerHeight, tops };
    }).catch(() => ({ max: 0, vh: 0, tops: [] }));
    maxScroll = info.max;
    // Unique, well-spaced stops (>= half a viewport apart), always ending at max.
    let stops = Array.from(new Set([0, ...info.tops, maxScroll])).sort((a, b) => a - b);
    const spaced = [];
    for (const s of stops) if (!spaced.length || s - spaced[spaced.length - 1] >= info.vh * 0.5) spaced.push(s);
    if (spaced[spaced.length - 1] !== maxScroll && maxScroll > 0) spaced.push(maxScroll);

    if (spaced.length >= 3 && maxScroll > 0) {
      // Build dwell+travel segments, then normalize to [0,1] keyframes.
      const segs = [];
      for (let k = 0; k < spaced.length; k++) {
        segs.push({ dur: DWELL_S, y0: spaced[k], y1: spaced[k] }); // dwell
        if (k < spaced.length - 1) segs.push({ dur: Math.max(0.3, (spaced[k + 1] - spaced[k]) / WALK_SPEED), y0: spaced[k], y1: spaced[k + 1] });
      }
      const T = segs.reduce((a, s) => a + s.dur, 0);
      scrollPlan = []; let acc = 0;
      for (const s of segs) { scrollPlan.push({ t: acc / T, y: s.y0 }); acc += s.dur; scrollPlan.push({ t: acc / T, y: s.y1 }); }
      if (auto)
        args.duration = Math.min(AUTO_DURATION_CAP, Math.max(3, Math.ceil(T)));
    } else if (auto && maxScroll > 0) {
      args.duration = Math.min(AUTO_DURATION_CAP, Math.max(3, Math.ceil(maxScroll / WALK_SPEED)));
    }
  }

  // C1: record only the window [start, end). Frames before start are advanced
  // (clock + callbacks) but not captured -- they also serve to warm things up.
  const startFrame = Math.round(args.start * args.fps);
  if (args.duration == null) args.duration = DEFAULT_DURATION; // auto found nothing
  const endSec = args.end != null ? args.end : args.start + args.duration;
  const endFrame = Math.round(endSec * args.fps);
  const captureFrames = endFrame - startFrame;

  console.log(`Rendering ${url}`);
  console.log(`  ${args.width}x${args.height} @ ${args.fps}fps, record [${args.start}s, ${endSec}s) = ${captureFrames} frames`);
  console.log(`  format ${format}${vcodec ? "/" + vcodec : ""}`);
  if (startFrame > 0) console.log(`  (advancing ${startFrame} skip-frames before recording)`);
  console.log(`  -> ${args.out}\n`);

  // JPEG q80 -- far faster to encode than PNG (the main per-frame cost).
  // page.screenshot() (CDP Page.captureScreenshot) already flushes the
  // compositor before capturing, so no separate "wait for paint" is needed
  // (verified: frames are byte-identical with or without it).
  const capture = () => page.screenshot({ type: "jpeg", quality: 80 });

  // A2: prime the compositor with throwaway frames so the first captured frame
  // isn't stale/blank, then honor an optional window.__renderReady gate (a page
  // can set window.__renderReady=false until fonts/data/etc. are ready).
  for (let i = 0; i < 3; i++) await capture().catch(() => {});
  {
    const t0 = Date.now();
    while (Date.now() - t0 < args.warmup) {
      const ready = await page.evaluate(() => (window.__renderReady === undefined ? true : !!window.__renderReady));
      if (ready) break;
      await capture().catch(() => {}); // keep compositor warm while waiting
      await new Promise((r) => setTimeout(r, 33));
    }
  }

  // F: video-codec args for the piped encoder (frames in on stdin -> intermediate).
  //   - png sequence: frames are written straight to out/%06d.png (no encoder).
  //   - gif: encode a lossless intermediate first, then 2-pass palette convert.
  //   - video: x264 yuv420p (mp4/mkv), vp9 yuv420p (webm), prores (mov).
  let encodeArgs;
  if (isSequence) {
    // image2 sequence: numbered PNGs. -frames caps at captureFrames.
    encodeArgs = ["-frames:v", String(captureFrames), path.join(outAbs, "%06d.png")];
  } else if (format === "gif") {
    // Lossless intermediate (ffv1) -> keeps the 2-pass gif conversion crisp.
    encodeArgs = ["-c:v", "ffv1", silent];
  } else {
    // container's default codec (h264 mp4/mkv, vp9 webm, prores mov).
    encodeArgs = videoEncodeArgs(format, vcodec, silent);
  }

  // Force the input decoder for the piped JPEG frames (mjpeg). Without this,
  // `image2pipe` auto-probing fails to split very small concatenated JPEGs
  // (e.g. a small, simple viewport), and the encoder gets an invalid stream
  // -> "Error opening output file: Invalid argument".
  const inputCodec = "mjpeg";
  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-f", "image2pipe", "-c:v", inputCodec, "-framerate", String(args.fps), "-i", "-", ...encodeArgs],
    { stdio: ["pipe", "ignore", "ignore"] }
  );
  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpeg.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg(silent) exited " + c))));
    ffmpeg.on("error", reject);
  });

  // #1: timed mid-capture actions. Each action's time is on the RECORD timeline,
  // so its absolute virtual ms = start*1000 + atMs. An action fires when the
  // virtual clock crosses it -- i.e. its ms falls in the current frame step
  // [prevElapsed, elapsed) -- BEFORE that frame is captured. Sorted so multiple
  // actions in one step fire in time order; fired[] guards against re-firing.
  const startMsOffset = args.start * 1000;
  const timed = (args.doList || [])
    .map((a) => ({ ...a, absMs: startMsOffset + a.atMs }))
    .sort((x, y) => x.absMs - y.absMs);
  const fired = new Array(timed.length).fill(false);

  const startedAt = Date.now();
  let captured = 0;
  let prevElapsed = 0;
  for (let i = 0; i < endFrame; i++) {
    // #3: --scroll tour -- position the scroll for this frame BEFORE ticking, so
    // scroll-triggered handlers (IntersectionObserver / rAF) run this step.
    if (args.scroll && maxScroll > 0) {
      const prog = captureFrames > 1 ? Math.max(0, Math.min(1, (i - startFrame) / (captureFrames - 1))) : 1;
      const y = scrollPlan ? scrollYAtProg(prog, scrollPlan) : maxScroll * prog; // FR-C2: dwell at sections when planned
      await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y)).catch(() => {});
    }
    await page.evaluate((dt) => window.__vclock.tick(dt), frameInterval);
    const elapsedNow = (i + 1) * frameInterval;
    // #1: fire any actions whose time fell in this frame step, before capture.
    for (let k = 0; k < timed.length; k++) {
      if (!fired[k] && timed[k].absMs >= prevElapsed && timed[k].absMs < elapsedNow) {
        fired[k] = true;
        await runDoAction(page, timed[k]);
      }
    }
    prevElapsed = elapsedNow;
    const recording = i >= startFrame;
    // Only pay the sync/paint waits when we're actually capturing this frame.
    if (hasVideo && recording) await waitVideosReady(page, 1000);

    if (recording) {
      const buf = await capture();
      if (!ffmpeg.stdin.write(buf)) await new Promise((res) => ffmpeg.stdin.once("drain", res));
      process.stdout.write(`\r  frame ${++captured}/${captureFrames}`);
    } else {
      process.stdout.write(`\r  skip ${i + 1}/${startFrame}`);
    }
  }
  ffmpeg.stdin.end();
  await ffmpegDone;

  const events = await page.evaluate(() => window.__vclock.audioEvents());
  if (decodeInjected) {
    const ds = await page.evaluate(() => window.__decoderStats);
    console.log(`  decode: ${ds.videos} video(s), ${ds.images || 0} image(s), ${ds.frames} frames decoded` +
      (ds.errors.length ? `, errors: ${ds.errors.slice(0, 3).join(" | ")}` : ""));
  }
  await close();

  let muxed = 0, skipped = 0;
  const audioCodec = audioCodecFor(format);
  const durationSec = captureFrames / args.fps;
  if (isSequence) {
    // png sequence: frames already written; no audio to mux.
    skipped = events.length;
  } else if (format === "gif") {
    // 2-pass palettegen/paletteuse from the lossless intermediate. No audio.
    const palette = sibling(silent, ".palette.png");
    const gifTmp = sibling(outAbs, ".tmp.gif");
    await withRetry("gif-palette", () =>
      runFfmpeg(["-nostdin", "-y", "-i", silent, "-vf", "palettegen", palette], { timeoutMs: 30000 }));
    await withRetry("gif-encode", () =>
      runFfmpeg(["-nostdin", "-y", "-i", silent, "-i", palette,
        "-lavfi", "paletteuse", gifTmp], { timeoutMs: 60000 }));
    await safeReplace(gifTmp, outAbs); // robust vs. locked/existing dest
    fs.unlinkSync(silent);
    fs.unlinkSync(palette);
    skipped = events.length;
  } else {
    // #2/#4: serialize the pass-1 PCM to a WAV and mix it in as the master track.
    let masterWav = null;
    if (audioPCM) {
      masterWav = sibling(silent, ".master.wav");
      writeWav(audioPCM, masterWav);
    }
    const res = await muxAudio(silent, outAbs, events,
      { startMs: args.start * 1000, endMs: endSec * 1000, durationSec, server, audioCodec,
        masterWav, masterTrimStart: args.start });
    muxed = res.muxed; skipped = res.skipped;

    // #5: auto-captions -- transcribe the audio into a .srt sidecar (and
    // optionally burn it in). Prefer the master WAV (clean speech track) when
    // present. Never fails the render; skips cleanly if ASR/speech is missing.
    if (args.captions) {
      const audioSrc = (masterWav && fs.existsSync(masterWav)) ? masterWav : outAbs;
      const cap = await generateCaptions(audioSrc, outAbs,
        { asr: (process.env.BVR_ASR || "whisper").toLowerCase(),
          lang: process.env.BVR_LANG || undefined, burn: args.burn });
      if (cap.srt) console.log(`  captions -> ${cap.srt}${cap.burned ? " (burned in)" : ""}`);
    }
    if (masterWav) { try { fs.unlinkSync(masterWav); } catch (e) {} }
  }

  if (server) await server.close();

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n\nDone in ${secs}s -> ${outAbs}`);
  if (audioCodec) console.log(`  audio: ${muxed} sound(s) muxed` + (skipped ? `, ${skipped} not muxable (out-of-window or no source URL)` : ""));
  else console.log(`  audio: not supported for ${format} container`);

  // #1: visual-regression. FR-B1 lifecycle: if the baseline is missing or
  // --update-baseline is set, (re)save this render as the baseline (PASS).
  // Otherwise diff against it -- nonzero exit on regression so CI can gate.
  if (args.baseline && !isSequence) {
    try {
      if (args.updateBaseline || !fs.existsSync(args.baseline)) {
        fs.mkdirSync(path.dirname(path.resolve(args.baseline)), { recursive: true });
        fs.copyFileSync(outAbs, args.baseline);
        console.log(`\nVRT baseline ${args.updateBaseline ? "updated" : "saved"} -> ${args.baseline}`);
      } else {
        const res = await diffVideos(args.baseline, outAbs, { threshold: args.threshold, masks: maskRects });
        reportDiff(res);
        if (!res.pass) process.exitCode = 1;
      }
    } catch (e) { console.log(`  (VRT skipped: ${e.message})`); }
  }
}

main().catch((err) => {
  console.error("\nRender failed:", err);
  process.exit(1);
});
