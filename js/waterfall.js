// Spectrum (top) and waterfall (below) from the C5's 'W' lines.
// Tap = put the cursor there ("tap" event), press and hold = "hold" event.
import { allChannels, levelDb } from "./proto.js";

// Dark blue -> cyan -> yellow -> red -> white, like most SDR waterfalls.
const STOPS = [[0, 0, 0, 12], [0.2, 10, 20, 110], [0.4, 0, 150, 200], [0.6, 240, 230, 40], [0.8, 240, 70, 20], [1, 255, 255, 255]];
export const LUT = (() => {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++;
    const [x0, r0, g0, b0] = STOPS[k], [x1, r1, g1, b1] = STOPS[k + 1], f = (x - x0) / (x1 - x0);
    t[3 * i] = r0 + (r1 - r0) * f; t[3 * i + 1] = g0 + (g1 - g0) * f; t[3 * i + 2] = b0 + (b1 - b0) * f;
  }
  return t;
})();

export class Waterfall extends EventTarget {
  constructor(spec, wf) {
    super();
    this.spec = spec; this.wf = wf;
    this.sctx = spec.getContext("2d");
    this.wctx = wf.getContext("2d", { willReadFrequently: false });
    this.rows = 300;
    this.key = "";
    this.rangeDb = 40;       // colour span above the floor
    this.floor = NaN;        // dB, EMA of the 20th percentile
    this.usePeak = false;    // colour by the line's peak instead of its mean
    this.cursor = null;      // MHz
    this.marks = [];         // detector tracks to outline: {mhz, width, label, cls}
    this.dirty = true;
    this.lines = 0;
    this.bindPointer(spec);
    this.bindPointer(wf);
    const loop = () => { if (this.dirty) this.drawSpectrum(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  get startMhz() { return this.startKhz / 1000; }
  get stopMhz() { return (this.startKhz + (this.count - 1) * this.stepHz / 1000) / 1000; }
  mhzAt(frac) { return this.startMhz + frac * (this.stopMhz - this.startMhz); }
  fracOf(mhz) { return (mhz - this.startMhz) / (this.stopMhz - this.startMhz); }
  binOf(mhz) { return Math.round((mhz * 1000 - this.startKhz) / (this.stepHz / 1000)); }

  reset() {
    this.key = "";
    this.hold = null;
    this.floor = NaN;
    this.dirty = true;
  }
  clearPeaks() { if (this.hold) this.hold.fill(-1e9); this.dirty = true; }

  push(l) {
    const key = `${l.startKhz}/${l.stepHz}/${l.count}`;
    if (key !== this.key) {
      this.key = key;
      this.startKhz = l.startKhz; this.stepHz = l.stepHz; this.count = l.count;
      this.mean = new Float32Array(l.count); this.peak = new Float32Array(l.count);
      this.hold = new Float32Array(l.count).fill(-1e9);
      this.wf.width = l.count; this.wf.height = this.rows;
      this.wctx.fillStyle = "#00000c"; this.wctx.fillRect(0, 0, l.count, this.rows);
      this.row = this.wctx.createImageData(l.count, 1);
      this.floor = NaN;
      this.dispatchEvent(new Event("range"));
    }
    for (let j = 0; j < l.count; j++) {
      this.mean[j] = levelDb(l.mean[j]);
      this.peak[j] = levelDb(l.peak[j]);
      if (this.peak[j] > this.hold[j]) this.hold[j] = this.peak[j];
    }
    // floor: 20th percentile of this line, smoothed
    const s = Array.from(this.mean).sort((a, b) => a - b), p20 = s[Math.floor(s.length * 0.2)];
    this.floor = Number.isFinite(this.floor) ? this.floor + 0.1 * (p20 - this.floor) : p20;
    this.clipped = (l.flags & 1) !== 0;
    this.gain = l.gain;
    this.sweepUs = l.sweepUs;
    this.lines++;
    this.paintRow(this.usePeak ? this.peak : this.mean);
    this.dirty = true;
  }

  paintRow(v) {
    const w = this.count, ctx = this.wctx, d = this.row.data, lo = this.floor - 3, k = 255 / this.rangeDb;
    ctx.drawImage(this.wf, 0, 0, w, this.rows - 1, 0, 1, w, this.rows - 1);
    for (let j = 0; j < w; j++) {
      let i = Math.round((v[j] - lo) * k);
      i = i < 0 ? 0 : i > 255 ? 255 : i;
      d[4 * j] = LUT[3 * i]; d[4 * j + 1] = LUT[3 * i + 1]; d[4 * j + 2] = LUT[3 * i + 2]; d[4 * j + 3] = 255;
    }
    ctx.putImageData(this.row, 0, 0);
  }

  // ---- spectrum -----------------------------------------------------------------
  drawSpectrum() {
    this.dirty = false;
    const c = this.spec, dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = this.sctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#0b0f14"; g.fillRect(0, 0, W, H);
    if (!this.key) {
      g.fillStyle = "#7d8b99"; g.font = `${14 * dpr}px system-ui`;
      g.fillText("Brak danych z odbiornika", 12 * dpr, H / 2);
      return;
    }
    const axisH = 18 * dpr, plotH = H - axisH;
    const top = this.floor + this.rangeDb + 5, bot = this.floor - 5;
    const y = db => plotH - ((db - bot) / (top - bot)) * plotH;
    const x = j => (j + 0.5) / this.count * W;
    const span = this.stopMhz - this.startMhz;
    g.font = `${11 * dpr}px system-ui`;
    // dB grid every 10 dB over the floor
    g.strokeStyle = "#1c2630"; g.fillStyle = "#56636f"; g.lineWidth = 1;
    for (let k = 0; k <= this.rangeDb; k += 10) {
      const yy = Math.round(y(this.floor + k)) + 0.5;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
      g.fillText(`+${k}`, 3 * dpr, yy - 2 * dpr);
    }
    // channel ticks (only when they fit)
    if (span <= 400) {
      g.strokeStyle = "#26323d";
      for (const ch of allChannels()) {
        if (ch.mhz < this.startMhz || ch.mhz > this.stopMhz || ch.band === "L" && span > 120) continue;
        const xx = Math.round(this.fracOf(ch.mhz) * W) + 0.5;
        g.beginPath(); g.moveTo(xx, plotH - 6 * dpr); g.lineTo(xx, plotH); g.stroke();
      }
    }
    // frequency axis
    const stepMhz = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 10 : 5;
    g.fillStyle = "#8b99a6"; g.textAlign = "center";
    for (let f = Math.ceil(this.startMhz / stepMhz) * stepMhz; f <= this.stopMhz; f += stepMhz) {
      const xx = this.fracOf(f) * W, half = g.measureText(String(f)).width / 2;
      g.fillRect(Math.round(xx), plotH, 1, 4 * dpr);
      g.fillText(String(f), Math.min(W - half, Math.max(half, xx)), H - 4 * dpr);
    }
    g.textAlign = "left";
    // detector marks
    const marks = [...this.marks].sort((a, b) => a.mhz - b.mhz);
    let rowEnd = [-1e9, -1e9];   // labels go on two rows so neighbours don't overprint
    for (const m of marks) {
      const x0 = this.fracOf(m.mhz - m.width / 2) * W, x1 = this.fracOf(m.mhz + m.width / 2) * W;
      g.fillStyle = m.cls === "analog" ? "rgba(255,90,60,0.18)" : "rgba(120,160,255,0.12)";
      g.fillRect(x0, 0, Math.max(2, x1 - x0), plotH);
      const tw = g.measureText(m.label).width, lx = Math.min(W - tw - 2, Math.max(2, x0));
      const r = lx > rowEnd[0] ? 0 : lx > rowEnd[1] ? 1 : -1;
      if (r < 0) continue;
      rowEnd[r] = lx + tw + 6 * dpr;
      g.fillStyle = m.cls === "analog" ? "#ff8a70" : "#9fb4ff";
      g.fillText(m.label, lx, (12 + 14 * r) * dpr);
    }
    // peak hold, peak, mean
    const line = (arr, color, width) => {
      g.strokeStyle = color; g.lineWidth = width * dpr; g.beginPath();
      for (let j = 0; j < this.count; j++) { const yy = y(arr[j]); j ? g.lineTo(x(j), yy) : g.moveTo(x(j), yy); }
      g.stroke();
    };
    line(this.hold, "rgba(231,175,80,0.45)", 1);
    line(this.peak, "rgba(231,175,80,0.9)", 1);
    line(this.mean, "#38d26b", 1.5);
    // floor
    g.strokeStyle = "rgba(255,255,255,0.25)"; g.setLineDash([4 * dpr, 4 * dpr]);
    g.beginPath(); g.moveTo(0, y(this.floor)); g.lineTo(W, y(this.floor)); g.stroke(); g.setLineDash([]);
    // cursor
    if (this.cursor != null) {
      const xx = this.fracOf(this.cursor) * W;
      g.strokeStyle = "#ffffff"; g.lineWidth = 1.5 * dpr;
      g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.stroke();
    }
    if (this.clipped) {
      g.fillStyle = "#ff5a3c"; g.textAlign = "right";
      g.fillText("PRZESTER — zmniejsz wzmocnienie", W - 4 * dpr, 12 * dpr);
      g.textAlign = "left";
    }
  }

  // level at a frequency (mean, dB over the floor)
  levelAt(mhz) {
    if (!this.key) return NaN;
    const j = this.binOf(mhz);
    return j >= 0 && j < this.count ? this.mean[j] - this.floor : NaN;
  }

  // ---- touch -----------------------------------------------------------------------
  bindPointer(el) {
    let down = null, timer = 0;
    const at = e => {
      const r = el.getBoundingClientRect();
      return this.mhzAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    };
    el.addEventListener("pointerdown", e => {
      if (!this.key) return;
      down = { x: e.clientX, y: e.clientY, mhz: at(e) };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!down) return;
        this.dispatchEvent(new CustomEvent("hold", { detail: { mhz: down.mhz } }));
        down = null;
      }, 650);
    });
    el.addEventListener("pointermove", e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) { down = null; clearTimeout(timer); }
    });
    el.addEventListener("pointerup", () => {
      clearTimeout(timer);
      if (!down) return;
      this.dispatchEvent(new CustomEvent("tap", { detail: { mhz: down.mhz } }));
      down = null;
    });
    el.addEventListener("pointercancel", () => { down = null; clearTimeout(timer); });
  }
}
