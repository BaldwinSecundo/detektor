// UAV detector app: waterfall, hunting and analog video with one XIAO ESP32-C5
// on the phone's USB. One radio: the C5 does one thing at a time, so each
// screen puts it in its own mode (sweep / track / video).
import { Link, linkSupport } from "./link.js";
import { DemoLink } from "./demo.js";
import { parseW, parseR, channelName } from "./proto.js";
import { Waterfall } from "./waterfall.js";
import { Detector } from "./detect.js";
import { Video } from "./video.js";
import { Hunt } from "./hunt.js";

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).has("demo");

// ---- settings -----------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem("det." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("det." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const cfg = {
  range: store.get("range", "fpv"),
  gain: store.get("gain", 40),          // sweep and track
  vidPx: store.get("vidPx", 128),
  vidGate: store.get("vidGate", true),
  vidAutoGain: store.get("vidAutoGain", true),
  vidGains: store.get("vidGains", {}),  // last good video gain per 5 MHz
};
const RANGES = { fpv: [5600, 5950], full: [5100, 5950], low: [5300, 5700] };
const VID_MIN = 4900, VID_MAX = 5990, TRACK_MIN = 5110, TRACK_MAX = 5950;
const bucket = mhz => String(Math.round(mhz / 5) * 5);

// ---- objects --------------------------------------------------------------------------
const link = demo ? new DemoLink() : new Link();
const wf = new Waterfall($("spec"), $("wf"));
const det = new Detector();
const video = new Video($("vid"));
const hunt = new Hunt($("huntPlot"));
video.gate = cfg.vidGate;

let view = "wf";
let cursor = null;          // MHz picked on the waterfall
let huntMhz = null;
let vidMhz = null, vidGain = 30;
const confirmed = new Map();   // bucket -> "PAL" | "NTSC" (video locked there)

// ---- log -------------------------------------------------------------------------------
const logLines = [];
function log(t) {
  for (const l of t.split("\n")) if (l) logLines.push(l);
  while (logLines.length > 400) logLines.shift();
  if ($("menu").open) { $("log").textContent = logLines.join("\n"); $("log").scrollTop = 1e9; }
}
function notice(t) { $("notice").textContent = t; $("notice").hidden = !t; }

// ---- link --------------------------------------------------------------------------------
function setDot() {
  $("connDot").className = "dot " + (link.connected ? "ok" : "");
  $("btnConnect").textContent = link.connected ? "Rozłącz" : "Połącz";
  $("btnConnect").classList.toggle("primary", !link.connected);
  $("connText").textContent = link.connected ? (demo ? "demo" : "XIAO C5") : "brak płytki";
}
link.addEventListener("state", e => {
  setDot();
  log(`[link] ${e.detail}`);
  if (e.detail === "connected") {
    notice(demo ? "Tryb demo: dane są symulowane, płytka nie jest potrzebna." : "");
    link.send("hello");
    applyMode();
    wakeLock();
  } else if (e.detail.startsWith("error")) {
    notice("Połączenie z płytką przerwane. Podłącz ją ponownie i naciśnij „Połącz”.");
  }
});
link.addEventListener("frame", e => {
  const { type, payload } = e.detail;
  if (type === "W") onWaterfall(payload);
  else if (type === "V") video.onFrame(payload);
  else if (type === "R") onTrack(payload);
  else if (type === "T") onText(new TextDecoder().decode(payload));
});

$("btnConnect").onclick = async () => {
  if (link.connected) { await link.disconnect(); return; }
  const why = demo ? "" : linkSupport();
  if (why) { notice(why); return; }
  try { await link.connect(true); } catch (err) {
    if (err.name !== "NotFoundError") notice("Nie udało się połączyć: " + err.message);
  }
};

// ---- modes ---------------------------------------------------------------------------------
function sweepCommand() {
  if (cfg.range === "zoom" && cursor != null) {
    const lo = Math.max(5100, Math.round(cursor) - 20), hi = Math.min(5950, lo + 40);
    return `sweep ${hi - 40} ${hi} fine cap 2 line 40`;
  }
  const [lo, hi] = RANGES[cfg.range] || RANGES.fpv;
  return `sweep ${lo} ${hi} wide cap 2 line 40`;
}
function applyMode() {
  if (!link.connected) return;
  link.send(`gain ${cfg.gain}`);
  if (view === "wf") link.send(sweepCommand());
  else if (view === "hunt") startHunt(huntMhz ?? cursor ?? 5800);
  else if (view === "video") { if (vidMhz) startVideo(vidMhz); else link.send(sweepCommand()); }
}

