/* RAAZE — cinematic scroll film
   Canvas image-sequence scrubber: scroll position drives frame index.
   Frames are kept as compressed blobs; only a sliding window around the
   current frame is decoded to ImageBitmaps (keeps RAM sane on mobile). */

const canvas = document.getElementById("film");
const ctx = canvas.getContext("2d");
const track = document.getElementById("track");
const loader = document.getElementById("loader");
const loadring = document.getElementById("loadring");
const loadpct = document.getElementById("loadpct");
const scrollCue = document.getElementById("scroll-cue");
const nav = document.getElementById("nav");
const captions = [...document.querySelectorAll(".caption")];

const RING_LEN = 175; // matches stroke-dasharray in CSS
const KEEP = 140;     // evict decoded bitmaps further than this from the playhead
const AHEAD = 50;     // decode this many frames ahead (scroll-direction weighted) — generous so fast mobile flicks don't outrun it

const state = {
  blobs: [],
  bitmaps: new Map(),
  count: 0,
  pattern: "",
  current: -1,
  target: 0,
  smooth: 0,
  dir: 1,
  ready: false,
  decoding: new Set(),
};

/* ── loading ───────────────────────────────────────────── */

async function loadManifest() {
  const res = await fetch("frames/frames.json");
  if (!res.ok) throw new Error("no manifest");
  return res.json(); // { count, pattern }
}

function frameURL(i) {
  return state.pattern.replace("%04d", String(i + 1).padStart(4, "0"));
}

const inflight = new Map();

async function fetchBlob(i) {
  if (state.blobs[i]) return state.blobs[i];
  if (inflight.has(i)) return inflight.get(i);
  const p = fetch(frameURL(i))
    .then((res) => res.blob())
    .then((b) => { state.blobs[i] = b; inflight.delete(i); return b; })
    .catch((e) => { inflight.delete(i); throw e; });
  inflight.set(i, p);
  return p;
}

async function decode(i) {
  if (state.bitmaps.has(i) || state.decoding.has(i)) return;
  state.decoding.add(i);
  try {
    // Fetch on demand if this frame hasn't been downloaded yet — a fast
    // flick/fling on mobile can jump the target far past whatever the
    // background prefetch queue has reached, and without this the display
    // just freezes on the last frame it managed to decode.
    if (!state.blobs[i]) await fetchBlob(i);
    let bmp;
    try {
      bmp = await createImageBitmap(state.blobs[i]);
    } catch {
      // createImageBitmap can throw in hidden/backgrounded tabs or some
      // webviews — fall back to a plain <img> element, which drawImage
      // also accepts.
      bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(state.blobs[i]);
      });
    }
    state.bitmaps.set(i, bmp);
  } catch { /* transient fetch/decode failure — retried next tick */ }
  state.decoding.delete(i);
}

function closeBitmap(bmp) {
  if (bmp && typeof bmp.close === "function") bmp.close();
}

function manageWindow(center) {
  for (let d = 0; d <= AHEAD; d++) {
    const fwd = center + d * state.dir;
    const back = center - Math.min(d, 8) * state.dir;
    if (fwd >= 0 && fwd < state.count) decode(fwd);
    if (back >= 0 && back < state.count) decode(back);
  }
  if (state.bitmaps.size > KEEP * 2) {
    for (const [idx, bmp] of state.bitmaps) {
      if (Math.abs(idx - center) > KEEP) {
        closeBitmap(bmp);
        state.bitmaps.delete(idx);
      }
    }
  }
}

function setLoadProgress(frac) {
  const off = RING_LEN * (1 - frac);
  loadring.style.strokeDashoffset = off.toFixed(1);
  loadpct.textContent = `${Math.round(frac * 100)}%`;
}

async function preload() {
  const { count } = state;
  const EAGER = Math.min(Math.ceil(count * 0.15), 80);

  let done = 0;
  await Promise.all(
    Array.from({ length: EAGER }, (_, i) =>
      fetchBlob(i).then(() => {
        done++;
        setLoadProgress(done / EAGER);
      }).catch(() => { done++; })
    )
  );
  await decode(0);
  state.ready = true;
  setLoadProgress(1);
  setTimeout(() => {
    loader.classList.add("done");
    nav.classList.add("show");
  }, 250);

  backgroundPrefetch();
}

