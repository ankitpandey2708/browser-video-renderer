// media-decoder.js  [B1]
// Injected into the page (after clock-shim.js, and after mp4box when the page has
// a <video>). Media that would otherwise animate on the browser's own clock is
// fragile/non-deterministic in headless -- this replaces it with a deterministic
// path painted onto a <canvas> synced to the virtual clock, registered into
// window.__decoders so __vclock.tick() seeks it each frame:
//   - <video>:        mp4box demux -> WebCodecs VideoDecoder -> canvas, honoring
//                     the #t= trim window, start offset, playbackRate, loop, and
//                     an optional luma mask (maskSrc/data-mask) for transparency.
//   - animated <img>: gif/apng/webp decoded via the native ImageDecoder -> canvas.
// (Mirrors Replit's pipeline, minus the server-side fragmentation -- small files
// are loaded whole.) The shared media-fragment helpers (parseMediaFragment /
// videoShownSourceTime) are prepended by render.js loadShim.

(function () {
  window.__decoders = window.__decoders || [];
  window.__decodePending = window.__decodePending || 0;
  window.__decoderStats = window.__decoderStats || { videos: 0, frames: 0, errors: [] };
  if (window.__decoderStats.images == null) window.__decoderStats.images = 0;

  const MP4Box = window.MP4Box;
  const DataStream = window.DataStream || (MP4Box && MP4Box.DataStream);
  const canVideo = !!(MP4Box && typeof VideoDecoder !== "undefined" && DataStream);
  const canImage = typeof ImageDecoder !== "undefined";

  // Frame index whose timestamp is at-or-before source time t (seconds).
  function frameIndexAt(frames, t) {
    let idx = 0;
    for (let i = 0; i < frames.length; i++) { if (frames[i].t <= t + 1e-4) idx = i; else break; }
    return idx;
  }

  // --- shared setup boilerplate -----------------------------------------------

  // Guard against double-processing and account the in-flight decode. Returns
  // null if the element is already owned or pending; otherwise a { done, fail }
  // pair that releases the pending count exactly once (fail also logs, prefixed
  // with `label`).
  function beginSetup(el, label) {
    if (el.__ownedByDecoder || el.__decoderPending) return null;
    el.__decoderPending = true;
    window.__decodePending++;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.__decoderPending = false;
      window.__decodePending--;
    };
    const fail = (msg) => { if (msg) window.__decoderStats.errors.push(label + ": " + msg); done(); };
    return { done, fail };
  }

  // Replace el with a same-spot <canvas> and hide the original. Caller passes the
  // element's rect and the backing-store w/h; opts tunes the CSS to match the
  // media kind: objectFit (fallback when unset), fallbackSize (size the canvas to
  // its backing store when the rect has no box), imageRendering (copy it), and
  // ctxOptions (getContext options, e.g. willReadFrequently). Returns { canvas, ctx }.
  function swapToCanvas(el, rect, w, h, opts) {
    opts = opts || {};
    const cs = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    if (rect.width) canvas.style.width = rect.width + "px";
    else if (opts.fallbackSize) canvas.style.width = canvas.width + "px";
    if (rect.height) canvas.style.height = rect.height + "px";
    else if (opts.fallbackSize) canvas.style.height = canvas.height + "px";
    canvas.style.objectFit = cs.objectFit || opts.objectFit || "fill";
    if (opts.imageRendering) canvas.style.imageRendering = cs.imageRendering || "auto";
    el.style.display = "none";
    el.parentNode.insertBefore(canvas, el);
    return { canvas, ctx: canvas.getContext("2d", opts.ctxOptions) };
  }

  // Register a decoder into the virtual-clock loop and paint its first frame.
  function registerDecoder(dec) {
    window.__decoders.push(dec);
    dec.seek(window.__vclock ? window.__vclock.elapsed() : 0);
  }

  // --- <video>: mp4box + WebCodecs --------------------------------------------

  // Extract the codec-private data (avcC/hvcC/vpcC/av1C) WebCodecs needs.
  function codecDescription(mp4file, trackId) {
    const trak = mp4file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        return new Uint8Array(ds.buffer, 8); // strip the 8-byte box header
      }
    }
    return undefined;
  }

  // Demux + decode one video file to sorted frames. Returns { frames, durationSec }
  // or null on failure. Shared by the main video and its optional luma mask.
  async function decodeFile(srcUrl) {
    let buf;
    try { buf = await (await fetch(srcUrl)).arrayBuffer(); }
    catch (e) { window.__decoderStats.errors.push("fetch: " + e); return null; }

    const mp4 = MP4Box.createFile();
    const frames = []; // { t: seconds, frame: VideoFrame }
    let durationSec = 0, decoder = null, configured = false;

    const ready = new Promise((resolve) => {
      mp4.onError = (e) => { window.__decoderStats.errors.push("mp4box: " + e); resolve(); };
      mp4.onReady = (info) => {
        const track = info.videoTracks && info.videoTracks[0];
        if (!track) { window.__decoderStats.errors.push("no video track"); return resolve(); }
        durationSec = info.duration / info.timescale;
        decoder = new VideoDecoder({
          output: (frame) => { frames.push({ t: frame.timestamp / 1e6, frame }); window.__decoderStats.frames++; },
          error: (e) => window.__decoderStats.errors.push("decoder: " + e),
        });
        decoder.configure({
          codec: track.codec,
          codedWidth: track.track_width,
          codedHeight: track.track_height,
          description: codecDescription(mp4, track.id),
        });
        configured = true;
        mp4.setExtractionOptions(track.id, null, { nbSamples: 1e6 });
        mp4.start();
        resolve();
      };
      mp4.onSamples = (id, user, samples) => {
        for (const s of samples) {
          decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: (s.cts / s.timescale) * 1e6,
            duration: (s.duration / s.timescale) * 1e6,
            data: s.data,
          }));
        }
      };
    });

    const ab = buf.slice(0);
    ab.fileStart = 0;
    mp4.appendBuffer(ab);
    mp4.flush();
    await ready;
    if (!configured) { window.__decoderStats.errors.push("not configured"); return null; }
    try { await decoder.flush(); } catch (e) { window.__decoderStats.errors.push("flush: " + e); }
    frames.sort((a, b) => a.t - b.t);
    if (!frames.length) { window.__decoderStats.errors.push("no frames decoded"); return null; }
    return { frames, durationSec };
  }

  async function setupVideo(video) {
    const rawSrc = video.currentSrc || video.src;
    if (!rawSrc) return;
    const setup = beginSetup(video, "video");
    if (!setup) return;
    const frag = parseMediaFragment(rawSrc); // #3: trim-in via #t=start,end

    const color = await decodeFile(frag.clean);
    if (!color) return setup.fail(null);
    const { frames, durationSec } = color;

    // Transparent video (WVC-style): a companion luma mask -- white=opaque,
    // black=transparent. maskSrc / data-mask. Its luminance becomes the canvas
    // alpha, so the page shows through where the mask is dark.
    const maskUrl = video.getAttribute("maskSrc") || video.getAttribute("data-mask");
    let maskFrames = null, maskCanvas = null, maskCtx = null;
    if (maskUrl) {
      const m = await decodeFile(maskUrl);
      if (m && m.frames.length) maskFrames = m.frames;
    }

    // #3: trim window from the media fragment (end defaults to full duration).
    video.__trimStart = frag.start;
    video.__trimEnd = frag.end || durationSec;

    // Swap the <video> for a <canvas> in the same spot.
    const rect = video.getBoundingClientRect();
    const { canvas, ctx } = swapToCanvas(video, rect,
      video.videoWidth || rect.width || 320,
      video.videoHeight || rect.height || 240,
      { objectFit: "cover", fallbackSize: true, ctxOptions: maskFrames ? { willReadFrequently: true } : undefined });
    if (maskFrames) {
      maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width; maskCanvas.height = canvas.height;
      maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    }
    video.__ownedByDecoder = true;
    setup.done();
    window.__decoderStats.videos++;

    let last = null;
    const dec = {
      seek(elapsedMs) {
        // E: honor the video's start offset and playbackRate.
        // #3: honor the trim window [trimStart, trimEnd). Shared helper computes
        // the shown source time (looped/clamped within the window).
        const startMs = (typeof video.__videoStartMs === "number") ? video.__videoStartMs : 0;
        const rate = (typeof video.playbackRate === "number" && video.playbackRate > 0) ? video.playbackRate : 1;
        const t = videoShownSourceTime(elapsedMs, startMs, rate,
          video.__trimStart || 0, video.__trimEnd || durationSec, video.loop);
        const idx = frameIndexAt(frames, t);
        const midx = maskFrames ? frameIndexAt(maskFrames, t) : -1;
        const key = idx + ":" + midx;
        if (key === last) return;
        try {
          if (maskFrames) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(frames[idx].frame, 0, 0, canvas.width, canvas.height);
            maskCtx.drawImage(maskFrames[midx].frame, 0, 0, maskCanvas.width, maskCanvas.height);
            const md = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
            const cd = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const cdata = cd.data;
            // Rec.601 luma of the mask -> alpha of the color frame.
            for (let i = 0; i < cdata.length; i += 4)
              cdata[i + 3] = (md[i] * 0.299 + md[i + 1] * 0.587 + md[i + 2] * 0.114) | 0;
            ctx.putImageData(cd, 0, 0);
          } else {
            ctx.drawImage(frames[idx].frame, 0, 0, canvas.width, canvas.height);
          }
          last = key;
        } catch (e) {}
      },
      ready() { return true; },
    };
    registerDecoder(dec);
  }

  // --- animated <img>: native ImageDecoder ------------------------------------

  // Only bother with types that can be animated. png is included for APNG (the
  // frameCount check below leaves static images untouched).
  const ANIMATABLE = /\.(gif|apng|webp|png)(\?|#|$)/i;

  async function setupImage(img) {
    const src = img.currentSrc || img.src;
    if (!src || !ANIMATABLE.test(src)) return;
    // Only take over images that are actually laid out. Players like GitHub's
    // <animated-image> ship a hidden (display:none) duplicate <img> beside the
    // visible one; a zero-box element gives swapToCanvas no size to copy, so the
    // canvas would paint at the media's intrinsic resolution (a giant emoji).
    const box = img.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const setup = beginSetup(img, "image");
    if (!setup) return;

    let data, type;
    try {
      const resp = await fetch(src);
      type = resp.headers.get("content-type") || "";
      data = await resp.arrayBuffer();
    } catch (e) { return setup.fail("fetch: " + e); }

    let decoder;
    try {
      decoder = new ImageDecoder({ data, type: type || "image/gif" });
      await decoder.tracks.ready;
    } catch (e) { return setup.fail("decode-init: " + e); }

    const track = decoder.tracks.selectedTrack || decoder.tracks[0];
    const frameCount = track ? track.frameCount : 1;
    if (!frameCount || frameCount <= 1) return setup.done(); // static image -- leave native <img>

    // Decode every frame + its display duration, building a cumulative timeline.
    const frames = []; // { image: VideoFrame, endMs: cumulative ms }
    let totalMs = 0;
    for (let i = 0; i < frameCount; i++) {
      let image;
      try { ({ image } = await decoder.decode({ frameIndex: i })); }
      catch (e) { window.__decoderStats.errors.push("image-frame " + i + ": " + e); continue; }
      // VideoFrame.duration is microseconds; GIF/WebP frame delays land here.
      const durMs = image.duration ? image.duration / 1000 : 100;
      totalMs += durMs;
      frames.push({ image, endMs: totalMs });
      window.__decoderStats.frames++;
    }
    if (!frames.length) return setup.fail("no frames decoded");

    // Swap the <img> for a <canvas> in the same spot, matching its layout box.
    const rect = img.getBoundingClientRect();
    const first = frames[0].image;
    const { canvas, ctx } = swapToCanvas(img, rect,
      first.displayWidth || img.naturalWidth || rect.width || 1,
      first.displayHeight || img.naturalHeight || rect.height || 1,
      { objectFit: "fill", imageRendering: true });
    img.__ownedByDecoder = true;
    setup.done();
    window.__decoderStats.images++;

    let last = -1;
    const pick = (ms) => { // frame index at looped virtual time
      const tt = totalMs > 0 ? ((ms % totalMs) + totalMs) % totalMs : 0;
      for (let i = 0; i < frames.length; i++) if (tt < frames[i].endMs) return i;
      return frames.length - 1;
    };
    const dec = {
      seek(elapsedMs) {
        const idx = pick(elapsedMs || 0);
        if (idx !== last) { try { ctx.drawImage(frames[idx].image, 0, 0, canvas.width, canvas.height); last = idx; } catch (e) {} }
      },
      ready() { return true; },
    };
    registerDecoder(dec);
  }

  // --- scan for both, now and on later DOM changes ----------------------------
  const scan = () => {
    if (canVideo) document.querySelectorAll("video").forEach(setupVideo);
    if (canImage) document.querySelectorAll("img").forEach(setupImage);
  };
  if (document.readyState !== "loading") scan();
  document.addEventListener("DOMContentLoaded", scan);
  window.addEventListener("load", scan);
  try { new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
})();