function showView(v, sendMode = true) {
  view = v;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.view === v);
  for (const s of document.querySelectorAll(".view")) s.classList.toggle("on", s.id === "view-" + v);
  wf.dirty = true; hunt.dirty = true;
  if (sendMode) applyMode();
}
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { setAuto(false); showView(b.dataset.view); };

// ---- waterfall ---------------------------------------------------------------------------------
let wfLines = 0;
function onWaterfall(p) {
  const l = parseW(p);
  if (!l) return;
  wf.push(l);
  det.push(l);
  for (const t of det.tracks) {
    const c = confirmed.get(bucket(t.mhz));
    if (c) t.confirmed = c;
  }
  wfLines++;
}
wf.addEventListener("range", () => { det.reset(); });

function snapToTrack(mhz) {
  const t = det.list().find(t => Math.abs(t.mhz - mhz) <= Math.max(5, t.width / 2));
  return t ? Math.round(t.mhz) : Math.round(mhz);
}
function setCursor(mhz) {
  cursor = mhz;
  wf.cursor = mhz;
  wf.dirty = true;
  updateCursorBar();
}
function updateCursorBar() {
  if (cursor == null) { $("cursorBar").hidden = true; return; }
  const ch = channelName(cursor, 2), lv = wf.levelAt(cursor);
  $("curInfo").textContent = `${cursor} MHz${ch ? " · " + ch : ""}${Number.isFinite(lv) ? ` · ${lv >= 0 ? "+" : ""}${lv.toFixed(0)} dB` : ""}`;
  $("cursorBar").hidden = false;
}
wf.addEventListener("tap", e => setCursor(snapToTrack(e.detail.mhz)));
wf.addEventListener("hold", e => { setCursor(snapToTrack(e.detail.mhz)); goVideo(cursor); });
$("btnCurVideo").onclick = () => goVideo(cursor);
$("btnCurHunt").onclick = () => { huntMhz = cursor; showView("hunt"); };
$("btnCurZoom").onclick = () => { cfg.range = "zoom"; $("range").value = "zoom"; store.set("range", "zoom"); applyMode(); };

$("range").value = cfg.range;
$("range").onchange = () => {
  cfg.range = $("range").value;
  if (cfg.range === "zoom" && cursor == null) { notice("Najpierw dotknij sygnału na waterfallu, potem wybierz Zoom."); cfg.range = "fpv"; $("range").value = "fpv"; }
  else notice("");
  store.set("range", cfg.range);
  if (view === "wf") link.send(sweepCommand());
};
$("usePeak").onchange = () => { wf.usePeak = $("usePeak").checked; };
$("btnClearPeak").onclick = () => wf.clearPeaks();

function renderCands() {
  const list = det.list().slice(0, 8);
  wf.marks = list.filter(t => t.cls === "analog" || t.cls === "digital" || t.confirmed)
    .map(t => ({ mhz: t.mhz, width: t.width, label: t.label, cls: t.confirmed || t.cls === "analog" ? "analog" : "other" }));
  const box = $("cands");
  box.replaceChildren(...list.map(t => {
    const b = document.createElement("button");
    b.textContent = `${t.label} · +${t.excess.toFixed(0)} dB`;
    b.className = t.confirmed ? "confirmed" : t.cls;
    b.onclick = () => setCursor(Math.round(t.mhz));
    return b;
  }));
  if (!list.length) box.innerHTML = `<span class="sub">Brak sygnałów ponad szumem.</span>`;
}

// ---- gain (sweep and track) ---------------------------------------------------------------------
function setGain(g) {
  cfg.gain = Math.max(0, Math.min(89, g));
  store.set("gain", cfg.gain);
  for (const o of [$("gainOut"), ...document.querySelectorAll(".gainOut")]) o.textContent = cfg.gain;
  if (link.connected && view !== "video") link.send(`gain ${cfg.gain}`);
  hunt.reset();
}
for (const b of document.querySelectorAll("[data-gain]")) b.onclick = () => setGain(cfg.gain + +b.dataset.gain);
setGain(cfg.gain);

