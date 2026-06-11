# QuakeAlert 🌍

A free, installable web app (PWA) that shows **live earthquakes on a world map** and **alerts you** when one happens within your chosen distance — with a real-time **countdown until the shaking reaches you**.

## Features

- **Live earthquake map** — dark world map with every earthquake from the last 24 hours. Markers are sized and colored by magnitude, recent quakes pulse, and significant ones show their estimated *felt radius* as a glowing circle.
- **Two real-time data sources** — EMSC SeismicPortal WebSocket (instant push, worldwide) + USGS feed (refreshed every minute). Duplicates are merged automatically. The badge in the top bar shows `LIVE` when the push feed is connected.
- **Proximity alerts** — set your alert distance (50–3000 mi) and minimum magnitude in Settings. When a new quake matches, you get a full-screen alarm, siren, vibration, and a phone notification.
- **Impact countdown** — the alert shows when the strong shaking (S-wave, ~3.5 km/s) will reach your location, plus the first jolt (P-wave). If the quake is too far to feel, the app tells you so — the countdown simply reaches zero without impact.
- **Felt-radius estimate** — every quake's detail card tells you whether you're inside or outside the area where shaking is likely felt.
- **Works offline** — the app shell and visited map tiles are cached; live data resumes when you're back online.

## Install on your phone

1. Open the app URL in **Chrome (Android)** or **Safari (iPhone)**.
2. **Android:** tap the **Install** button in the top bar (or browser menu → *Add to Home screen*).
   **iPhone:** tap **Share → Add to Home Screen**.
3. Open it from your home screen like a normal app.
4. In **Settings (⚙)**: set your alert distance, minimum magnitude, and turn on **Phone notifications**. Allow location access (or set your location manually on the map).
5. Press **Trigger test alert** to preview the full alarm experience.

> **Note:** alerts fire while the app is open (foreground or installed). True background push when the app is closed requires a paid push server — not included in this free, serverless design.

## Run locally

Any static file server works:

```bash
npx http-server -p 8123
# then open http://localhost:8123
```

## Deploy your own

It's 100% static — host the folder anywhere with HTTPS (GitHub Pages, Netlify, Vercel, Cloudflare Pages).

## Data sources & physics

| What | Source |
|------|--------|
| Earthquake feed (poll, 1 min) | [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) |
| Earthquake feed (instant push) | [EMSC SeismicPortal WebSocket](https://www.seismicportal.eu/realtime.html) |
| Map tiles | OpenStreetMap / CARTO dark basemap |

Countdown assumes S-waves travel ≈ 3.5 km/s and P-waves ≈ 6.1 km/s through the crust. Felt radius uses an empirical fit `r(km) = 10^(0.37·M + 0.19)` (≈25 km for M3, ≈120 km for M5, ≈575 km for M7). These are estimates for awareness, **not** an official early-warning system.

## Disclaimer

QuakeAlert is informational. It cannot predict earthquakes and is not a substitute for official warning systems or civil-defense guidance.
