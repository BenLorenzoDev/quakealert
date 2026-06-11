# Growing Felt-Radius Ripples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every quake dot on the map emits an animated geographic ripple expanding to its estimated felt radius, plus a real-time wave-front ring for quakes whose S-wave is still traveling.

**Architecture:** A single `requestAnimationFrame` loop in `app.js` drives one stroke-only `L.circle` ripple per visible quake (radius animated 0 → felt radius over 3 s, looping with per-quake phase stagger) and a second `L.circle` wave front while `elapsed × 3.5 km/s < feltRadiusKm`. Per-frame culling skips quakes that are off-screen or whose felt radius is sub-pixel at the current zoom, which is what makes 600 events affordable. The old cosmetic screen-space `.pulse` is removed; static felt circles stay.

**Tech Stack:** Vanilla JS (IIFE, no build step), Leaflet 1.x (vendored), CSS. No test framework exists — verification follows the project's established pattern: `window.__qa` hooks asserted via Playwright browser evaluation against `npx http-server -p 8123`.

**Spec:** `docs/superpowers/specs/2026-06-12-felt-radius-ripples-design.md`

**Working directory:** `C:\dev\BenDev\Dagan\quakealert` (all paths below relative to it; it is its own git repo)

---

## Verification harness (used by every task)

Start the server once (leave running):

```bash
npx http-server -p 8123
```

Then drive `http://localhost:8123` with Playwright MCP tools (`browser_navigate`, `browser_evaluate`, `browser_take_screenshot`). The app exposes `window.__qa` with `injectQuake(opts)`, `setUserLocation(lat, lon)`, `map`, `events`, `getState()`. Task 1 adds `__qa.rippleStats()`.

**Note on TDD:** with no JS test runner, each task's "failing test" is a browser assertion run *before* the change (expected to fail / return undefined) and re-run *after* (expected to pass). Keep that order — it proves the assertion actually exercises the new code.

---

### Task 1: Ripple subsystem core

**Files:**
- Modify: `app.js` (new "Ripples" section after the Markers section, i.e. after `refreshAllDistances` at ~line 383; plus boot block ~line 842; plus `__qa` object ~line 812)

- [ ] **Step 1: Write the failing browser assertion**

With the server running, navigate to `http://localhost:8123` and evaluate:

```js
typeof window.__qa.rippleStats
```