// ---- hunt -----------------------------------------------------------------------------------------
function startHunt(mhz) {
  huntMhz = Math.max(TRACK_MIN, Math.min(TRACK_MAX, Math.round(mhz)));
  hunt.reset();
  $("huntFreq").textContent = `${huntMhz} MHz ${channelName(huntMhz)}`;
  if (link.connected) link.send(`track ${huntMhz} 20`);
}
function onTrack(p) {
  const r = parseR(p);
  if (!r || !r.pilots.length) return;
  hunt.push(r.pilots[0]);
}
for (const b of document.querySelectorAll("[data-hf]")) b.onclick = () => startHunt((huntMhz ?? 5800) + +b.dataset.hf);
$("btnTone").onclick = () => { hunt.setTone(!hunt.toneOn); $("btnTone").textContent = "Dźwięk: " + (hunt.toneOn ? "wł." : "wył."); };
$("btnCompass").onclick = () => { hunt.enableCompass(); $("btnCompass").disabled = true; };
$("btnHuntReset").onclick = () => hunt.reset();
$("btnHuntVideo").onclick = () => goVideo(huntMhz);

// ---- video -----------------------------------------------------------------------------------------
let autoRun = 0, waiter = null;
function onText(t) {
  log(t);
  const on = /^video on .*gain (\d+),.*\(peak (\d+)\)/m.exec(t);
  if (on && waiter) { const w = waiter; waiter = null; w({ gain: +on[1], peak: +on[2] }); }
  if (waiter && /^video (<|: )/m.test(t)) { const w = waiter; waiter = null; w(null); }
  if (/^video: /m.test(t) && !/not running/.test(t)) overlay("Płytka nie uruchomiła wideo: " + t.trim().replace(/^video: /, ""));
}
function overlay(t) { $("vidOverlay").textContent = t; $("vidOverlay").hidden = !t; }
function videoCmd(mhz, gain) {
  return `video ${mhz} ${gain} ${cfg.vidPx} 900 auto ${cfg.vidGate ? 1 : 0}`;
}
function waitVideoOn(ms) {
  return new Promise(res => {
    waiter = res;
    setTimeout(() => { if (waiter === res) { waiter = null; res(null); } }, ms);
  });
}

// Automatic gain, as AWL's video page: the C5 reports the signal level ("peak",
// 10-bit sample units, 514 = clipped) when the video starts; aim for ~50.
const AUTO = { target: 50, lo: 25, hi: 120, clip: 400, dbPerStep: 0.8, tries: 6 };
function nextGain(g, peak) {
  if (peak >= AUTO.clip) return g - 15;
  if (peak < 4) return g + 15;
  const steps = Math.round(20 * Math.log10(AUTO.target / peak) / AUTO.dbPerStep);
  return g + Math.max(-12, Math.min(12, steps));
}
async function autoGain(mhz, run) {
  const tried = new Map();
  let g = cfg.vidGains[bucket(mhz)] ?? vidGain, last = null;
  for (let k = 0; k < AUTO.tries; k++) {
    overlay(`Dobieram wzmocnienie na ${mhz} MHz… próba ${k + 1}: ${g}`);
    const wait = waitVideoOn(4000);   // listen first: the reply can come at once
    link.send(videoCmd(mhz, g));
    const r = await wait;
    if (run !== autoRun) return null;
    if (!r) { overlay("Płytka nie odpowiada. Sprawdź połączenie."); return null; }
    tried.set(g, r.peak);
    last = g;
    if (r.peak >= AUTO.lo && r.peak <= AUTO.hi) break;
    const n = Math.max(0, Math.min(89, nextGain(g, r.peak)));
    if (tried.has(n) || n === g) break;
    g = n;
  }
  const dist = pk => Math.abs(Math.log(Math.max(pk, 1) / AUTO.target)) + (pk >= AUTO.clip ? 100 : 0);
  let best = last;
  for (const [gg, pk] of tried) if (dist(pk) < dist(tried.get(best))) best = gg;
  if (best !== last) {
    const wait = waitVideoOn(4000);
    link.send(videoCmd(mhz, best));
    await wait;
    if (run !== autoRun) return null;
  }
  return best;
}

