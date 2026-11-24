// Demo receiver: the same API as Link, but frames are made up in the browser.
// Open the app with ?demo to try the screens without the C5.
// Simulated: an analog VTX on R5 (5806 MHz) that drifts in strength, a
// digital-looking flat signal at 5755 MHz, bursty Wi-Fi at 5670 MHz.
import { FrameParser, encodeFrame, BANDS } from "./proto.js";

const enc = new TextEncoder();

export class DemoLink extends EventTarget {
  constructor() {
    super();
    this.kind = "demo";
    this.connected = false;
    this.parser = new FrameParser((type, payload) => this.dispatchEvent(new CustomEvent("frame", { detail: { type, payload } })));
    this.mode = "idle";
    this.timer = 0;
    this.seq = 0;
    this.t0 = performance.now();
  }
  async connect() {
    this.connected = true;
    this.dispatchEvent(new CustomEvent("state", { detail: "connected" }));
    return true;
  }
  async disconnect() {
    this.stop();
    this.connected = false;
    this.dispatchEvent(new CustomEvent("state", { detail: "disconnected" }));
  }
  emit(type, payload) { this.parser.push(encodeFrame(type, payload)); }
  say(text) { this.emit("T", enc.encode(text)); }
  stop() { clearInterval(this.timer); this.timer = 0; this.mode = "idle"; }

  send(line) {
    const [cmd, ...a] = line.trim().split(/\s+/);
    if (cmd === "hello" || cmd === "status") return this.say("demo receiver ready\nradio ok\n");
    if (cmd === "gain") { this.gain = +a[0]; return this.say(`gain ${a[0]}\n`); }
    if (cmd === "stop") { this.stop(); return this.say("idle\n"); }
    if (cmd === "sweep") {
      if (a[0] === "stop") { this.stop(); return; }
      this.stop();
      this.sw = { start: +a[0] || 5600, stop: +a[1] || 5950, fine: a.includes("fine") };
      this.mode = "sweep";
      this.timer = setInterval(() => this.sweepLine(), 40);
      return this.say(`sweep on: ${this.sw.start}-${this.sw.stop} MHz\n`);
    }
    if (cmd === "track") {
      this.stop();
      this.trackMhz = +a[0];
      this.mode = "track";
      this.timer = setInterval(() => this.trackRec(), 20);
      return this.say(`track ${a[0]} MHz\n`);
    }
    if (cmd === "video") {
      if (a[0] === "stop" || !a.length) { this.stop(); return this.say("video off (stop)\n"); }
      this.stop();
      let mhz = +a[0];
      const m = /^([RABEFL])([1-8])$/i.exec(a[0]);
      if (m) mhz = BANDS[m[1].toUpperCase()][+m[2] - 1];
      const gain = +(a[1] ?? 30), px = +(a[2] ?? 128);
      this.vid = { mhz, gain, px, gate: a[5] !== "0", half: a[5] === "2", color: a[6] === "1", t0: performance.now(), seq: 0 };
      const peak = Math.round(Math.min(514, 38 * Math.pow(10, (gain - 30) * 0.8 / 20)));
      this.mode = "video";
      this.say(`video on ${mhz} MHz (LO ${mhz - 2}), gain ${gain}, px ${px}, 900 kB/s, window lsb 3 (peak ${peak}), DC 0/0 -> 0/0 in 0 steps\n`);
      this.timer = setInterval(() => this.videoTick(), 17);
      return;
    }
    this.say(`unknown command '${cmd}' (demo)\n`);
  }

  // ---- sweep -----------------------------------------------------------------------
  level(mhz, t) {
    let p = 0;   // linear power over the floor
    const drone = 32 + 6 * Math.sin(t / 3);
    const dd = mhz - 5806;   // analog FM video: a hump, highest near the carrier
    if (Math.abs(dd) < 10) p += Math.pow(10, (drone - 1.6 * Math.abs(dd) + 2 * Math.random()) / 10);
    if (Math.abs(mhz - 5755) < 9) p += Math.pow(10, (22 + Math.random()) / 10);   // digital: flat block
    if (Math.abs(mhz - 5670) < 9 && this.wifiOn) p += Math.pow(10, 25 / 10);       // Wi-Fi: bursts
    const noise = Math.pow(10, (72 + 2.5 * (Math.random() + Math.random() - 1)) / 10);
    return 10 * Math.log10(noise + p * Math.pow(10, 72 / 10));
  }
  sweepLine() {
    const { start, stop, fine } = this.sw, step = fine ? 312500 : 1000000;
    const count = Math.floor((stop - start) * 1e6 / step) + 1, t = (performance.now() - this.t0) / 1000;
    this.wifiOn = Math.random() < 0.35;
    const p = new Uint8Array(24 + 2 * count), dv = new DataView(p.buffer);
    dv.setUint16(0, this.seq++ & 0xFFFF, true); dv.setUint16(2, count, true);
    dv.setUint32(4, start * 1000, true); dv.setUint32(8, step, true);
    p[12] = this.gain ?? 40; p[13] = 4; p[14] = fine ? 2 : 0; dv.setUint32(16, 9000, true);
    const b = db => Math.max(0, Math.min(255, Math.round((db - 40) * 2)));
    for (let j = 0; j < count; j++) {
      const f = start + j * step / 1e6, m = this.level(f, t), pk = Math.max(m, this.level(f, t) + 3);
      p[24 + j] = b(m); p[24 + count + j] = b(pk);
    }
    this.emit("W", p);
  }

