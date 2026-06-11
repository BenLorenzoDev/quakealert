/* QuakeAlert — live earthquake map, proximity alerts, impact countdown */
(() => {
"use strict";

/* ============================== Constants ============================== */
const USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
const EMSC_WS = "wss://www.seismicportal.eu/standing_order/websocket";
const POLL_MS = 60_000;            // USGS refresh cadence (feed updates every minute)
const S_WAVE_KMS = 3.5;            // shear wave speed — what you feel as strong shaking
const P_WAVE_KMS = 6.1;            // primary wave speed — first (weaker) jolt
const ALERT_FRESH_MS = 30 * 60_000; // only alert for quakes younger than 30 min
const MAX_EVENTS = 600;
const KM_PER_MI = 1.609344;

const OSM_CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const BASEMAPS = {
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: { attribution: OSM_CARTO_ATTR, subdomains: "abcd", maxZoom: 19 },
    bg: "#0a0d12",
  },
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    options: { attribution: OSM_CARTO_ATTR, subdomains: "abcd", maxZoom: 19 },
    bg: "#e8e8e6",
  },
  streets: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    options: { attribution: OSM_CARTO_ATTR, subdomains: "abcd", maxZoom: 19 },
    bg: "#cfe3f5",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: { attribution: "&copy; <a href=\"https://www.esri.com\">Esri</a> &mdash; Maxar, Earthstar Geographics", maxZoom: 19 },
    bg: "#0a0d12",
  },
  terrain: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: { attribution: OSM_CARTO_ATTR + ' &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', subdomains: "abc", maxZoom: 17 },
    bg: "#dfe9dc",
  },
};

const DEFAULTS = {
  radiusMi: 1000,
  minMag: 4.0,
  units: "mi",
  notify: false,
  sound: true,
  basemap: "dark",
  userLat: null,
  userLon: null,
  locSource: null, // "gps" | "manual"
};

/* ============================== State ============================== */
let settings = loadSettings();
const events = new Map();      // id -> event
const alerted = new Set(JSON.parse(localStorage.getItem("qa_alerted") || "[]"));
let map, baseLayer, youMarker, youCircle, selectedFeltCircle = null;
let wsOk = false, pollOk = false, ws = null, wsRetry = 1000;
let activeAlert = null;        // event currently shown in alert overlay
let countdownTimer = null;
let deferredInstall = null;
let audioCtx = null;
let pickMode = false;          // next map tap sets user location

/* ============================== Utils ============================== */
const $ = (id) => document.getElementById(id);

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("qa_settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem("qa_settings", JSON.stringify(settings)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Empirical felt radius (km) from magnitude: M3≈25km, M5≈120km, M7≈575km
function feltRadiusKm(mag) {
  if (mag == null || mag < 1.5) return 0;
  return Math.min(1500, Math.pow(10, 0.37 * mag + 0.19));
}

function magColor(m) {
  if (m == null) return "#7a8a99";
  if (m < 2) return "#3ddc84";
  if (m < 3) return "#a8d24a";
  if (m < 4) return "#ffd23c";
  if (m < 5) return "#ffb03c";
  if (m < 6) return "#ff7a3c";
  if (m < 7) return "#ff4d2e";
  return "#d4145a";
}

function fmtDist(km) {
  if (settings.units === "mi") {
    const mi = km / KM_PER_MI;
    return (mi >= 100 ? Math.round(mi) : mi.toFixed(1)) + " mi";
  }
  return (km >= 100 ? Math.round(km) : km.toFixed(1)) + " km";
}

function fmtAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return (s / 86400).toFixed(1) + "d ago";
}

function userLoc() {
  return (settings.userLat != null) ? { lat: settings.userLat, lon: settings.userLon } : null;
}

function distToUserKm(ev) {
  const u = userLoc();
  return u ? haversineKm(u.lat, u.lon, ev.lat, ev.lon) : null;
}

// longitude of the world copy closest to the current view center — tiles wrap
// endlessly, so every overlay must follow the copy the user is looking at
function viewLon(lon) {
  const c = map ? map.getCenter().lng : 0;
  return lon + 360 * Math.round((c - lon) / 360);
}