async function startVideo(mhz) {
  mhz = Math.max(VID_MIN, Math.min(VID_MAX, Math.round(mhz)));
  vidMhz = mhz;
  const run = ++autoRun;
  video.clearStats();
  video.state = 0;
  video.blank();
  $("vidFreq").textContent = mhz;
  if (!link.connected) { overlay("Najpierw połącz płytkę."); return; }
  if (cfg.vidAutoGain) {
    const g = await autoGain(mhz, run);
    if (g == null) return;
    vidGain = g;
  } else {
    vidGain = cfg.vidGains[bucket(mhz)] ?? vidGain;
    overlay(`Strojenie na ${mhz} MHz…`);
    link.send(videoCmd(mhz, vidGain));
  }
  $("vidGain").textContent = vidGain;
  overlay(`${mhz} MHz, wzmocnienie ${vidGain}: czekam na synchronizację…`);
  const t0 = performance.now();
  while (performance.now() - t0 < 3000 && !video.locked()) await new Promise(r => setTimeout(r, 100));
  if (run !== autoRun) return;
  if (video.locked()) {
    overlay("");
    cfg.vidGains[bucket(mhz)] = vidGain; store.set("vidGains", cfg.vidGains);
    confirmed.set(bucket(mhz), video.ntsc ? "NTSC" : "PAL");
  } else {
    overlay(`Brak obrazu na ${mhz} MHz. Spróbuj ±1–2 MHz, innego wzmocnienia albo innego sygnału.`);
  }
}
function goVideo(mhz) {
  if (mhz == null) { notice("Najpierw dotknij sygnału na waterfallu."); return; }
  vidMhz = Math.round(mhz);
  showView("video", false);
  startVideo(vidMhz);
}
for (const b of document.querySelectorAll("[data-vf]")) b.onclick = () => { if (vidMhz) { setAuto(false); startVideo(vidMhz + +b.dataset.vf); } };
for (const b of document.querySelectorAll("[data-vg]")) b.onclick = () => {
  if (!vidMhz) return;
  $("vidAutoGain").checked = false; cfg.vidAutoGain = false; store.set("vidAutoGain", false);
  vidGain = Math.max(0, Math.min(89, vidGain + +b.dataset.vg));
  $("vidGain").textContent = vidGain;
  autoRun++;
  link.send(videoCmd(vidMhz, vidGain));
  cfg.vidGains[bucket(vidMhz)] = vidGain; store.set("vidGains", cfg.vidGains);
};
$("vidAutoGain").checked = cfg.vidAutoGain;
$("vidAutoGain").onchange = () => { cfg.vidAutoGain = $("vidAutoGain").checked; store.set("vidAutoGain", cfg.vidAutoGain); };
$("vidPx").value = String(cfg.vidPx);
$("vidPx").onchange = () => { cfg.vidPx = +$("vidPx").value; store.set("vidPx", cfg.vidPx); if (vidMhz && view === "video") startVideo(vidMhz); };
$("vidGate").checked = cfg.vidGate;
$("vidGate").onchange = () => { cfg.vidGate = video.gate = $("vidGate").checked; store.set("vidGate", cfg.vidGate); if (vidMhz && view === "video") startVideo(vidMhz); };
$("btnBack").onclick = () => { setAuto(false); autoRun++; showView("wf"); };
$("btnSnap").onclick = () => video.snapshot(`fpv-${vidMhz}MHz-${stamp()}`);
let stopRec = null;
$("btnRec").onclick = () => {
  if (stopRec) { stopRec(); stopRec = null; $("btnRec").textContent = "Nagraj"; $("recDot").hidden = true; return; }
  stopRec = video.record(`fpv-${vidMhz}MHz-${stamp()}`);
  $("btnRec").textContent = "Stop"; $("recDot").hidden = false;
};
$("btnFull").onclick = () => {
  const s = $("screen");
  if (document.fullscreenElement) document.exitFullscreen();
  else s.requestFullscreen?.().then(() => screen.orientation?.lock?.("landscape").catch(() => {})).catch(() => {});
};
function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }

// ---- AUTO: scan, pick an analog-looking signal, try the video, stay while it locks ----------------
const auto = { on: false, phase: "scan", t: 0, cand: null, lostAt: 0, cool: new Map() };
function setAuto(on) {
  auto.on = on;
  $("btnAuto").classList.toggle("on", on);
  if (on) { auto.phase = "scan"; auto.t = performance.now(); showView("wf"); notice("AUTO: szukam sygnału analogowego…"); }
  else if ($("notice").textContent.startsWith("AUTO")) notice("");
}
$("btnAuto").onclick = () => setAuto(!auto.on);
function autoTick() {
  if (!auto.on || !link.connected) return;
  const now = performance.now();
  if (auto.phase === "scan") {
    if (now - auto.t < 3000) return;
    const c = det.list().find(t => (t.confirmed || t.cls === "analog") && t.duty > 0.7 && t.age > 2 &&
      (auto.cool.get(bucket(t.mhz)) ?? 0) < now);
    if (!c) return;
    auto.cand = Math.round(c.mhz);
    auto.phase = "probe";
    auto.t = now;
    notice(`AUTO: sprawdzam ${auto.cand} MHz…`);
    goVideo(auto.cand);
  } else if (auto.phase === "probe") {
    if (video.locked()) { auto.phase = "watch"; auto.lostAt = 0; notice(`AUTO: obraz na ${vidMhz} MHz.`); }
    else if (now - auto.t > 12000) {
      auto.cool.set(bucket(auto.cand), now + 60000);
      auto.phase = "scan"; auto.t = now; autoRun++;
      notice("AUTO: brak obrazu, szukam dalej…");
      showView("wf");
    }
  } else if (auto.phase === "watch") {
    if (video.locked()) auto.lostAt = 0;
    else if (!auto.lostAt) auto.lostAt = now;
    else if (now - auto.lostAt > 5000) {
      auto.phase = "scan"; auto.t = now; autoRun++;
      notice("AUTO: sygnał zniknął, szukam dalej…");
      showView("wf");
    }
  }
}

