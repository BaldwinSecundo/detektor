// "Polowanie": aiming the directional antenna at one frequency.
// The C5 measures the band power around the frequency ~1000x a second
// (track mode, 'R' frames every 20 ms). Shown as a big number over the floor,
// a 15 s plot, a tone whose pitch rises with the signal, and the compass
// heading where the signal was strongest.

const KEEP_S = 15;

export class Hunt {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.hist = [];            // {t, db}
    this.floorWin = [];        // last 30 s of readings for the floor
    this.best = null;          // {excess, heading, t}
    this.heading = null;
    this.polar = new Float32Array(36).fill(-1e9);
    this.toneOn = false;
    this.audio = null;
    this.dirty = true;
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  reset() {
    this.hist = []; this.floorWin = []; this.best = null; this.polar.fill(-1e9); this.dirty = true;
  }

  push(p) {
    const t = performance.now() / 1000, db = Number.isFinite(p.raw) ? p.filt : NaN;
    if (!Number.isFinite(db)) return;
    this.mhz = p.mhz; this.gain = p.gain; this.clipped = p.clips > 0;
    this.hist.push({ t, db });
    while (this.hist.length && this.hist[0].t < t - KEEP_S) this.hist.shift();
    this.floorWin.push({ t, db });
    while (this.floorWin.length && this.floorWin[0].t < t - 30) this.floorWin.shift();
    const s = this.floorWin.map(x => x.db).sort((a, b) => a - b);
    this.floor = s[Math.floor(s.length * 0.05)];
    this.db = db;
    this.excess = db - this.floor;
    if (!this.best || this.excess > this.best.excess) this.best = { excess: this.excess, heading: this.heading, t };
    if (this.heading != null) {
      const k = Math.floor(((this.heading % 360) + 360) % 360 / 10);
      if (this.excess > this.polar[k]) this.polar[k] = this.excess;
    }
    this.updateTone();
    this.dirty = true;
  }

  // ---- tone ------------------------------------------------------------------------
  setTone(on) {
    this.toneOn = on;
    if (on && !this.audio) {
      const ac = new AudioContext(), osc = ac.createOscillator(), g = ac.createGain();
      osc.type = "triangle"; osc.frequency.value = 300; g.gain.value = 0;
      osc.connect(g).connect(ac.destination); osc.start();
      this.audio = { ac, osc, g };
    }
    if (this.audio) this.audio.ac[on ? "resume" : "suspend"]();
    this.updateTone();
  }
  updateTone() {
    if (!this.audio || !this.toneOn) return;
    const e = Math.max(0, Math.min(40, this.excess || 0)), now = this.audio.ac.currentTime;
    this.audio.osc.frequency.setTargetAtTime(200 + e * 45, now, 0.03);
    this.audio.g.gain.setTargetAtTime(e < 2 ? 0.02 : 0.15, now, 0.05);
  }

  // ---- compass ---------------------------------------------------------------------
  async enableCompass() {
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* iOS only */ }
    }
    const on = e => {
      if (e.absolute === false && e.webkitCompassHeading == null) return;
      this.heading = e.webkitCompassHeading ?? (360 - e.alpha) % 360;
      this.tilt = e.beta;
      this.dirty = true;
    };
    window.addEventListener("deviceorientationabsolute", on);
    window.addEventListener("deviceorientation", on);
  }

  // ---- drawing -----------------------------------------------------------------------
  draw() {
    this.dirty = false;
    const c = this.cv, dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = this.ctx;
    g.fillStyle = "#0b0f14"; g.fillRect(0, 0, W, H);
    const polarW = this.heading != null ? Math.min(H, W * 0.35) : 0, pw = W - polarW;
    // plot: excess over the floor, 0..40 dB, last 15 s
    const y = e => H - 6 * dpr - (Math.max(0, Math.min(40, e)) / 40) * (H - 12 * dpr);
    g.strokeStyle = "#1c2630"; g.fillStyle = "#56636f"; g.font = `${11 * dpr}px system-ui`;
    for (let k = 0; k <= 40; k += 10) {
      const yy = Math.round(y(k)) + 0.5;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(pw, yy); g.stroke();
      g.fillText(`+${k}`, 3 * dpr, yy - 2 * dpr);
    }
    if (this.hist.length > 1 && Number.isFinite(this.floor)) {
      const t1 = this.hist[this.hist.length - 1].t;
      g.strokeStyle = "#38d26b"; g.lineWidth = 2 * dpr; g.beginPath();
      this.hist.forEach((p, i) => {
        const xx = pw - ((t1 - p.t) / KEEP_S) * pw, yy = y(p.db - this.floor);
        i ? g.lineTo(xx, yy) : g.moveTo(xx, yy);
      });
      g.stroke();
      if (this.best) {
        g.strokeStyle = "rgba(231,175,80,0.8)"; g.setLineDash([5 * dpr, 4 * dpr]); g.lineWidth = 1 * dpr;
        g.beginPath(); g.moveTo(0, y(this.best.excess)); g.lineTo(pw, y(this.best.excess)); g.stroke(); g.setLineDash([]);
      }
    }
    if (polarW) this.drawPolar(g, pw + polarW / 2, H / 2, polarW * 0.42, dpr);
  }

  drawPolar(g, cx, cy, r, dpr) {
    g.strokeStyle = "#26323d"; g.lineWidth = 1;
    for (const f of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, r * f, 0, 2 * Math.PI); g.stroke(); }
    g.fillStyle = "rgba(56,210,107,0.5)"; g.beginPath();
    for (let k = 0; k <= 36; k++) {
      const e = Math.max(0, Math.min(40, this.polar[k % 36])) / 40, a = ((k % 36) * 10 + 5 - 90) * Math.PI / 180;
      const xx = cx + Math.cos(a) * r * e, yy = cy + Math.sin(a) * r * e;
      k ? g.lineTo(xx, yy) : g.moveTo(xx, yy);
    }
    g.fill();
    const a = (this.heading - 90) * Math.PI / 180;
    g.strokeStyle = "#fff"; g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
    g.fillStyle = "#8b99a6"; g.font = `${11 * dpr}px system-ui`; g.textAlign = "center";
    g.fillText("N", cx, cy - r - 4 * dpr);
    g.textAlign = "left";
  }
}