function rewrapOverlays() {
  for (const ev of events.values()) {
    if (!ev.marker) continue;
    const lon = viewLon(ev.lon);
    if (ev.marker.getLatLng().lng !== lon) {
      ev.marker.setLatLng([ev.lat, lon]);
      if (ev.feltCircle) ev.feltCircle.setLatLng([ev.lat, lon]);
    }
  }
  if (selectedFeltCircle && selectedFeltCircle._qaEv) {
    const e = selectedFeltCircle._qaEv;
    selectedFeltCircle.setLatLng([e.lat, viewLon(e.lon)]);
  }
  const u = userLoc();
  if (u && youMarker) {
    const lon = viewLon(u.lon);
    youMarker.setLatLng([u.lat, lon]);
    if (youCircle) youCircle.setLatLng([u.lat, lon]);
  }
}

/* ============================== Map ============================== */
function initMap() {
  map = L.map("map", { zoomControl: false, worldCopyJump: false, attributionControl: true })
    .setView([20, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // never allow zooming out past "one world fills the screen" — markers exist on
  // only one world copy, so repeated worlds would show earthquakes just once
  const applyMinZoom = () => {
    const z = Math.max(2, Math.ceil(Math.log2(map.getSize().x / 256)));
    map.setMinZoom(z);
    if (map.getZoom() < z) map.setZoom(z);
  };
  applyMinZoom();
  map.on("resize", applyMinZoom);
  // clamp vertical panning only — horizontal stays free so the world can wrap;
  // overlays are re-anchored to the visible world copy on every move (rewrapOverlays)
  map.setMaxBounds([[-85, -1e7], [85, 1e7]]);
  map.on("moveend", rewrapOverlays);
  applyBasemap();

  // a map tap sets your location only when none exists yet, or when explicitly
  // armed via the settings button — stray taps must never move you silently
  map.on("click", (e) => {
    if (pickMode || !userLoc()) {
      pickMode = false;
      setUserLocation(e.latlng.lat, e.latlng.lng, "manual");
      toast("📍 Location set");
    }
  });
}

function applyBasemap() {
  const bm = BASEMAPS[settings.basemap] || BASEMAPS.dark;
  if (baseLayer) baseLayer.remove();
  baseLayer = L.tileLayer(bm.url, bm.options).addTo(map);
  baseLayer.bringToBack();
  $("map").style.background = bm.bg; // fills tile-load gaps and the clamped poles
  if (map.getMaxZoom() !== bm.options.maxZoom) {
    map.setMaxZoom(bm.options.maxZoom);
    if (map.getZoom() > bm.options.maxZoom) map.setZoom(bm.options.maxZoom);
  }
}

function setUserLocation(lat, lon, source) {
  settings.userLat = lat; settings.userLon = lon; settings.locSource = source;
  saveSettings();
  hideLocBanner();
  drawYou();
  renderList();
  refreshAllDistances();
}

let toastTimer = null;
function toast(msg) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast"; el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function drawYou() {
  const u = userLoc();
  if (!u) return;
  const lon = viewLon(u.lon);
  const icon = L.divIcon({ className: "you-marker", html: '<div class="ring"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  if (youMarker) youMarker.setLatLng([u.lat, lon]);
  else youMarker = L.marker([u.lat, lon], { icon, zIndexOffset: 1000, title: "You" }).addTo(map);

  const radiusM = settings.radiusMi * KM_PER_MI * 1000;
  if (youCircle) { youCircle.setLatLng([u.lat, lon]); youCircle.setRadius(radiusM); }
  else youCircle = L.circle([u.lat, lon], {
    radius: radiusM, color: "#2f80ed", weight: 1, opacity: .5,
    fillColor: "#2f80ed", fillOpacity: .05, interactive: false,
  }).addTo(map);
}

function requestGeolocation(force = false) {
  if (!("geolocation" in navigator)) { if (!userLoc()) showLocBanner(); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // don't clobber a deliberately chosen manual location at boot
      if (!force && settings.locSource === "manual") return;
      setUserLocation(pos.coords.latitude, pos.coords.longitude, "gps");
      map.setView([pos.coords.latitude, pos.coords.longitude], 5);
    },
    () => { if (!userLoc()) showLocBanner(); },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
  );
}

function showLocBanner() { $("loc-banner").classList.remove("hidden"); }
function hideLocBanner() { $("loc-banner").classList.add("hidden"); }

/* ============================== Events store ============================== */
function normalizeUSGS(f) {
  const p = f.properties, [lon, lat, depth] = f.geometry.coordinates;
  return {
    id: "us_" + f.id, src: "usgs", lat, lon,
    depth: depth ?? 0, mag: p.mag, place: p.place || "Unknown region",
    time: p.time, url: p.url,
  };
}
function normalizeEMSC(p, geom) {
  return {
    id: "em_" + p.unid, src: "emsc",
    lat: p.lat ?? geom.coordinates[1], lon: p.lon ?? geom.coordinates[0],
    depth: Math.abs(p.depth ?? 0), mag: p.mag, place: p.flynn_region || "Unknown region",
    time: Date.parse(p.time),
  };
}

// Same physical quake reported by both feeds → keep one
function findDuplicate(ev) {
  for (const e of events.values()) {
    if (e.id === ev.id) return e;
    if (e.src !== ev.src &&
        Math.abs(e.time - ev.time) < 20_000 &&
        haversineKm(e.lat, e.lon, ev.lat, ev.lon) < 100) return e;
  }
  return null;
}

function upsertEvent(ev, { live } = { live: false }) {
  const dup = findDuplicate(ev);
  if (dup) {
    // prefer USGS metadata (reviewed, nicer place names); keep original marker id
    if (ev.src === "usgs" || dup.src === ev.src) {
      const keepId = dup.id;
      Object.assign(dup, ev, { id: keepId });
      updateMarker(dup);
    }
    return dup;
  }
  events.set(ev.id, ev);
  addMarker(ev);
  if (live) maybeAlert(ev);
  return ev;
}

function pruneEvents() {
  const cutoff = Date.now() - 26 * 3600_000;
  const sorted = [...events.values()].sort((a, b) => b.time - a.time);
  for (const e of sorted) {
    if (e.time < cutoff || sorted.indexOf(e) >= MAX_EVENTS) {
      if (e.marker) map.removeLayer(e.marker);
      if (e.feltCircle) map.removeLayer(e.feltCircle);
      events.delete(e.id);
    }
  }
}

/* ============================== Markers ============================== */
function markerHtml(ev) {
  const c = magColor(ev.mag);
  const recent = Date.now() - ev.time < 3600_000;
  return `<div class="core" style="background:${c}"></div>` +
         (recent ? `<div class="pulse" style="background:${c}"></div>` : "");
}
function markerSize(ev) { return Math.max(10, 8 + (ev.mag || 0) * 3); }

function addMarker(ev) {
  const s = markerSize(ev);
  const icon = L.divIcon({ className: "q-marker", html: markerHtml(ev), iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  ev.marker = L.marker([ev.lat, viewLon(ev.lon)], { icon, zIndexOffset: Math.round((ev.mag || 0) * 10) }).addTo(map);
  ev.marker.on("click", () => selectEvent(ev.id, { pan: false }));

  // significant + recent quakes get a persistent felt-radius circle
  if ((ev.mag || 0) >= 4.5 && Date.now() - ev.time < 3600_000) {
    ev.feltCircle = makeFeltCircle(ev, 0.35).addTo(map);
  }
  renderList();
}

function updateMarker(ev) {
  if (!ev.marker) return;
  const s = markerSize(ev);
  ev.marker.setLatLng([ev.lat, viewLon(ev.lon)]);
  ev.marker.setIcon(L.divIcon({ className: "q-marker", html: markerHtml(ev), iconSize: [s, s], iconAnchor: [s / 2, s / 2] }));
  renderList();
}

function makeFeltCircle(ev, opacity) {
  const c = L.circle([ev.lat, viewLon(ev.lon)], {
    radius: feltRadiusKm(ev.mag) * 1000,
    color: magColor(ev.mag), weight: 1.5, opacity,
    fillColor: magColor(ev.mag), fillOpacity: 0.08, interactive: false,
  });
  c._qaEv = ev;
  return c;
}

function refreshAllDistances() { renderList(); }

/* ============================== Detail panel ============================== */
function selectEvent(id, { pan = true } = {}) {
  const ev = events.get(id);
  if (!ev) return;
  if (selectedFeltCircle) { map.removeLayer(selectedFeltCircle); selectedFeltCircle = null; }
  if (!ev.feltCircle && feltRadiusKm(ev.mag) > 0) {
    selectedFeltCircle = makeFeltCircle(ev, 0.6).addTo(map);
  }
  if (pan) map.setView([ev.lat, viewLon(ev.lon)], Math.max(map.getZoom(), 5));

  const dKm = distToUserKm(ev);
  const fr = feltRadiusKm(ev.mag);
  const wouldFeel = dKm != null && dKm <= fr;
  const sArr = dKm != null ? new Date(ev.time + (dKm / S_WAVE_KMS) * 1000) : null;
  const passed = sArr && sArr.getTime() < Date.now();

  $("detail-body").innerHTML = `
    <div class="d-mag" style="color:${magColor(ev.mag)}">M ${ev.mag != null ? ev.mag.toFixed(1) : "?"}</div>
    <div class="d-place">${esc(ev.place)}</div>
    <div class="d-grid">
      <div class="d-cell"><div class="k">When</div><div class="v">${fmtAgo(ev.time)}</div></div>
      <div class="d-cell"><div class="k">Depth</div><div class="v">${ev.depth != null ? ev.depth.toFixed(0) + " km" : "—"}</div></div>
      <div class="d-cell"><div class="k">Distance from you</div><div class="v">${dKm != null ? fmtDist(dKm) : "set location"}</div></div>
      <div class="d-cell"><div class="k">Felt radius (est.)</div><div class="v">${fr ? fmtDist(fr) : "—"}</div></div>
    </div>
    <div class="d-felt ${wouldFeel ? "feel" : ""}">
      ${dKm == null ? "Set your location to see impact estimates."
        : wouldFeel
          ? (passed ? "⚠ You were inside the estimated felt radius of this quake." : "⚠ You are inside the estimated felt radius — shaking may be felt at your location.")
          : "You are outside the estimated felt radius — you likely won't feel this one."}
    </div>`;
  $("detail").classList.remove("hidden");
}

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

/* ============================== List ============================== */
function renderList() {
  const ul = $("quake-list");
  const sorted = [...events.values()].sort((a, b) => b.time - a.time).slice(0, 100);
  $("quake-count").textContent = String(events.size);
  ul.innerHTML = sorted.map((ev) => {
    const dKm = distToUserKm(ev);
    const inR = dKm != null && dKm <= settings.radiusMi * KM_PER_MI;
    return `<li class="quake-item ${inR ? "in-radius" : ""}" data-id="${esc(ev.id)}">
      <div class="mag-chip" style="background:${magColor(ev.mag)}">${ev.mag != null ? ev.mag.toFixed(1) : "?"}</div>
      <div class="q-info">
        <div class="q-place">${esc(ev.place)}</div>
        <div class="q-meta">${fmtAgo(ev.time)} · depth ${ev.depth != null ? ev.depth.toFixed(0) : "?"} km</div>
      </div>
      <div class="q-dist">${dKm != null ? fmtDist(dKm) : ""}</div>
    </li>`;
  }).join("");
}

/* ============================== Data feeds ============================== */
async function pollUSGS() {
  try {
    const res = await fetch(USGS_FEED, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const firstLoad = events.size === 0;
    for (const f of data.features) {
      if (f.geometry?.type !== "Point") continue;
      upsertEvent(normalizeUSGS(f), { live: !firstLoad });
    }
    pollOk = true;
  } catch (e) {
    pollOk = false;
    console.warn("USGS poll failed", e);
  }
  pruneEvents();
  updateConnStatus();
}

function connectEMSC() {
  try { ws = new WebSocket(EMSC_WS); } catch { wsOk = false; updateConnStatus(); return; }
  ws.onopen = () => { wsOk = true; wsRetry = 1000; updateConnStatus(); };
  ws.onmessage = (msg) => {
    try {
      const { action, data } = JSON.parse(msg.data);
      if ((action === "create" || action === "update") && data?.properties) {
        upsertEvent(normalizeEMSC(data.properties, data.geometry || { coordinates: [0, 0] }), { live: action === "create" });
        renderList();
      }
    } catch (e) { console.warn("WS parse", e); }
  };
  ws.onclose = ws.onerror = () => {
    if (!wsOk && ws?.readyState !== WebSocket.CLOSED) return;
    wsOk = false; updateConnStatus();
    setTimeout(connectEMSC, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 60_000);
  };
}

function updateConnStatus() {
  const el = $("conn-status"), label = $("conn-label");
  el.classList.remove("live", "poll", "down");
  if (wsOk) { el.classList.add("live"); label.textContent = "LIVE"; }
  else if (pollOk) { el.classList.add("poll"); label.textContent = "polling"; }
  else { el.classList.add("down"); label.textContent = "offline"; }
}

/* ============================== Alert engine ============================== */
function maybeAlert(ev) {
  if (ev.mag == null || ev.mag < settings.minMag) return;
  if (Date.now() - ev.time > ALERT_FRESH_MS) return;
  if (alerted.has(alertKey(ev))) return;
  const dKm = distToUserKm(ev);
  if (dKm == null || dKm > settings.radiusMi * KM_PER_MI) return;

  alerted.add(alertKey(ev));
  localStorage.setItem("qa_alerted", JSON.stringify([...alerted].slice(-200)));
  triggerAlert(ev);
}

function alertKey(ev) { return `${Math.round(ev.time / 30000)}_${ev.lat.toFixed(1)}_${ev.lon.toFixed(1)}`; }

function triggerAlert(ev) {
  showAlertOverlay(ev);
  if (settings.sound) playSiren();
  if (settings.notify) sendNotification(ev);
  if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]);
}

function showAlertOverlay(ev) {
  activeAlert = ev;
  const dKm = distToUserKm(ev);
  $("alert-mag").textContent = `M ${ev.mag != null ? ev.mag.toFixed(1) : "?"}`;
  $("alert-mag").style.color = magColor(ev.mag);
  $("alert-place").textContent = ev.place;
  $("alert-dist").textContent = dKm != null
    ? `${fmtDist(dKm)} from your location · ${fmtAgo(ev.time)}`
    : fmtAgo(ev.time);
  $("alert-overlay").classList.remove("hidden");
  startCountdown(ev);
}

function startCountdown(ev) {
  stopCountdown();
  const tick = () => {
    const dKm = distToUserKm(ev);
    const cd = $("countdown"), sub = $("countdown-sub"), label = $("countdown-label");
    if (dKm == null) { cd.textContent = "--:--"; sub.textContent = "Set your location to estimate arrival."; return; }

    const fr = feltRadiusKm(ev.mag);
    const wouldFeel = dKm <= fr;
    const sEta = ev.time + (dKm / S_WAVE_KMS) * 1000 - Date.now();
    const pEta = ev.time + (dKm / P_WAVE_KMS) * 1000 - Date.now();

    if (sEta <= 0) {
      cd.textContent = "0:00";
      cd.className = "countdown zero";
      label.textContent = "Shaking wave arrival";
      sub.textContent = wouldFeel
        ? "The wave has reached your location."
        : "Countdown complete — you were outside the felt radius, so no impact at your location.";
      stopCountdown();
      return;
    }
    const totalS = Math.ceil(sEta / 1000);
    cd.textContent = `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
    cd.className = "countdown" + (wouldFeel && totalS < 30 ? " danger" : "");
    label.textContent = "Estimated shaking arrives in";
    sub.textContent = (pEta > 0 ? `First jolt (P-wave) in ~${Math.ceil(pEta / 1000)}s. ` : "") +
      (wouldFeel
        ? "You are inside the estimated felt radius — take cover now."
        : "You are outside the estimated felt radius — countdown will reach zero without impact.");
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

function dismissAlert() {
  $("alert-overlay").classList.add("hidden");
  stopCountdown();
  activeAlert = null;
}

/* ============================== Notifications ============================== */
async function sendNotification(ev) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const dKm = distToUserKm(ev);
  const body = `${ev.place}\n${dKm != null ? fmtDist(dKm) + " from you · " : ""}${fmtAgo(ev.time)} — tap for countdown`;
  const opts = {
    body, tag: "quake-" + ev.id, renotify: true,
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    vibrate: [400, 150, 400], requireInteraction: true,
    data: { id: ev.id },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(`⚠ M${ev.mag?.toFixed(1)} Earthquake`, opts);
    else new Notification(`⚠ M${ev.mag?.toFixed(1)} Earthquake`, opts);
  } catch (e) { console.warn("notify failed", e); }
}

/* ============================== Siren ============================== */
function playSiren() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(640, now + i * 0.9);
      o.frequency.linearRampToValueAtTime(980, now + i * 0.9 + 0.45);
      o.frequency.linearRampToValueAtTime(640, now + i * 0.9 + 0.85);
      g.gain.setValueAtTime(0.0001, now + i * 0.9);
      g.gain.exponentialRampToValueAtTime(0.3, now + i * 0.9 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.9 + 0.85);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.9); o.stop(now + i * 0.9 + 0.9);
    }
  } catch (e) { console.warn("siren failed", e); }
}

/* ============================== Settings UI ============================== */
function syncSettingsUI() {
  $("set-radius").value = settings.radiusMi;
  $("radius-val").textContent = settings.units === "mi"
    ? `${settings.radiusMi} mi` : `${Math.round(settings.radiusMi * KM_PER_MI)} km`;
  $("set-minmag").value = settings.minMag;
  $("minmag-val").textContent = "M " + Number(settings.minMag).toFixed(1);
  $("set-units").value = settings.units;
  $("set-basemap").value = BASEMAPS[settings.basemap] ? settings.basemap : "dark";
  $("set-notify").checked = settings.notify && Notification?.permission === "granted";
  $("set-sound").checked = settings.sound;
}

function wireSettings() {
  $("btn-settings").onclick = () => { syncSettingsUI(); $("settings-modal").classList.remove("hidden"); };
  document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => $(b.dataset.close).classList.add("hidden"));
  $("settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") $("settings-modal").classList.add("hidden"); });

  // alert-distance slider: while adjusting, ghost the dialog and fit the map
  // to the radius circle so the user sees exactly what the distance covers
  const radiusSlider = $("set-radius");
  let adjustEndTimer = null, radiusPointerDown = false;
  const fitToRadius = () => {
    if (youCircle) map.fitBounds(youCircle.getBounds(), { animate: false, padding: [48, 48] });
  };
  const startAdjust = () => {
    clearTimeout(adjustEndTimer);
    const modal = $("settings-modal");
    if (!modal.classList.contains("adjusting")) {
      modal.classList.add("adjusting");
      if (youCircle) youCircle.setStyle({ opacity: .85, weight: 2, fillOpacity: .12 });
      if (!userLoc()) toast("Set your location to preview the alert radius");
    }
    fitToRadius();
  };
  const endAdjust = (delay) => {
    clearTimeout(adjustEndTimer);
    adjustEndTimer = setTimeout(() => {
      $("settings-modal").classList.remove("adjusting");
      if (youCircle) youCircle.setStyle({ opacity: .5, weight: 1, fillOpacity: .05 });
    }, delay);
  };
  radiusSlider.addEventListener("pointerdown", () => { radiusPointerDown = true; startAdjust(); });
  const releaseAdjust = () => { if (radiusPointerDown) { radiusPointerDown = false; endAdjust(450); } };
  window.addEventListener("pointerup", releaseAdjust);
  window.addEventListener("pointercancel", releaseAdjust);
  radiusSlider.oninput = (e) => {
    settings.radiusMi = Number(e.target.value); saveSettings(); syncSettingsUI();
    drawYou(); renderList();
    startAdjust();
    if (!radiusPointerDown) endAdjust(1300); // keyboard arrows: linger, then restore
  };
  $("set-minmag").oninput = (e) => { settings.minMag = Number(e.target.value); saveSettings(); syncSettingsUI(); };
  $("set-units").onchange = (e) => { settings.units = e.target.value; saveSettings(); syncSettingsUI(); renderList(); };
  $("set-basemap").onchange = (e) => { settings.basemap = e.target.value; saveSettings(); applyBasemap(); };
  $("set-sound").onchange = (e) => {
    settings.sound = e.target.checked; saveSettings();
    if (settings.sound) { // unlock audio on user gesture
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume?.();
    }
  };
  $("set-notify").onchange = async (e) => {
    if (e.target.checked) {
      const perm = await Notification.requestPermission();
      settings.notify = perm === "granted";
      if (!settings.notify) e.target.checked = false;
    } else settings.notify = false;
    saveSettings(); syncSettingsUI();
  };
  $("btn-pick-loc").onclick = () => {
    $("settings-modal").classList.add("hidden");
    pickMode = true;
    toast("Tap the map to set your location");
  };
  $("btn-test-alert").onclick = () => {
    $("settings-modal").classList.add("hidden");
    const u = userLoc() || { lat: 14.6, lon: 121.0 };
    // fake quake ~280 km away, big enough to be felt — full pipeline test
    const ev = {
      id: "test_" + Date.now(), src: "test",
      lat: u.lat + 1.8, lon: u.lon + 1.8, depth: 10,
      mag: 6.4, place: "TEST EARTHQUAKE (simulation)", time: Date.now() - 4000,
    };
    upsertEvent(ev, { live: false });
    triggerAlert(ev);
  };
}

/* ============================== Alert overlay wiring ============================== */
function wireAlertUI() {
  $("alert-close").onclick = $("alert-dismiss").onclick = dismissAlert;
  $("alert-view-map").onclick = () => {
    if (!activeAlert) return dismissAlert();
    const ev = activeAlert;
    dismissAlert();
    selectEvent(ev.id);
    map.setView([ev.lat, viewLon(ev.lon)], 6);
  };
}

/* ============================== Sheet / misc UI ============================== */
function wireUI() {
  $("sheet-handle").onclick = () => {
    const opening = $("sheet").classList.contains("collapsed");
    $("sheet").classList.toggle("collapsed");
    if (opening) {
      $("detail").classList.add("hidden");
      if (selectedFeltCircle) { map.removeLayer(selectedFeltCircle); selectedFeltCircle = null; }
    }
  };
  $("quake-list").addEventListener("click", (e) => {
    const li = e.target.closest(".quake-item");
    if (li) { $("sheet").classList.add("collapsed"); selectEvent(li.dataset.id); }
  });
  $("detail-close").onclick = () => {
    $("detail").classList.add("hidden");
    if (selectedFeltCircle) { map.removeLayer(selectedFeltCircle); selectedFeltCircle = null; }
  };
  $("btn-locate").onclick = () => {
    const u = userLoc();
    if (u) map.setView([u.lat, u.lon], 6);
    requestGeolocation(true);
  };
  $("loc-banner-close").onclick = hideLocBanner;

  // open alert from notification click (sw posts hash)
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
}

function openFromHash() {
  const m = location.hash.match(/#ev=(.+)/);
  if (m) {
    const ev = events.get(decodeURIComponent(m[1]));
    if (ev) { showAlertOverlay(ev); selectEvent(ev.id); }
    history.replaceState(null, "", location.pathname);
  }
}

/* ============================== PWA install ============================== */
function wirePWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw reg failed", e));
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "open-event") {
        const ev = events.get(e.data.id);
        if (ev) { showAlertOverlay(ev); selectEvent(ev.id); }
      }
    });
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    $("btn-install").classList.remove("hidden");
  });
  $("btn-install").onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("btn-install").classList.add("hidden");
  };
  window.addEventListener("appinstalled", () => $("btn-install").classList.add("hidden"));
}

/* ============================== Test hooks (also used by demos) ============================== */
window.__qa = {
  injectQuake(opts = {}) {
    const u = userLoc() || { lat: 0, lon: 0 };
    const ev = {
      id: opts.id || "inj_" + Date.now(), src: "test",
      lat: opts.lat ?? u.lat + 2, lon: opts.lon ?? u.lon + 2,
      depth: opts.depth ?? 10, mag: opts.mag ?? 6.0,
      place: opts.place || "Injected test quake",
      time: opts.time ?? Date.now() - 2000,
    };
    upsertEvent(ev, { live: true });
    return ev.id;
  },
  setUserLocation: (lat, lon) => setUserLocation(lat, lon, "manual"),
  get map() { return map; },
  get events() { return events; },
  getState: () => ({
    events: events.size, wsOk, pollOk,
    user: userLoc(), settings: { ...settings },
    activeAlert: activeAlert?.id || null,
  }),
  dismissAlert,
};

/* ============================== Boot ============================== */
function refreshLoop() {
  // keep "x ago" labels and pulse states fresh
  setInterval(() => { renderList(); }, 30_000);
}

initMap();
wireSettings();
wireAlertUI();
wireUI();
wirePWA();
drawYou();
syncSettingsUI();
requestGeolocation();
pollUSGS();
setInterval(pollUSGS, POLL_MS);
connectEMSC();
refreshLoop();

})();