// Keeps a deeper read-ahead buffer warm than the tight AHEAD window used for
// decoding, so continuous scrolling rarely has to wait on a fresh network
// fetch. Unlike a plain "walk the whole sequence from the start" loop, this
// re-centers on wherever the user actually is every cycle — so a jump to a
// totally different part of the film doesn't leave it stuck fetching frames
// that are no longer relevant, and it never competes with the on-demand
// fetches in decode()/manageWindow() for the same frames at the same time.
async function backgroundPrefetch() {
  const HORIZON = 200;
  const BATCH = 12;
  for (;;) {
    const base = Math.round(state.target) || 0;
    const from = Math.min(state.count, base + AHEAD);
    const to = Math.min(state.count, base + AHEAD + HORIZON);
    const jobs = [];
    for (let i = from; i < to; i++) {
      if (!state.blobs[i]) jobs.push(fetchBlob(i).catch(() => {}));
      if (jobs.length >= BATCH) break;
    }
    if (jobs.length) await Promise.all(jobs);
    else await new Promise((r) => setTimeout(r, 250));
  }
}

/* ── drawing ───────────────────────────────────────────── */

// Mobile browsers resize the visual viewport (hide/show the address bar)
// *while the user is scrolling*, which changes window.innerHeight mid-gesture.
// #track / #stage are sized off a locked --vh1 custom property instead of the
// raw `vh` unit, so the sticky film's pin point and scroll-fraction math stay
// stable through that — otherwise the pinned frame can appear to freeze or
// jump right as the address bar collapses.
let lockedVH = window.innerHeight;
function setLockedVH(h) {
  lockedVH = h;
  document.documentElement.style.setProperty("--vh1", (h * 0.01).toFixed(2) + "px");
}
setLockedVH(window.innerHeight);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  state.current = -1;
}

function nearestDecoded(i) {
  if (state.bitmaps.has(i)) return i;
  for (let d = 1; d < state.count; d++) {
    if (state.bitmaps.has(i - d)) return i - d;
    if (state.bitmaps.has(i + d)) return i + d;
  }
  return -1;
}

function drawFrame(i) {
  const j = nearestDecoded(i);
  if (j < 0) return;
  const bmp = state.bitmaps.get(j);
  const cw = canvas.width, ch = canvas.height;
  ctx.fillStyle = "#0a0806";
  ctx.fillRect(0, 0, cw, ch);
  const bw = bmp.width || bmp.naturalWidth;
  const bh = bmp.height || bmp.naturalHeight;
  const s = Math.min(cw / bw, ch / bh) * 1.04;
  const w = bw * s, h = bh * s;
  ctx.drawImage(bmp, (cw - w) / 2, (ch - h) / 2, w, h);
  state.current = j;
}

/* ── scroll mapping ────────────────────────────────────── */