// ---- status lines ---------------------------------------------------------------------------------
let lastStat = performance.now();
setInterval(() => {
  const now = performance.now(), dt = (now - lastStat) / 1000;
  lastStat = now;
  autoTick();
  if (view === "wf") {
    renderCands();
    updateCursorBar();
    $("wfStat").textContent = wf.key ? `${(wfLines / dt).toFixed(0)} linii/s · przemiatanie ${(wf.sweepUs / 1000).toFixed(1)} ms · szum ${wf.floor.toFixed(0)} dB` : "";
  }
  wfLines = 0;
  if (view === "hunt") {
    const e = hunt.excess;
    $("huntDb").textContent = Number.isFinite(e) ? (e >= 0 ? "+" : "") + e.toFixed(1) : "—";
    $("huntDb").style.color = hunt.clipped ? "var(--bad)" : e > 10 ? "var(--accent)" : "";
    $("huntSub").textContent = hunt.clipped ? "PRZESTER — zmniejsz wzmocnienie" :
      `dB nad szumem · poziom ${Number.isFinite(hunt.db) ? hunt.db.toFixed(1) : "—"} dB` + (hunt.heading != null ? ` · kierunek ${hunt.heading.toFixed(0)}°` : "");
    $("huntBest").textContent = hunt.best ? `Najlepiej: +${hunt.best.excess.toFixed(1)} dB` + (hunt.best.heading != null ? ` przy ${hunt.best.heading.toFixed(0)}°` : "") : "";
  }
  if (view === "video") {
    const s = video.stats, live = video.live();
    const lock = !live ? "brak danych" : video.frameLocked() ? "obraz zsynchronizowany" : video.locked() ? "linie, szukam ramki" : "brak synchronizacji";
    $("vidHud").textContent = vidMhz ? `${vidMhz} MHz ${channelName(vidMhz)}  gain ${vidGain}  ${video.ntsc ? "NTSC" : "PAL"}\n${lock}\n` +
      `${(s.lines / dt).toFixed(0)} linii/s  ${(s.bytes / 1024 / dt).toFixed(0)} kB/s  zgubione ${s.lost}  pominięte ${Math.round(s.gap / 40e6 / dt * 100)}%` : "";
    s.lines = 0; s.bytes = 0; s.gap = 0;
  }
}, 500);

// ---- menu ----------------------------------------------------------------------------------------
$("btnMenu").onclick = () => {
  $("linkInfo").textContent = demo ? "Tryb demo (dane symulowane)." :
    `Połączenie: ${link.kind || "—"}. Błędy CRC: ${link.parser.crcErrors}.` + (linkSupport() ? " " + linkSupport() : "");
  $("log").textContent = logLines.join("\n");
  $("menu").showModal();
  $("log").scrollTop = 1e9;
};
for (const b of document.querySelectorAll("[data-cmd]")) b.onclick = () => link.send(b.dataset.cmd);
$("cmdForm").onsubmit = e => { e.preventDefault(); const v = $("cmdIn").value.trim(); if (v) { log("> " + v); link.send(v); $("cmdIn").value = ""; } };

// ---- keep the screen on, offline cache --------------------------------------------------------------
let lock = null;
async function wakeLock() {
  try { if (!lock && navigator.wakeLock) { lock = await navigator.wakeLock.request("screen"); lock.onrelease = () => { lock = null; }; } } catch { /* */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && link.connected) wakeLock(); });
if ("serviceWorker" in navigator && !demo && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

// ---- start ---------------------------------------------------------------------------------------------
setDot();
if (demo) link.connect();
else {
  const why = linkSupport();
  if (why) notice(why);
  else link.connect(false).catch(() => {});   // a board allowed before connects without a tap
}
