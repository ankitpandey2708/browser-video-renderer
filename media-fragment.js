// media-fragment.js  [#3]
// Shared video-timing helpers used both in Node and inside the injected page
// shims. Two ways of loading, which is why everything here is plain functions
// with a guarded module.exports: require()d in Node (render.js), and prepended
// as a string to the shims (clock-shim.js / video-decoder.js can't require --
// see render.js loadShim). Keeping the single copy here removes what used to be
// three hand-synced duplicates.
//
// parseMediaFragment: parse a W3C Media Fragment temporal dimension from a URL:
//   #t=start[,end] (seconds). Lets a page declare a video trim-in the standard
//   way -- <video src="clip.mp4#t=5,10"> -- with no bespoke attribute. Returns
//   { clean, start, end }: clean is the URL without the fragment, start >= 0,
//   end is null or > start. Defensive: malformed values fall back to defaults.
function parseMediaFragment(url) {
  const out = { clean: url, start: 0, end: null };
  if (!url) return out;
  const hash = url.indexOf("#");
  if (hash < 0) return out;
  out.clean = url.slice(0, hash);
  const m = url.slice(hash + 1).match(/(?:^|&)t=([0-9.]*)(?:,([0-9.]+))?/);
  if (!m) return out;
  if (m[1]) out.start = Math.max(0, Number(m[1]) || 0);
  if (m[2] != null) { const e = Number(m[2]); if (e > out.start) out.end = e; }
  return out;
}

// videoShownSourceTime: the source time (seconds) a <video> should display at a
// given virtual clock, honoring its start offset (E), playbackRate (E), and the
// [trimStart, trimEnd) media-fragment window (#3). Looped videos wrap within the
// window; non-looped clamp to just inside its end. dur is the fallback trimEnd.
function videoShownSourceTime(elapsedMs, startMs, rate, trimStart, trimEnd, loop) {
  const tStart = trimStart || 0;
  const tEnd = trimEnd || 0;
  const winLen = Math.max(0.001, tEnd - tStart);
  let raw = ((elapsedMs - startMs) / 1000) * (rate > 0 ? rate : 1);
  if (raw < 0) raw = 0;
  return loop ? tStart + (raw % winLen) : Math.min(tStart + raw, tEnd - 0.001);
}
if (typeof module !== "undefined" && module.exports)
  module.exports = { parseMediaFragment, videoShownSourceTime };
