// video-decoder.js  [B1]
// Injected into the page (after clock-shim.js and mp4box). Replaces the native
// <video> playback path -- fragile/non-deterministic in headless -- with a
// deterministic one: mp4box.js demuxes the file into encoded chunks, WebCodecs
// decodes them, and each frame is painted onto a <canvas> synced to the virtual
// clock. This mirrors Replit's five-layer pipeline, minus the server-side
// fragmentation step (we load the whole small file at once).

(function () {
  window.__decoders = window.__decoders || [];
  window.__decodePending = 0;
  window.__decoderStats = { videos: 0, frames: 0, errors: [] };

  const MP4Box = window.MP4Box;
  const DataStream = window.DataStream || (MP4Box && MP4Box.DataStream);
  if (!MP4Box || typeof VideoDecoder === "undefined" || !DataStream) {
    window.__decoderStats.errors.push("unsupported: MP4Box/WebCodecs/DataStream missing");
    return; // harness falls back to native <video> seeking
  }

  // #3: media-fragment parse + shown-time math come from the shared helpers
  // (parseMediaFragment / videoShownSourceTime) prepended by render.js loadShim,
  // since this file is injected as a string and can't require the module.

  // Extract the codec-private data (avcC/hvcC) WebCodecs needs to configure.
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

  async function setup(video) {
    if (video.__ownedByDecoder || video.__decoderPending) return;
    const rawSrc = video.currentSrc || video.src;
    if (!rawSrc) return;
    const frag = parseMediaFragment(rawSrc); // #3: trim-in via #t=start,end
    const srcUrl = frag.clean;
    video.__decoderPending = true;
    window.__decodePending++;

    const fail = (msg) => {
      window.__decoderStats.errors.push(msg);
      video.__decoderPending = false;
      window.__decodePending--;
    };

    let buf;
    try { buf = await (await fetch(srcUrl)).arrayBuffer(); }
    catch (e) { return fail("fetch: " + e); }

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
    if (!configured) return fail("not configured");
    try { await decoder.flush(); } catch (e) { window.__decoderStats.errors.push("flush: " + e); }
    frames.sort((a, b) => a.t - b.t);
    if (!frames.length) return fail("no frames decoded");

    // #3: trim window from the media fragment (end defaults to full duration).
    video.__trimStart = frag.start;
    video.__trimEnd = frag.end || durationSec;

    // Swap the <video> for a <canvas> in the same spot.
    const rect = video.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || rect.width || 320;
    canvas.height = video.videoHeight || rect.height || 240;
    canvas.style.width = (rect.width || canvas.width) + "px";
    canvas.style.height = (rect.height || canvas.height) + "px";
    canvas.style.objectFit = getComputedStyle(video).objectFit || "cover";
    video.style.display = "none";
    video.parentNode.insertBefore(canvas, video);
    const ctx = canvas.getContext("2d");
    video.__ownedByDecoder = true;
    video.__decoderPending = false;
    window.__decodePending--;
    window.__decoderStats.videos++;

    let last = -1;
    const dec = {
      seek(elapsedMs) {
        // E: honor the video's start offset and playbackRate.
        // #3: honor the trim window [trimStart, trimEnd). Shared helper computes
        // the shown source time (looped/clamped within the window).
        const startMs = (typeof video.__videoStartMs === "number") ? video.__videoStartMs : 0;
        const rate = (typeof video.playbackRate === "number" && video.playbackRate > 0) ? video.playbackRate : 1;
        const t = videoShownSourceTime(elapsedMs, startMs, rate,
          video.__trimStart || 0, video.__trimEnd || durationSec, video.loop);
        let idx = 0;
        for (let i = 0; i < frames.length; i++) { if (frames[i].t <= t + 1e-4) idx = i; else break; }
        if (idx !== last) { try { ctx.drawImage(frames[idx].frame, 0, 0, canvas.width, canvas.height); last = idx; } catch (e) {} }
      },
      ready() { return true; },
    };
    window.__decoders.push(dec);
    dec.seek(window.__vclock ? window.__vclock.elapsed() : 0);
  }

  const scan = () => document.querySelectorAll("video").forEach(setup);
  if (document.readyState !== "loading") scan();
  document.addEventListener("DOMContentLoaded", scan);
  window.addEventListener("load", scan);
  try { new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
})();
