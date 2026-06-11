# Growing Felt-Radius Ripples — Design

**Date:** 2026-06-12
**Status:** Approved

## Goal

Every quake dot on the map emits an animated ripple — a geographic circle expanding
from the epicenter out to that quake's estimated felt radius — so users can see at a
glance how far each quake's impact is estimated to reach. Quakes whose seismic wave
is physically still traveling additionally show a real-time wave-front ring at the
wave's true current position.

## Decisions (user-confirmed)

- **Scope:** all quakes on the map (up to `MAX_EVENTS = 600`), not just significant ones.
- **Animation:** hybrid — a fixed-duration looping ripple for every quake, plus a
  real-time wave front for quakes young enough that the S-wave is still inside the
  felt radius.
- **Existing effects:** the cosmetic screen-space `.pulse` on markers is removed
  (the ripple replaces it). Static felt-radius circles (significant + selected
  quakes) stay as the boundary the ripple grows toward.
- **Approach:** animated `L.circle`s driven by one shared `requestAnimationFrame`
  loop, with per-frame culling (chosen over a custom canvas overlay and over CSS
  transform rings).

## Behavior

### Looping ripple
- Expands radius 0 → `feltRadiusKm(ev.mag)` km over ~3 s, opacity easing ~0.7 → 0,
  then restarts.
- Per-quake phase stagger (derived from a hash of the event id) so ripples don't
  pulse in unison.
- Stroke-only circle (no fill), 1.5–2 px, colored with `magColor(ev.mag)`.

### Real-time wave front
- Shown while `(now − ev.time) / 1000 × S_WAVE_KMS < feltRadiusKm(ev.mag)`.
- Radius = elapsed seconds × `S_WAVE_KMS` (3.5 km/s), recomputed each frame.
- Same color as the ripple, thicker stroke (~2.5 px), steady ~0.8 opacity, subtle
  white inner glow (second stroke) to read as "real, happening now".
- Circle is removed permanently once the wave passes the felt radius.

## Architecture

One animation subsystem in `app.js`:

- **Single rAF loop** (`animateRipples`) drives all ripples and wave fronts. No
  per-quake timers. Loop pauses naturally when the tab is hidden (rAF behavior).
- **Lazy circle creation:** each event gets ripple state on first use — an
  `L.circle` styled like `makeFeltCircle` but stroke-only. The same circle is
  reused across loop iterations via `setRadius()` / `setStyle()`; never recreated
  per frame.
- **Integration points:**
  - `addMarker`: stop emitting the `.pulse` div in `markerHtml`.
  - `pruneEvents` and the feed-merge dedupe path: remove ripple/wave-front circles
    alongside markers.
  - `rewrapOverlays`: ripple centers follow `viewLon(ev.lon)` like all overlays.

## Culling (performance core)

Each frame, before touching a circle, skip the quake when:

1. `feltRadiusKm(ev.mag)` is 0 (mag < 1.5 or null) — these quakes get no ripple at all.
2. The felt radius projects to fewer than ~8 px at the current zoom. Computed
   cheaply: one meters-per-pixel value per frame, then a per-quake multiply.
3. The epicenter ± felt radius falls outside the current map bounds (padded).

Skipped ripples have their circles removed from the map but cached on the event.
Culling re-evaluates continuously each frame; `moveend`/`zoomend` need no special
handling beyond the per-frame checks.

## Edge cases

- **Null/low magnitude:** no ripple (rule 1 above).
- **Antimeridian:** ripple centers use the same `viewLon` world-copy logic as markers.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables the ripple system
  entirely; static felt circles still convey reach.

## Testing

- Extend the `__qa` test hooks with `__qa.rippleStats()` →
  `{ active, culled, waveFronts }`.
- Playwright checks: a synthetic test quake produces an active ripple and (while
  young) a wave front; zooming to world view culls small-radius ripples.
- Manual verification via the existing test-quake hook.
