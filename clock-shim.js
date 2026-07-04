// clock-shim.js
// The trick from Replit's "browsers don't want to be cameras".
// Runs INSIDE the page, BEFORE the page's own code, and replaces every
// time-related browser API with a fake clock we control from the outside.
//
// Includes:
//   - virtual clock (Date/perf/timers/rAF)         [core]
//   - CSS-animation seeking                          [core]
//   - <video> seeking to virtual time               [A2 legacy path]
//   - OffscreenCanvas lockdown for determinism       [A1]
//   - full audio-graph wiretap                       [B2]

(function () {
  // Deferred activation (stealth): with window.__vclockDeferred set, the shim
  // stays fully dormant -- the page is left pristine so Cloudflare's JS challenge
  // runs on the REAL clock and can clear -- until the renderer calls
  // __vclock.arm() after clearance. Otherwise it installs immediately, as before.
  // (A frozen clock can't complete the challenge, and this site re-challenges on
  // every navigation, so we can't reload a frozen page through it.)
  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
  // Anchor the frozen clock at the REAL current time (captured now, before Date
  // is overridden) so time-sensitive pages behave -- a stale hardcoded epoch trips
  // bot/security checks (e.g. Cloudflare "Incorrect device time"). Override with
  // window.__epoch for a fully reproducible Date across runs.
  const EPOCH = (typeof window.__epoch === "number") ? window.__epoch : Date.now();
  let elapsed = 0; // virtual ms since page load
  let idCounter = 1;

  const timers = new Map(); // id -> { fireAt, cb, args, interval }
  const rafs = new Map(); // id -> cb
  const audioEvents = []; // { src, startMs, volume, loop, kind, [playbackRate], [stopMs, frequency, oscType] }

  // --- #6: seeded randomness -----------------------------------------------
  // Only time is frozen by default; Math.random / crypto still vary, so renders
  // aren't byte-identical. Seed them from window.__seed (injected by the
  // renderer before this shim). __seed === -1 opts out (keep true randomness).
  (function seedRandomness() {
    var seed = (typeof window.__seed === "number") ? window.__seed : 1;
    if (seed === -1) return;
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);
    Math.random = function () { return rng(); };
    try {
      if (window.crypto) {
        window.crypto.getRandomValues = function (arr) {
          for (var i = 0; i < arr.length; i++) arr[i] = (rng() * 4294967296) >>> 0;
          return arr;
        };
        window.crypto.randomUUID = function () {
          var h = "";
          for (var i = 0; i < 32; i++) h += ((rng() * 16) | 0).toString(16);
          return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) +
            "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
        };
      }
    } catch (e) {}
  })();

  // --- A1: determinism safety ----------------------------------------------
  // OffscreenCanvas lets a page render on a worker thread that bypasses our
  // main-thread capture. Force pages onto the main thread by removing it.
  try {
    Object.defineProperty(window, "OffscreenCanvas", { value: undefined, writable: false, configurable: false });
  } catch (e) {}
  try {
    Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
      value: undefined, writable: false, configurable: false,
    });
  } catch (e) {}

  // --- Date -----------------------------------------------------------------
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(EPOCH + elapsed);
      else super(...args);
    }
    static now() { return EPOCH + elapsed; }
  }
  window.Date = FakeDate;

  // --- performance.now ------------------------------------------------------
  try { window.performance.now = () => elapsed; }
  catch (e) { Object.defineProperty(window.performance, "now", { value: () => elapsed }); }

  // --- setTimeout / setInterval --------------------------------------------
  window.setTimeout = function (cb, delay, ...args) {
    const id = idCounter++;
    timers.set(id, { fireAt: elapsed + Math.max(0, delay || 0), cb, args, interval: null });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = function (cb, delay, ...args) {
    const id = idCounter++;
    const step = Math.max(1, delay || 0);
    timers.set(id, { fireAt: elapsed + step, cb, args, interval: step });
    return id;
  };
  window.clearInterval = (id) => timers.delete(id);

  // --- requestAnimationFrame ------------------------------------------------
  window.requestAnimationFrame = function (cb) { const id = idCounter++; rafs.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => rafs.delete(id);

  // --- B2: audio wiretap (record intent, mux later) ------------------------
  const bufferUrl = new WeakMap(); // ArrayBuffer -> source URL
  const audioBufferUrl = new WeakMap(); // AudioBuffer -> source URL
  const gainEdges = new WeakMap(); // AudioNode -> [outgoing destinations]

  // 1. fetch(): tag ArrayBuffers produced by Response.arrayBuffer() with URL
  if (window.Response && Response.prototype.arrayBuffer) {
    const origAB = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = function () {
      const url = this.url;
      return origAB.call(this).then((buf) => { if (url) bufferUrl.set(buf, url); return buf; });
    };
  }

  // 2. XMLHttpRequest: same, for arraybuffer responses
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) { this.__url = url; return origOpen.apply(this, arguments); };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try { if (this.responseType === "arraybuffer" && this.response) bufferUrl.set(this.response, this.__url); } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // 3. decodeAudioData: map resulting AudioBuffer -> URL (promise + callback forms)
  function patchDecode(Ctx) {
    if (!Ctx || !Ctx.prototype || !Ctx.prototype.decodeAudioData) return;
    const orig = Ctx.prototype.decodeAudioData;
    Ctx.prototype.decodeAudioData = function (data, success, error) {
      const url = bufferUrl.get(data);
      return orig.call(this, data).then(
        (audioBuffer) => { if (url) audioBufferUrl.set(audioBuffer, url); if (typeof success === "function") success(audioBuffer); return audioBuffer; },
        (err) => { if (typeof error === "function") error(err); throw err; }
      );
    };
  }
  patchDecode(window.AudioContext);
  patchDecode(window.OfflineAudioContext);
  patchDecode(window.webkitAudioContext);

  // 4. AudioNode.connect: build the graph so we can walk gain to destination
  if (window.AudioNode) {
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try { const e = gainEdges.get(this) || []; e.push(dest); gainEdges.set(this, e); } catch (err) {}
      return origConnect.apply(this, arguments);
    };
  }
  function effectiveGain(node, seen) {
    seen = seen || new Set();
    if (!node || seen.has(node)) return 1;
    seen.add(node);
    let g = 1;
    if (typeof GainNode !== "undefined" && node instanceof GainNode) {
      try { g *= node.gain.value; } catch (e) {}
    }
    const outs = gainEdges.get(node);
    if (!outs || !outs.length) return g; // reached destination / leaf
    let best = 0;
    for (const d of outs) best = Math.max(best, effectiveGain(d, seen));
    return g * best;
  }

  // 5. AudioBufferSourceNode.start: record playback (URL + effective gain).
  // #2/#4: skipped in audio-capture mode -- there we run the REAL graph on an
  // OfflineAudioContext, so start() must NOT be neutered.
  if (!window.__audioCaptureMode && window.AudioBufferSourceNode) {
    AudioBufferSourceNode.prototype.start = function () {
      try {
        const url = this.buffer ? audioBufferUrl.get(this.buffer) : null;
        audioEvents.push({ src: url || null, startMs: elapsed, volume: effectiveGain(this), loop: !!this.loop, kind: "webaudio" });
      } catch (e) {}
      // no real start -- no audio device in headless
    };
  }

  // D: OscillatorNode.start/stop -- generated tones have no file to fetch, so
  // record their parameters (frequency/type/effective gain) and start/stop
  // times; the renderer synthesizes the tone at mux time. No real sound here.
  if (!window.__audioCaptureMode && window.OscillatorNode) {
    const origOscStart = OscillatorNode.prototype.start;
    const origOscStop = OscillatorNode.prototype.stop;
    OscillatorNode.prototype.start = function () {
      try {
        const ev = { kind: "oscillator", startMs: elapsed, stopMs: null,
          frequency: this.frequency ? this.frequency.value : 0,
          oscType: this.type, volume: effectiveGain(this) };
        this.__oscEvent = ev;
        audioEvents.push(ev);
      } catch (e) {}
      // no real start -- no audio device in headless
    };
    OscillatorNode.prototype.stop = function () {
      try { if (this.__oscEvent) this.__oscEvent.stopMs = elapsed; } catch (e) {}
      // no real stop
    };
    // preserve originals (unused by shim, but avoids dropping references)
    OscillatorNode.prototype.__origStart = origOscStart;
    OscillatorNode.prototype.__origStop = origOscStop;
  }

  // 6. HTMLAudioElement.play: catches new Audio(url).play() and <audio>
  HTMLAudioElement.prototype.play = function () {
    try {
      audioEvents.push({ src: this.currentSrc || this.src, startMs: elapsed, volume: this.volume, loop: !!this.loop, kind: "element" });
    } catch (e) {}
    return Promise.resolve();
  };

  // E: HTMLVideoElement.play: a video that isn't autoplaying starts when
  // .play() is called -- record that moment as the video's start offset. This
  // is separate from the audio wiretap above (HTMLAudioElement is a distinct
  // prototype), so audio elements are still recorded as audio, not video.
  if (window.HTMLVideoElement) {
    const origVideoPlay = HTMLVideoElement.prototype.play;
    HTMLVideoElement.prototype.play = function () {
      try { this.__videoStartMs = elapsed; } catch (e) {}
      return Promise.resolve();
    };
    // keep a reference in case anything needs the original (unused by shim)
    HTMLVideoElement.prototype.__origPlay = origVideoPlay;
  }

  // #3: media-fragment parse (#t=start[,end]) via the shared helper prepended by
  // render.js loadShim; cached per <video>.
  function videoTrim(v) {
    if (!v.__frag) v.__frag = parseMediaFragment(v.currentSrc || v.src);
    return v.__frag;
  }

  // E: the virtual time shown by a <video>, honoring its start offset and
  // playbackRate. #3: also honor the trim window [trimStart, trimEnd). shown =
  // trimStart + ((elapsed - videoStartMs)/1000)*rate, looped/clamped in-window.
  function videoShownTime(v, dur) {
    // autoplay -> starts at 0; a later .play() records __videoStartMs.
    const startMs = (typeof v.__videoStartMs === "number") ? v.__videoStartMs : 0;
    const rate = (typeof v.playbackRate === "number" && v.playbackRate > 0) ? v.playbackRate : 1;
    const frag = videoTrim(v);
    return videoShownSourceTime(elapsed, startMs, rate, frag.start, frag.end || dur, v.loop);
  }

  // --- #2/#4: audio core ----------------------------------------------------
  // Today the Web Audio graph never runs, so an AnalyserNode sees silence and
  // AudioWorklet DSP is lost. Two passes fix this:
  //   Pass 1 (window.__audioCaptureMode): the page builds its real graph on an
  //     OfflineAudioContext; the renderer steps the clock, then startRendering()
  //     yields exact PCM (runs AudioWorklets -> #4).
  //   Pass 2 (window.__audioPCM present): AnalyserNode reads that PCM at the
  //     virtual-clock offset via FFT, so visualizers react -> #2.

  // Iterative radix-2 FFT -> linear magnitude spectrum (bins 0..N/2-1). N must be
  // a power of two (AnalyserNode.fftSize always is).
  function fftMag(samples) {
    var N = samples.length, re = new Float32Array(N), im = new Float32Array(N), i, j;
    for (i = 0; i < N; i++) re[i] = samples[i];
    for (i = 1, j = 0; i < N; i++) { // bit-reversal permutation
      var bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; }
    }
    for (var len = 2; len <= N; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < N; i += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var a = i + k, b = i + k + len / 2;
          var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    var half = N >> 1, mag = new Float32Array(half);
    for (i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mag;
  }

  // Pass 1: back the page's AudioContext with a single OfflineAudioContext.
  (function installAudioCapture() {
    if (!window.__audioCaptureMode) return;
    var RealOffline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var RealCtx = window.AudioContext || window.webkitAudioContext;
    if (!RealOffline || !RealCtx) return;
    var durationSec = (typeof window.__audioDurationSec === "number") ? window.__audioDurationSec : 5;
    var SR = 48000, offline = null;

    function patchScheduling() { // map start()/stop() "now" to the virtual clock
      var P = window.AudioScheduledSourceNode && AudioScheduledSourceNode.prototype;
      if (!P || P.__vpatched) return; P.__vpatched = true;
      var os = P.start, ot = P.stop;
      P.start = function (when) {
        var now = window.__vclock ? window.__vclock.elapsed() / 1000 : 0;
        var w = (when == null || when <= (this.context ? this.context.currentTime : 0)) ? now : when;
        try { return os.call(this, w); } catch (e) { try { return os.call(this); } catch (e2) {} }
      };
      P.stop = function (when) {
        var now = window.__vclock ? window.__vclock.elapsed() / 1000 : 0;
        var w = (when == null) ? now : when;
        try { return ot.call(this, w); } catch (e) {}
      };
    }
    function getOffline() {
      if (!offline) {
        offline = new RealOffline(2, Math.max(1, Math.ceil(durationSec * SR)), SR);
        window.__audioUsed = true;
        patchScheduling();
      }
      return offline;
    }
    function FakeAudioContext() { return getOffline(); } // ctor returns the shared offline ctx
    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;

    window.__renderAudio = function () {
      if (!offline) return Promise.resolve(null);
      return offline.startRendering().then(function (buf) {
        var chans = [];
        for (var c = 0; c < buf.numberOfChannels; c++) chans.push(Array.from(buf.getChannelData(c)));
        return { channels: chans, sampleRate: buf.sampleRate, length: buf.length };
      }).catch(function () { return null; });
    };
  })();

  // Pass 2: AnalyserNode reads the pre-rendered PCM at the virtual clock. We keep
  // the real node (so source.connect(analyser) works) and only override its read
  // methods -- robust against arbitrary graph shapes.
  (function installAudioReactive() {
    if (!window.__audioPCM) return;
    var pcm = window.__audioPCM;
    var samples;
    if (pcm.b64) { // mono Int16 base64 from the renderer
      var bin = atob(pcm.b64), n = bin.length >> 1;
      samples = new Float32Array(n);
      for (var s2 = 0; s2 < n; s2++) {
        var v = (bin.charCodeAt(s2 * 2 + 1) << 8) | bin.charCodeAt(s2 * 2);
        if (v >= 32768) v -= 65536;
        samples[s2] = v / 32768;
      }
    } else {
      samples = (pcm.data instanceof Float32Array) ? pcm.data : Float32Array.from(pcm.data || []);
    }
    var sr = pcm.sampleRate || 48000;
    var proto = window.BaseAudioContext ? window.BaseAudioContext.prototype
      : (window.AudioContext ? window.AudioContext.prototype : null);
    if (!proto || !proto.createAnalyser) return;
    var orig = proto.createAnalyser;
    proto.createAnalyser = function () { var n = orig.call(this); patch(n); return n; };

    function win(N) {
      var center = Math.floor((window.__vclock ? window.__vclock.elapsed() / 1000 : 0) * sr);
      var start = center - (N >> 1), w = new Float32Array(N);
      for (var i = 0; i < N; i++) { var idx = start + i; w[i] = (idx >= 0 && idx < samples.length) ? samples[idx] : 0; }
      return w;
    }
    function patch(node) {
      node.getFloatTimeDomainData = function (a) { var w = win(this.fftSize); for (var i = 0; i < a.length && i < w.length; i++) a[i] = w[i]; };
      node.getByteTimeDomainData = function (a) { var w = win(this.fftSize); for (var i = 0; i < a.length && i < w.length; i++) { var v = w[i] * 128 + 128; a[i] = v < 0 ? 0 : v > 255 ? 255 : v; } };
      node.getFloatFrequencyData = function (a) { var fs = this.fftSize, m = fftMag(win(fs)); for (var i = 0; i < a.length && i < m.length; i++) a[i] = 20 * Math.log10((m[i] / fs) || 1e-10); };
      node.getByteFrequencyData = function (a) {
        var fs = this.fftSize, m = fftMag(win(fs)), min = this.minDecibels, max = this.maxDecibels, s = this.smoothingTimeConstant || 0;
        if (!node.__sm || node.__sm.length !== m.length) node.__sm = new Float32Array(m.length);
        for (var i = 0; i < a.length && i < m.length; i++) {
          var mv = m[i] / fs;
          node.__sm[i] = s * node.__sm[i] + (1 - s) * mv;
          var db = 20 * Math.log10(node.__sm[i] || 1e-10);
          var v = (db - min) / (max - min); v = v < 0 ? 0 : v > 1 ? 1 : v;
          a[i] = v * 255;
        }
      };
    }
  })();

  // --- The control surface the renderer drives ------------------------------
  window.__vclock = {
    tick(dt) {
      elapsed += dt;

      // 1. Fire due timeouts / intervals (earliest first).
      const due = [];
      for (const [id, t] of timers) if (t.fireAt <= elapsed) due.push([id, t]);
      due.sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, t] of due) {
        if (!timers.has(id)) continue;
        try { t.cb(...t.args); } catch (err) { console.error("[vclock] timer:", err); }
        if (t.interval != null) t.fireAt = elapsed + t.interval;
        else timers.delete(id);
      }

      // 2. Seek CSS animations / transitions (Web Animations API).
      if (typeof document.getAnimations === "function") {
        for (const anim of document.getAnimations()) {
          try { anim.pause(); anim.currentTime = elapsed; } catch (e) {}
        }
      }

      // 2b. Seek SVG SMIL (<animate>/<animateTransform>/<set>) to virtual time.
      // Their timeline runs on the SVG document clock (real time), invisible to
      // getAnimations(); pause it and setCurrentTime so it tracks our clock.
      for (const svg of document.querySelectorAll("svg")) {
        try { svg.pauseAnimations(); svg.setCurrentTime(elapsed / 1000); } catch (e) {}
      }

      // 3. Seek every <video> to virtual time (unless a decoder owns it -- B1).
      for (const v of document.querySelectorAll("video")) {
        // Log the video's own audio track once (its file URL is fetchable), so
        // the renderer can mux it. Skipped when muted.
        if (!v.__audioLogged) {
          v.__audioLogged = true;
          const frag = videoTrim(v); // #3: strip #t= and carry the trim to the mux
          const vsrc = frag.clean;
          // E: video's own start offset (autoplay=0, later .play()=that elapsed)
          // and playbackRate ride along so the mux re-bases/paces it correctly.
          const videoStartMs = (typeof v.__videoStartMs === "number") ? v.__videoStartMs : 0;
          const rate = (typeof v.playbackRate === "number" && v.playbackRate > 0) ? v.playbackRate : 1;
          if (vsrc && !v.muted) audioEvents.push({ src: vsrc, startMs: videoStartMs, volume: v.volume, loop: !!v.loop, playbackRate: rate, kind: "video", trimStart: frag.start, trimEnd: frag.end });
        }
        if (v.__ownedByDecoder) continue;
        try {
          if (!v.paused) v.pause();
          const dur = v.duration;
          if (isFinite(dur) && dur > 0) {
            const t = videoShownTime(v, dur);
            if (Math.abs(v.currentTime - t) > 1e-3) v.currentTime = t;
          }
        } catch (e) {}
      }
      if (window.__decoders) for (const d of window.__decoders) { try { d.seek(elapsed); } catch (e) {} }

      // 4. Fire rAF callbacks (snapshot: next-frame scheduling runs next tick).
      const frame = Array.from(rafs.entries());
      rafs.clear();
      for (const [id, cb] of frame) {
        try { cb(elapsed); } catch (err) { console.error("[vclock] raf:", err); }
      }
    },
    videosReady() {
      if (window.__decodePending) return false; // B1: decoders still setting up
      for (const v of document.querySelectorAll("video")) {
        if (v.__ownedByDecoder) continue;
        if (v.seeking) return false;
        if (isFinite(v.duration) && v.duration > 0 && v.readyState < 2) return false;
      }
      if (window.__decoders) for (const d of window.__decoders) { if (!d.ready()) return false; }
      return true;
    },
    elapsed() { return elapsed; },
    audioEvents() { return audioEvents; },
    // C: estimate when page content stops changing (ms). Max of pending
    // timer fire times, finite CSS animation/transition ends, and each
    // <video>'s (duration*1000 + its start offset). Infinite animations are
    // skipped. Fully defensive: returns 0 if nothing / on error.
    contentEndMs() {
      let end = 0;
      // (a) latest pending setTimeout/setInterval fireAt.
      try {
        for (const [, t] of timers) if (t.fireAt > end) end = t.fireAt;
      } catch (e) {}
      // (b) max CSS animation/transition end from getAnimations().
      try {
        if (typeof document.getAnimations === "function") {
          for (const anim of document.getAnimations()) {
            try {
              const eff = anim.effect;
              const timing = eff && typeof eff.getComputedTiming === "function" ? eff.getComputedTiming() : null;
              if (!timing) continue;
              const iters = timing.iterations;
              if (!isFinite(iters)) continue; // skip infinite
              const delay = timing.delay || 0;
              const dur = timing.duration || 0; // ms
              const animEnd = delay + dur * iters;
              if (isFinite(animEnd) && animEnd > end) end = animEnd;
            } catch (e) {}
          }
        }
      } catch (e) {}
      // (c) max <video> duration*1000 + its start offset.
      try {
        for (const v of document.querySelectorAll("video")) {
          try {
            const dur = v.duration;
            if (isFinite(dur) && dur > 0) {
              const startMs = (typeof v.__videoStartMs === "number") ? v.__videoStartMs : 0;
              // #3: the content lasts the trimmed window, not the full source.
              const frag = videoTrim(v);
              const winLen = (frag.end || dur) - frag.start;
              const vEnd = winLen * 1000 + startMs;
              if (vEnd > end) end = vEnd;
            }
          } catch (e) {}
        }
      } catch (e) {}
      // (d) GSAP: tweens are rAF-driven and never appear in getAnimations(), so
      // ask the global timeline for its furthest finite child end. endTime() is
      // in seconds on the global timeline; infinite repeats -> Infinity, skipped.
      try {
        const g = window.gsap || (window.GreenSockGlobals && window.GreenSockGlobals.gsap);
        if (g && g.globalTimeline && typeof g.globalTimeline.getChildren === "function") {
          let gEnd = 0;
          // Direct children only: their endTime() is in global seconds (nested
          // descendants report parent-local time). GSAP encodes an infinite
          // repeat as a huge finite endTime, so skip repeat() === -1 explicitly.
          for (const k of g.globalTimeline.getChildren(false, true, true)) {
            try {
              if (typeof k.repeat === "function" && k.repeat() === -1) continue;
              const e = k.endTime();
              if (isFinite(e) && e > gEnd) gEnd = e;
            } catch (e) {}
          }
          if (gEnd * 1000 > end) end = gEnd * 1000;
        }
      } catch (e) {}
      return isFinite(end) && end > 0 ? end : 0;
    },
  };
  } // end install()

  if (window.__vclockDeferred) {
    // Dormant control surface: the page is untouched so the bot challenge can run
    // on the real clock. arm() installs the real frozen clock (anchored at that
    // moment, elapsed=0); tick() is a no-op until then.
    window.__vclock = {
      __deferred: true,
      arm() { install(); },
      tick() {}, elapsed() { return 0; },
      videosReady() { return true; }, audioEvents() { return []; },
      contentEndMs() { return 0; },
    };
  } else {
    install();
  }
})();