Expected: `"undefined"` (FAIL state — hook doesn't exist yet).

- [ ] **Step 2: Add the ripple constants and subsystem**

In `app.js`, insert a new section between `function refreshAllDistances() { renderList(); }` and the `/* ===== Detail panel ===== */` header:

```js
/* ============================== Ripples ============================== */
// Every quake with a non-zero felt radius emits a looping geographic ripple
// (0 → felt radius over RIPPLE_PERIOD_MS). Quakes whose S-wave is physically
// still inside the felt radius also show a real-time wave-front ring.
// One shared rAF loop drives everything; off-screen / sub-pixel ripples are
// culled each frame, which is what keeps MAX_EVENTS quakes affordable.
const RIPPLE_PERIOD_MS = 3000;
const RIPPLE_MIN_PX = 8;      // cull ripples smaller than this on screen

let rippleFrame = null;
const rippleStats = { active: 0, culled: 0, waveFronts: 0 };
const reduceMotionMq = window.matchMedia("(prefers-reduced-motion: reduce)");

// stable 0..1 phase offset per event so 600 ripples don't pulse in unison
function ripplePhase(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

// approximate, at view-center latitude — good enough for culling decisions
function metersPerPixel() {
  return 40075016.686 * Math.abs(Math.cos(map.getCenter().lat * Math.PI / 180))
    / Math.pow(2, map.getZoom() + 8);
}

function makeRippleCircle(ev, weight, className) {
  return L.circle([ev.lat, viewLon(ev.lon)], {
    radius: 1, color: magColor(ev.mag), weight, opacity: 0,
    fill: false, interactive: false, className,
  });
}

function removeRipple(ev) {
  if (ev.ripple) { map.removeLayer(ev.ripple); ev.ripple = null; }
  if (ev.waveFront) { map.removeLayer(ev.waveFront); ev.waveFront = null; }
}

function animateRipples() {
  rippleFrame = requestAnimationFrame(animateRipples);
  const now = Date.now();
  const mpp = metersPerPixel();
  const b = map.getBounds();
  rippleStats.active = 0; rippleStats.culled = 0; rippleStats.waveFronts = 0;

  for (const ev of events.values()) {
    const frKm = feltRadiusKm(ev.mag);
    if (frKm <= 0) continue; // mag < 1.5 or null: never ripples

    // cull: ripple's largest extent can't touch the view, or is sub-pixel
    const lon = viewLon(ev.lon);
    const latPad = frKm / 111; // km → degrees latitude
    const lonPad = latPad / Math.max(0.2, Math.cos(ev.lat * Math.PI / 180));
    const inView = ev.lat > b.getSouth() - latPad && ev.lat < b.getNorth() + latPad &&
                   lon > b.getWest() - lonPad && lon < b.getEast() + lonPad;
    if (!inView || (frKm * 1000) / mpp < RIPPLE_MIN_PX) {
      rippleStats.culled++;
      removeRipple(ev);
      continue;
    }
    rippleStats.active++;

    // looping ripple: radius 0 → felt radius, fading out as it grows
    const phase = ((now / RIPPLE_PERIOD_MS) + ripplePhase(ev.id)) % 1;
    if (!ev.ripple) ev.ripple = makeRippleCircle(ev, 1.5).addTo(map);
    ev.ripple.setRadius(Math.max(1, phase * frKm * 1000));
    ev.ripple.setStyle({ opacity: 0.7 * (1 - phase) });

    // real-time wave front while the S-wave is still inside the felt radius
    const waveKm = ((now - ev.time) / 1000) * S_WAVE_KMS;
    if (waveKm > 0 && waveKm < frKm) {
      if (!ev.waveFront) ev.waveFront = makeRippleCircle(ev, 2.5, "q-wavefront").addTo(map);
      ev.waveFront.setRadius(waveKm * 1000);
      ev.waveFront.setStyle({ opacity: 0.8 });
      rippleStats.waveFronts++;
    } else if (ev.waveFront) {
      map.removeLayer(ev.waveFront);
      ev.waveFront = null;
    }
  }
}

function startRipples() {
  if (rippleFrame || reduceMotionMq.matches) return;
  rippleFrame = requestAnimationFrame(animateRipples);
}

function stopRipples() {
  if (rippleFrame) { cancelAnimationFrame(rippleFrame); rippleFrame = null; }
  for (const ev of events.values()) removeRipple(ev);
}

reduceMotionMq.addEventListener?.("change", () =>
  reduceMotionMq.matches ? stopRipples() : startRipples());
```

- [ ] **Step 3: Expose the test hook and start the loop at boot**

In the `window.__qa = {` object, after the `dismissAlert,` line, add:

```js
  rippleStats: () => ({ ...rippleStats }),
```

In the boot block at the bottom, after `refreshLoop();` add:

```js
startRipples();
```

- [ ] **Step 4: Re-run the assertion to verify it passes**

Reload `http://localhost:8123`, then evaluate:

```js
(async () => {
  __qa.setUserLocation(35, -118);
  __qa.injectQuake({ mag: 6.5, lat: 36, lon: -117, time: Date.now() - 10_000 });
  __qa.map.setView([36, -117], 6);
  await new Promise(r => setTimeout(r, 300)); // let a few frames run
  return __qa.rippleStats();
})()
```

Expected: `active >= 1` and `waveFronts >= 1` (a 10 s-old quake's wave has gone ~35 km, well inside an M6.5's ~370 km felt radius). Dismiss the alert overlay if it appears (`__qa.dismissAlert()`).

Also verify the ripple is actually animating: evaluate
`__qa.events.values().next()` — find the injected event (`[...__qa.events.values()].find(e => e.src === "test")`), then sample `ev.ripple.getRadius()` twice ~200 ms apart and confirm the two values differ.

- [ ] **Step 5: Verify culling**

Evaluate:

```js
(async () => {
  __qa.map.setView([35, -118], 6);
  __qa.injectQuake({ mag: 2.0, lat: -40, lon: 100, time: Date.now() }); // far off-screen
  await new Promise(r => setTimeout(r, 300));
  return __qa.rippleStats();
})()
```

Expected: `culled >= 1` (the off-screen M2 is culled; its mag is ≥ 1.5 so it enters the cull branch rather than being skipped).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: animated felt-radius ripples with real-time wave front"
```

---

### Task 2: Lifecycle integration (prune, update, world-wrap)

**Files:**
- Modify: `app.js` — `pruneEvents` (~line 331), `updateMarker` (~line 365), `rewrapOverlays` (~line 162)

- [ ] **Step 1: Write the failing browser assertion**

Reload the page, then evaluate:

```js
(async () => {
  __qa.setUserLocation(35, -118);
  const id = __qa.injectQuake({ mag: 6.0, lat: 36, lon: -117 });
  __qa.map.setView([36, -117], 6);
  await new Promise(r => setTimeout(r, 300));
  const ev = __qa.events.get(id);
  const hadRipple = !!ev.ripple;
  // simulate prune: this is what pruneEvents does to an evicted event today
  __qa.map.removeLayer(ev.marker); __qa.events.delete(id);
  await new Promise(r => setTimeout(r, 300));
  return { hadRipple, orphaned: hadRipple && __qa.map.hasLayer(ev.ripple) };
})()
```

Expected: `{ hadRipple: true, orphaned: true }` — FAIL state: deleting an event leaves its ripple circle orphaned on the map, proving the leak this task fixes. Reload the page afterward to clear the orphan.

- [ ] **Step 2: Clean up ripples in `pruneEvents`**

In `pruneEvents`, change the removal block from:

```js
      if (e.marker) map.removeLayer(e.marker);
      if (e.feltCircle) map.removeLayer(e.feltCircle);
      events.delete(e.id);
```

to:

```js
      if (e.marker) map.removeLayer(e.marker);
      if (e.feltCircle) map.removeLayer(e.feltCircle);
      removeRipple(e);
      events.delete(e.id);
```

- [ ] **Step 3: Rebuild ripples on magnitude updates in `updateMarker`**

A feed update can change `ev.mag`, which changes ripple color and felt radius. The ripple circle's color is fixed at creation, so drop it and let the next frame recreate it. In `updateMarker`, change:

```js
function updateMarker(ev) {
  if (!ev.marker) return;
  const s = markerSize(ev);
  ev.marker.setLatLng([ev.lat, viewLon(ev.lon)]);
  ev.marker.setIcon(L.divIcon({ className: "q-marker", html: markerHtml(ev), iconSize: [s, s], iconAnchor: [s / 2, s / 2] }));
  renderList();
}
```

to:

```js
function updateMarker(ev) {
  if (!ev.marker) return;
  const s = markerSize(ev);
  ev.marker.setLatLng([ev.lat, viewLon(ev.lon)]);
  ev.marker.setIcon(L.divIcon({ className: "q-marker", html: markerHtml(ev), iconSize: [s, s], iconAnchor: [s / 2, s / 2] }));
  removeRipple(ev); // mag/color may have changed; next frame recreates correctly
  renderList();
}
```

- [ ] **Step 4: Follow world copies in `rewrapOverlays`**

In `rewrapOverlays`, change:

```js
    if (ev.marker.getLatLng().lng !== lon) {
      ev.marker.setLatLng([ev.lat, lon]);
      if (ev.feltCircle) ev.feltCircle.setLatLng([ev.lat, lon]);
    }
```

to:

```js
    if (ev.marker.getLatLng().lng !== lon) {
      ev.marker.setLatLng([ev.lat, lon]);
      if (ev.feltCircle) ev.feltCircle.setLatLng([ev.lat, lon]);
      if (ev.ripple) ev.ripple.setLatLng([ev.lat, lon]);
      if (ev.waveFront) ev.waveFront.setLatLng([ev.lat, lon]);
    }
```

- [ ] **Step 5: Re-run assertions to verify they pass**

Reload, then re-run the Step 1 assertion **replacing the simulated prune with the real path**:

```js
(async () => {
  __qa.setUserLocation(35, -118);
  const id = __qa.injectQuake({ mag: 6.0, lat: 36, lon: -117, time: Date.now() - 27 * 3600_000 });
  __qa.map.setView([36, -117], 6);
  await new Promise(r => setTimeout(r, 300));
  const ev = __qa.events.get(id);
  const hadRipple = !!ev.ripple; // 27h-old: ripples still render (age doesn't cull)
  // next pollUSGS call prunes >26h-old events; force it via the 26h cutoff:
  // easiest deterministic trigger — wait for the auto-poll is too slow, so
  // assert the building block instead: removeRipple is wired into pruneEvents.
  return { hadRipple, pruneWired: true };
})()
```

Then verify the wiring by reading the source (no runtime path triggers `pruneEvents` on demand):

```bash
grep -n "removeRipple(e);" app.js
```

Expected: one hit inside `pruneEvents`. Also `grep -n "removeRipple(ev); // mag" app.js` → one hit inside `updateMarker`, and `grep -n "ev.ripple.setLatLng" app.js` → one hit inside `rewrapOverlays`.

World-wrap check in the browser: pan the map horizontally across the antimeridian (`__qa.map.setView([36, 243], 6)` — same spot one world-copy east) and confirm the injected quake's ripple is visible there (screenshot).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: ripple lifecycle — prune, mag updates, world-wrap"
```

---

### Task 3: Remove the cosmetic pulse; style the wave front

**Files:**
- Modify: `app.js` — `markerHtml` (~line 344), `refreshLoop` comment (~line 838)
- Modify: `app.css` — `.q-marker .pulse` block + `@keyframes pulse` (~lines 89–97), add `.q-wavefront`

- [ ] **Step 1: Write the failing browser assertion**

Reload, inject a recent quake, then evaluate:

```js
document.querySelectorAll(".q-marker .pulse").length
```

Expected: `>= 1` (FAIL state — cosmetic pulses still render).

- [ ] **Step 2: Remove the pulse from `markerHtml`**

Change:

```js
function markerHtml(ev) {
  const c = magColor(ev.mag);
  const recent = Date.now() - ev.time < 3600_000;
  return `<div class="core" style="background:${c}"></div>` +
         (recent ? `<div class="pulse" style="background:${c}"></div>` : "");
}
```

to:

```js
function markerHtml(ev) {
  return `<div class="core" style="background:${magColor(ev.mag)}"></div>`;
}
```

And update the now-stale comment in `refreshLoop` from:

```js
  // keep "x ago" labels and pulse states fresh
```

to:

```js
  // keep "x ago" labels fresh
```

- [ ] **Step 3: Replace the pulse CSS with wave-front styling**

In `app.css`, delete these rules:

```css
.q-marker .pulse {
  position: absolute; inset: 0; border-radius: 50%;
  animation: pulse 2s ease-out infinite;
  pointer-events: none;
}
@keyframes pulse {
  0%   { transform: scale(1);   opacity: .85; }
  100% { transform: scale(3.2); opacity: 0; }
}
```

and in their place add:

```css
/* real-time wave front — white glow marks it as "happening now", distinct
   from the looping decorative ripple */
.q-wavefront {
  filter: drop-shadow(0 0 3px rgba(255, 255, 255, .8));
}
```

- [ ] **Step 4: Re-run the assertion to verify it passes**

Reload, inject a recent quake (`__qa.injectQuake({ mag: 6.0 })` after `__qa.setUserLocation(35, -118)`), then evaluate:

```js
document.querySelectorAll(".q-marker .pulse").length
```

Expected: `0`. Then confirm the wave front carries the glow class:

```js
document.querySelectorAll("path.q-wavefront").length
```

Expected: `>= 1` (the injected quake is seconds old, so its wave front is live). Take a screenshot to `.test-shots/ripples.png` for visual confirmation: ripple ring expanding, brighter glowing wave-front ring, no screen-space pulse.

- [ ] **Step 5: Commit**

```bash
git add app.js app.css
git commit -m "feat: replace cosmetic marker pulse with geographic ripples"
```

---

### Task 4: End-to-end verification sweep

**Files:** none (verification only; fix-forward if anything fails)

- [ ] **Step 1: Full-stats scenario**

Reload `http://localhost:8123` and evaluate:

```js
(async () => {
  __qa.setUserLocation(35, -118);
  __qa.injectQuake({ id: "big", mag: 7.0, lat: 36, lon: -117, time: Date.now() - 30_000 });
  __qa.injectQuake({ id: "small", mag: 2.5, lat: 35.5, lon: -117.5, time: Date.now() - 30_000 });
  __qa.injectQuake({ id: "old", mag: 5.0, lat: 37, lon: -116, time: Date.now() - 3600_000 });
  __qa.dismissAlert();
  __qa.map.setView([36, -117], 7);
  await new Promise(r => setTimeout(r, 400));
  const zoomedIn = __qa.rippleStats();
  __qa.map.setView([36, -117], 2);
  await new Promise(r => setTimeout(r, 400));
  const zoomedOut = __qa.rippleStats();
  return { zoomedIn, zoomedOut };
})()
```

Expected:
- `zoomedIn.active >= 3` (live feed quakes may add more), `zoomedIn.waveFronts >= 1` (the 30 s-old M7's wave has gone ~105 km of its ~575 km felt radius; the 1 h-old M5's wave finished long ago).
- `zoomedOut.culled > 0` and `zoomedOut.active < zoomedIn.active + zoomedOut.culled` sanity: at world zoom the M2.5's ~16 km radius is sub-pixel → culled.

- [ ] **Step 2: Wave-front expiry**

Evaluate (uses a quake whose wave finishes in seconds):

```js
(async () => {
  __qa.setUserLocation(35, -118);
  // M3 ≈ 25 km felt radius; wave covers it in ~7 s. Inject aged 5 s → front
  // alive now, gone in ~3 s.
  const id = __qa.injectQuake({ mag: 3.0, lat: 35.2, lon: -117.8, time: Date.now() - 5_000 });
  __qa.map.setView([35.2, -117.8], 9);
  await new Promise(r => setTimeout(r, 300));
  const before = !!__qa.events.get(id).waveFront;
  await new Promise(r => setTimeout(r, 4_000));
  const after = !!__qa.events.get(id).waveFront;
  return { before, after };
})()
```

Expected: `{ before: true, after: false }` — the front exists while the wave travels and is removed once it passes the felt radius.

- [ ] **Step 3: Performance smoke test**

Evaluate:

```js
(async () => {
  for (let i = 0; i < 200; i++) {
    __qa.injectQuake({ id: "perf_" + i, mag: 2 + (i % 50) / 10,
      lat: 30 + (i % 20), lon: -130 + (i * 7) % 60, time: Date.now() - i * 60_000 });
  }
  __qa.dismissAlert();
  __qa.map.setView([38, -100], 4);
  await new Promise(r => setTimeout(r, 500));
  const t0 = performance.now();
  let frames = 0;
  await new Promise(r => { const f = () => { if (++frames >= 60) return r(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const fps = 60_000 / (performance.now() - t0);
  return { fps: Math.round(fps), stats: __qa.rippleStats() };
})()
```

Expected: `fps >= 30` on a desktop machine with ~200 extra events. If below, raise `RIPPLE_MIN_PX` (8 → 12) and re-measure before considering deeper changes.

- [ ] **Step 4: Reduced-motion check**

Using Playwright, emulate `prefers-reduced-motion: reduce` (`browser_run_code_unsafe` with `page.emulateMedia({ reducedMotion: 'reduce' })`, or relaunch context with that preference), reload, inject a quake, then evaluate:

```js
(async () => {
  __qa.setUserLocation(35, -118);
  __qa.injectQuake({ mag: 6.0, lat: 36, lon: -117 });
  __qa.map.setView([36, -117], 6);
  await new Promise(r => setTimeout(r, 400));
  return { stats: __qa.rippleStats(), circles: document.querySelectorAll("path.q-wavefront").length };
})()
```

Expected: `stats.active === 0` and `circles === 0` — the loop never started. Reset emulation afterward.

- [ ] **Step 5: Screenshots + final commit**

Capture `.test-shots/ripples.png` (zoomed to an active quake showing ripple + wave front + static felt circle) — note `.test-shots/` may be gitignored; that's fine, it's for the session record. If any fixes were made during this task:

```bash
git add -A app.js app.css
git commit -m "fix: ripple verification follow-ups"
```

---

## Self-review notes

- **Spec coverage:** looping ripple (Task 1), wave front (Task 1), culling rules 1–3 (Task 1), stagger (Task 1 `ripplePhase`), prune/dedupe-update/world-wrap integration (Task 2), pulse removal + static circles retained (Task 3 — `makeFeltCircle` and its call sites are untouched), reduced motion (Task 1 code, Task 4 verification), `__qa.rippleStats` (Task 1), Playwright checks (Tasks 1–4). The spec's "feed-merge dedupe path" cleanup is handled by `updateMarker` (Task 2 Step 3), which is the function that dedupe path calls.
- **Tab-hidden pause** comes free with rAF; no code needed.
- **Type consistency:** event fields `ev.ripple` / `ev.waveFront`; helpers `removeRipple(ev)`, `makeRippleCircle(ev, weight, className)`, `ripplePhase(id)`, `metersPerPixel()`, `startRipples()` / `stopRipples()` — used consistently across tasks.
