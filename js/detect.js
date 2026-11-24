// Finds and classifies signals in the waterfall lines.
//
// Starting thresholds, to be tuned in the field. Classification is from the
// spectrum's shape only; "analog" is confirmed for real when the video
// demodulator locks onto the line sync (app.js sets track.confirmed).
import { channelName, levelDb } from "./proto.js";

const HIST = 50;          // lines of history for the duty cycle (~2 s at 25 lines/s)
const THRESH_DB = 6;      // over the floor
const MIN_WIDTH_MHZ = 3;
const MATCH_MHZ = 4;
const FORGET_MS = 10000;

export class Detector {
  constructor() { this.reset(); }
  reset() { this.tracks = []; this.key = ""; this.nextId = 1; this.floor = NaN; }

  push(l) {
    const key = `${l.startKhz}/${l.stepHz}/${l.count}`;
    if (key !== this.key) { this.reset(); this.key = key; }
    const n = l.count, stepMhz = l.stepHz / 1e6, startMhz = l.startKhz / 1000;
    const db = new Float32Array(n);
    for (let j = 0; j < n; j++) db[j] = levelDb(l.mean[j]);
    const s = Array.from(db).sort((a, b) => a - b), p20 = s[Math.floor(n * 0.2)];
    this.floor = Number.isFinite(this.floor) ? this.floor + 0.1 * (p20 - this.floor) : p20;
    // smoothed excess over the floor (3 bins)
    const ex = new Float32Array(n);
    for (let j = 0; j < n; j++) ex[j] = ((db[j - 1] ?? db[j]) + db[j] + (db[j + 1] ?? db[j])) / 3 - this.floor;
    // runs above the threshold; gaps up to 1 MHz bridged
    const gap = Math.max(1, Math.round(1 / stepMhz)), runs = [];
    let a = -1, lastHit = -10;
    for (let j = 0; j <= n; j++) {
      const hit = j < n && ex[j] > THRESH_DB;
      if (hit) { if (a < 0 || j - lastHit > gap) { if (a >= 0) runs.push([a, lastHit]); a = j; } lastHit = j; }
    }
    if (a >= 0) runs.push([a, lastHit]);
    const now = performance.now(), seen = new Set();
    for (const [j0, j1] of runs) {
      const width = (j1 - j0 + 1) * stepMhz;
      if (width < MIN_WIDTH_MHZ) continue;
      let wsum = 0, fsum = 0, mx = -1e9;
      for (let j = j0; j <= j1; j++) {
        const w = Math.pow(10, ex[j] / 10);
        wsum += w; fsum += w * (startMhz + j * stepMhz);
        if (ex[j] > mx) mx = ex[j];
      }
      const centre = fsum / wsum;
      // flat top: share of the run within 3 dB of its maximum. OFDM (digital
      // video, Wi-Fi) is a flat block with steep sides; analog FM video is a hump.
      let near = 0;
      for (let j = j0; j <= j1; j++) if (ex[j] > mx - 3) near++;
      const flat = near / (j1 - j0 + 1);
      let t = this.tracks.find(t => !seen.has(t) && Math.abs(t.mhz - centre) < MATCH_MHZ);
      if (!t) {
        t = { id: this.nextId++, mhz: centre, width, excess: mx, flat, hist: [], first: now, confirmed: "" };
        this.tracks.push(t);
      }
      seen.add(t);
      t.mhz += 0.3 * (centre - t.mhz);
      t.width += 0.3 * (width - t.width);
      t.excess += 0.3 * (mx - t.excess);
      t.flat += 0.3 * (flat - t.flat);
      t.last = now;
    }
    for (const t of this.tracks) {
      t.hist.push(seen.has(t) ? 1 : 0);
      if (t.hist.length > HIST) t.hist.shift();
      t.duty = t.hist.reduce((x, y) => x + y, 0) / t.hist.length;
      t.age = (now - t.first) / 1000;
      t.cls = classify(t);
      t.label = label(t);
    }
    this.tracks = this.tracks.filter(t => now - t.last < FORGET_MS);
  }

  // strongest first; analog (confirmed, then suspected) before the rest
  list() {
    const rank = t => (t.confirmed ? 3 : t.cls === "analog" ? 2 : t.cls === "digital" ? 1 : 0);
    return this.tracks.filter(t => t.hist.length >= 5).sort((a, b) => rank(b) - rank(a) || b.excess - a.excess);
  }
}

function onWifiGrid(mhz) {
  const k = Math.round((mhz - 5180) / 20);
  return Math.abs(mhz - (5180 + 20 * k)) <= 3 || Math.abs(mhz - (5190 + 20 * k)) <= 3;
}

function classify(t) {
  if (t.duty < 0.6) return onWifiGrid(t.mhz) || t.width >= 15 ? "wifi" : "burst";
  if (t.width >= 26) return "digital";
  if (t.flat > 0.55 && t.width >= 8) return onWifiGrid(t.mhz) && t.duty < 0.9 ? "wifi" : "digital";
  if (t.width >= 5 && t.width <= 24) return "analog";
  return "other";
}

const NAMES = { analog: "analog?", digital: "cyfrowy?", wifi: "Wi-Fi?", burst: "impulsy", other: "?" };
function label(t) {
  const ch = channelName(Math.round(t.mhz), 3);
  const cls = t.confirmed ? `analog ${t.confirmed}` : NAMES[t.cls];
  return `${Math.round(t.mhz)}${ch ? " " + ch : ""} · ${cls}`;
}