function progress() {
  const max = track.offsetHeight - lockedVH;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function updateCaptions(p) {
  for (const el of captions) {
    const tIn = +el.dataset.in, tHold = +el.dataset.hold, tOut = +el.dataset.out;
    const rise = Math.max((tHold - tIn) * 0.4, 0.008);
    const fall = Math.max((tOut - tHold) * 0.6, 0.008);
    let o = 0;
    if (p >= tIn && p <= tOut) {
      o = Math.min((p - tIn) / rise, 1) * Math.min((tOut - p) / fall, 1);
      o = Math.min(Math.max(o, 0), 1);
    }
    el.style.opacity = o.toFixed(3);
    el.style.pointerEvents = o > 0.4 ? "auto" : "none";
    const drift = (p - tHold) * -40;
    el.style.transform = `${transformBase(el)} translateY(${drift.toFixed(1)}px)`;
  }
  scrollCue.style.opacity = p < 0.015 ? 1 : 0;
}

function transformBase(el) {
  if (el.classList.contains("cap-center")) return "translate(-50%, -50%)";
  if (el.classList.contains("cap-bottom")) return "translateX(-50%)";
  return "translateY(-50%)";
}

/* ── main loop ─────────────────────────────────────────── */

let lastT = performance.now();
function tick(now) {
  const dt = Math.min((now - lastT) / 1000, 0.5) || 0.016;
  lastT = now;
  if (state.ready) {
    const p = progress();
    const prevTarget = state.target;
    state.target = p * (state.count - 1);
    if (state.target !== prevTarget) state.dir = state.target >= prevTarget ? 1 : -1;

    // Smoothing exists to stop tiny scroll-noise deltas from flickering the
    // displayed frame — it is NOT meant to animate through a big jump frame
    // by frame. A fast mobile flick (or a nav "jump to chapter" click) can
    // move the target hundreds of frames in one tick; easing through that
    // used to sweep the prefetch window across every frame in between,
    // flooding the browser's connection pool with requests for positions
    // already abandoned by the next tick and starving the one request that
    // actually mattered. So: snap instantly on a big jump, only ease small
    // deltas.
    const jump = state.target - state.smooth;
    if (Math.abs(jump) > 20) {
      state.smooth = state.target;
    } else {
      const k = 1 - Math.exp(-dt * 14);
      state.smooth += jump * k;
      if (Math.abs(state.target - state.smooth) < 0.5) state.smooth = state.target;
    }

    const i = Math.round(state.smooth);
    const targetIdx = Math.round(state.target);
    manageWindow(i);
    // Safety net: always start fetching the exact current scroll target too,
    // even while the eased display value is still catching up to it after a
    // big jump — otherwise the one frame that actually matters can end up
    // waiting behind a wide window of frames near the old position.
    if (targetIdx !== i) decode(targetIdx);
    if (i !== state.current) drawFrame(i);
    updateCaptions(p);
  }
  requestAnimationFrame(tick);
}

/* ── boot ──────────────────────────────────────────────── */

function devPlaceholder(msg) {
  loader.classList.add("done");
  nav.classList.add("show");
  const draw = () => {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#171310");
    g.addColorStop(1, "#0a0806");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(185,146,79,0.85)";
    ctx.font = `${16 * (window.devicePixelRatio || 1)}px "Cormorant Garamond", serif`;
    ctx.textAlign = "center";
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  };
  draw();
  window.addEventListener("resize", () => { resize(); draw(); });
}

let lastW = window.innerWidth;
function handleResize() {
  const widthChanged = Math.abs(window.innerWidth - lastW) > 2;
  const bigHeightChange = Math.abs(window.innerHeight - lockedVH) > 120; // rotation/keyboard, not address-bar jitter
  if (widthChanged || bigHeightChange) {
    lastW = window.innerWidth;
    setLockedVH(window.innerHeight);
  }
  resize();
}
window.addEventListener("resize", handleResize, { passive: true });
window.addEventListener("orientationchange", () => setTimeout(handleResize, 300));
resize();

loadManifest()
  .then((m) => {
    state.count = m.count;
    state.pattern = m.pattern;
    state.blobs = new Array(m.count).fill(null);
    requestAnimationFrame(tick);
    return preload();
  })
  .catch(() => devPlaceholder("frames not found — check the frames/ folder"));

/* ── nav: solid background after leaving the top, scroll targeting ── */

function trackScrollTop() {
  const max = track.offsetHeight - lockedVH;
  return Math.max(max, 0);
}

function scrollToFraction(frac) {
  const max = trackScrollTop();
  window.scrollTo({ top: frac * max, behavior: "smooth" });
}

document.querySelectorAll("[data-frac]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    closeMobileMenu();
    scrollToFraction(parseFloat(el.dataset.frac));
  });
});

document.querySelectorAll("[data-scroll]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    closeMobileMenu();
    const target = el.dataset.scroll;
    if (target === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      document.querySelector(target)?.scrollIntoView({ behavior: "smooth" });
    }
  });
});

/* ── mobile menu ── */

const burger = document.getElementById("burger");
const mobileMenu = document.getElementById("mobileMenu");

function closeMobileMenu() {
  burger.classList.remove("on");
  burger.setAttribute("aria-expanded", "false");
  mobileMenu.classList.remove("on");
}

burger.addEventListener("click", () => {
  const isOn = burger.classList.toggle("on");
  burger.setAttribute("aria-expanded", String(isOn));
  mobileMenu.classList.toggle("on", isOn);
});

window.addEventListener("scroll", () => {
  nav.classList.toggle("solid", window.scrollY > 60);
}, { passive: true });

// Force a redraw when the tab/app regains focus — phones throttle rAF while
// backgrounded (app switch, lock screen), which otherwise leaves a stale
// frame on screen until the next scroll event nudges it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") state.current = -1;
});

/* ── reveal-on-scroll for the brand page below the film ── */

const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.18 }
);
document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));

const revealNow = () => document.querySelectorAll("[data-reveal]:not(.in)").forEach((el) => {
  const r = el.getBoundingClientRect();
  if (r.top < innerHeight * 0.92 && r.bottom > 0) el.classList.add("in");
});
window.addEventListener("scroll", revealNow, { passive: true });
revealNow();