  // ---- track -----------------------------------------------------------------------
  trackRec() {
    const t = (performance.now() - this.t0) / 1000;
    const near = Math.max(0, 1 - Math.abs(this.trackMhz - 5806) / 12);
    const aim = 0.5 + 0.5 * Math.cos(t * 0.7);   // as if the antenna swings across the drone
    const db = -3 + near * 30 * aim * aim + Math.random() * 0.6;
    const p = new Uint8Array(26), dv = new DataView(p.buffer);
    dv.setUint16(0, this.seq++ & 0xFFFF, true); p[2] = 1; dv.setUint32(8, 20000, true);
    dv.setUint32(12, (t * 1e6) >>> 0, true); dv.setInt16(16, Math.round(db * 100), true); dv.setInt16(18, Math.round(db * 100), true);
    dv.setUint16(20, this.trackMhz, true); p[22] = this.gain ?? 40; p[25] = 200;
    this.emit("R", p);
  }

  // ---- video -----------------------------------------------------------------------
  videoTick() {
    const v = this.vid, el = (performance.now() - v.t0) / 1000, onDrone = Math.abs(v.mhz - 5806) <= 4;
    const locked = onDrone && el > 0.6, state = locked ? (el > 1 ? 3 : 1) : 0;
    const lines = [], colour = [];
    if (locked) {
      // NTSC-like timing at 50 ticks/s: one field per tick. Field 1 only with "fields" (even lines one frame,
      // odd lines the next), else both fields.
      v.field = (v.field ?? 0) + 1;
      const f1 = (v.field & 1) === 0, frame = v.field >> 1;
      this.pattern = frame;
      if (f1 || !v.gate) {
        for (let ln = 23; ln <= 310; ln++) {
          if (v.half && (ln & 1)) continue;
          const l = f1 ? ln : ln + 313;
          lines.push([l, 8 | (f1 ? 0 : 2), v.field & 255]);
        }
      }
      for (let ln = 23; ln <= 310; ln += 8) colour.push(f1 ? ln : ln + 313);
    }
    const px = v.px, rec = 8 + px, per = Math.floor((1100 - 16) / rec);
    for (let i = 0; i < Math.max(1, lines.length); i += per) {
      const chunk = lines.slice(i, i + per), p = new Uint8Array(16 + chunk.length * rec), dv = new DataView(p.buffer);
      dv.setUint16(0, v.seq++ & 0xFFFF, true); p[2] = chunk.length; p[3] = state; dv.setUint16(4, px, true); dv.setUint16(6, v.mhz, true);
      dv.setInt16(8, -2800, true); dv.setInt16(10, -1500, true);
      chunk.forEach(([ln, flags, fc], k) => {
        const o = 16 + k * rec, row = ln > 312 ? ln - 336 : ln - 23;
        p[o] = ln & 255; p[o + 1] = ln >> 8; p[o + 2] = flags; p[o + 3] = fc;
        for (let x = 0; x < px; x++) p[o + 8 + x] = this.pixel(x / px, row / 288, this.pattern);
      });
      this.emit("V", p);
    }
    if (v.color && colour.length) {
      const nseg = 32, rec = 10 + 2 * nseg, p = new Uint8Array(4 + colour.length * rec);
      p[2] = colour.length; p[3] = nseg;
      colour.forEach((ln, k) => {
        const o = 4 + k * rec, row = (ln > 312 ? ln - 336 : ln - 23) / 288, sky = row < 0.45 + 0.05 * Math.sin(this.pattern / 20);
        p[o] = ln & 255; p[o + 1] = ln >> 8; p[o + 2] = 8 | (ln > 312 ? 16 : 0); p[o + 3] = 20;
        for (let j = 0; j < nseg; j++) {
          p[o + 10 + 2 * j] = sky ? 30 : (-25 & 255);        // U: blue sky / green ground
          p[o + 11 + 2 * j] = sky ? (-15 & 255) : (-30 & 255);
        }
      });
      this.emit("U", p);
    }
  }
  pixel(x, y, f) {
    // sky, horizon, ground; a moving "OSD" bar; noise
    let v = y < 0.45 + 0.05 * Math.sin(f / 20) ? 150 + 40 * y : 95 + 30 * Math.sin(x * 30 + f / 4);
    if (Math.abs(x - ((f % 100) / 100)) < 0.02) v = 213;
    if (y > 0.88 && y < 0.92 && x > 0.1 && x < 0.1 + 0.3 * (0.5 + 0.5 * Math.sin(f / 10))) v = 213;
    return Math.max(64, Math.min(213, v + 12 * (Math.random() - 0.5)));
  }
}
