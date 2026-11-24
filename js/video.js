// Analog FPV picture from the C5's 'V' (luma) and 'U' (colour) frames.
//
// Lines arrive with their ITU line number once the demodulator has vertical
// lock. With "fields" on, the C5 sends only field 1: even lines in one frame,
// odd lines in the next. Every received line is kept with the field it came
// in; the picture is composed from the lines that are fresh (last few fields),
// and the rows in between are interpolated from the nearest fresh rows above
// and below. That removes the staircase of repeated lines and patches lines
// the C5 dropped. Colour (optional) comes as 32 U/V pairs on every 8th line and
// is interpolated in both directions; the eye sees colour at much lower
// resolution than brightness.
import { parseVHeader, VF, VSTATE } from "./proto.js";

const FRESH_FIELDS = 4;     // a line older than this many fields is stale (2 frames: less combing on motion)
const MAX_GAP = 10;         // interpolate across at most this many rows
const CHROMA_FRESH = 12, CHROMA_GAP = 48;
const VC_WEAK = 4, VC_VLOCK = 8, VC_FIELD2 = 16, VC_NTSC = 32;

function rowOf(line, ntsc) {
  if (!ntsc) {
    if (line >= 23 && line <= 310) return 2 * (line - 23);
    if (line >= 336 && line <= 623) return 2 * (line - 336) + 1;
  } else {
    if (line >= 22 && line <= 261) return 2 * (line - 22);
    if (line >= 285 && line <= 524) return 2 * (line - 285) + 1;
  }
  return -1;
}

export class Video {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = null;
    this.gate = true;
    this.color = false;
    this.saturation = 1;
    this.hue = 0;            // degrees, rotates U/V
    this.autoBalance = true; // subtract the long-term mean U/V (removes a constant colour cast)
    this.meanU = 0; this.meanV = 0;
    this.dirty = false;
    this.fc = 0;            // field counter, unwrapped from the records' 8-bit count
    this.lastFc8 = -1;
    this.freeRow = 0;       // before vertical lock: lines are stacked as they come
    this.clearStats();
    this.state = 0;
    this.last = 0;
    const loop = () => {
      if (this.dirty && this.img) { this.compose(); this.ctx.putImageData(this.img, 0, 0); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  clearStats() { this.stats = { lines: 0, bytes: 0, lost: 0, gap: 0, frames: 0, seq: -1, clines: 0 }; }

  setup(px, ntsc) {
    const rows = ntsc ? 480 : 576;
    if (this.img && this.img.width === px && this.img.height === rows) return;
    this.cv.width = px; this.cv.height = rows; this.ntsc = ntsc; this.px = px; this.H = rows;
    this.img = this.ctx.createImageData(px, rows);
    this.luma = new Uint8Array(rows * px);
    this.stamp = new Float64Array(rows).fill(-1e9);
    this.nseg = 0;
    this.blank();
  }

  blank() {
    if (!this.img) return;
    this.luma.fill(64);
    this.stamp.fill(-1e9);
    if (this.cstamp) this.cstamp.fill(-1e9);
    this.dirty = true;
  }

  tickField(fc8) {
    if (this.lastFc8 >= 0) this.fc += (fc8 - this.lastFc8 + 256) & 255;
    this.lastFc8 = fc8;
  }

  onFrame(p) {
    const h = parseVHeader(p);
    if (!h) return;
    const s = this.stats;
    if (s.seq >= 0) { const run = ((h.seq - s.seq) & 0xFFFF) - 1; if (run > 0 && run < 1000) s.lost += run; }
    s.seq = h.seq; s.bytes += p.length; s.gap += h.gap; s.frames++;
    this.state = h.state; this.mhz = h.mhz; this.tipKhz = h.tipKhz; this.blankKhz = h.blankKhz;
    this.last = performance.now();
    this.setup(h.px, (h.state & VSTATE.NTSC) !== 0);
    const px = h.px, rec = 8 + px, H = this.H;
    for (let k = 0; k < h.n && 16 + (k + 1) * rec <= p.length; k++) {
      const o = 16 + k * rec, line = p[o] | (p[o + 1] << 8), flags = p[o + 2];
      s.lines++;
      this.tickField(p[o + 3]);
      if (flags & VF.VLOCK) {
        const r = rowOf(line, this.ntsc);
        if (r < 0) continue;
        this.luma.set(p.subarray(o + 8, o + 8 + px), r * px);
        this.stamp[r] = this.fc;
      } else {
        // line lock only: stack the lines so something shows while it locks
        const r = this.freeRow;
        this.freeRow = (this.freeRow + 1) % H;
        this.luma.set(p.subarray(o + 8, o + 8 + px), r * px);
        this.stamp[r] = this.fc;
      }
      this.dirty = true;
    }
  }

  // 'U': u16 seq, u8 n, u8 nseg, n x (10 + 2 nseg) (video/awl_video.h)
  onColor(p) {
    if (p.length < 4 || !this.img) return;
    const n = p[2], nseg = p[3], rec = 10 + 2 * nseg;
    if (nseg !== this.nseg) {
      this.nseg = nseg;
      this.cu = new Int8Array(this.H * nseg); this.cv2 = new Int8Array(this.H * nseg);
      this.cstamp = new Float64Array(this.H).fill(-1e9);
    }
    const sp = new Int8Array(p.buffer, p.byteOffset, p.byteLength);
    for (let k = 0; k < n && 4 + (k + 1) * rec <= p.length; k++) {
      const o = 4 + k * rec, line = p[o] | (p[o + 1] << 8), fl = p[o + 2];
      if (!(fl & VC_VLOCK)) continue;
      const r = rowOf(line, (fl & VC_NTSC) !== 0);
      if (r < 0 || r >= this.H) continue;
      const weak = (fl & VC_WEAK) !== 0;
      if (!weak) {   // running mean of the whole picture's colour (~2 s): a scene averages to about grey
        let su = 0, sv = 0;
        for (let j = 0; j < nseg; j++) { su += sp[o + 10 + 2 * j]; sv += sp[o + 11 + 2 * j]; }
        this.meanU += 0.002 * (su / nseg - this.meanU);
        this.meanV += 0.002 * (sv / nseg - this.meanV);
      }
      for (let j = 0; j < nseg; j++) {
        this.cu[r * nseg + j] = weak ? 0 : sp[o + 10 + 2 * j];
        this.cv2[r * nseg + j] = weak ? 0 : sp[o + 11 + 2 * j];
      }
      this.cstamp[r] = this.fc;
      this.stats.clines++;
    }
    this.dirty = true;
  }

  // nearest fresh row above / below each row (-1 = none within reach)
  static neighbours(stamp, H, now, fresh, gap) {
    const prev = new Int32Array(H), next = new Int32Array(H);
    let last = -1;
    for (let r = 0; r < H; r++) {
      if (now - stamp[r] <= fresh) last = r;
      prev[r] = last >= 0 && r - last <= gap ? last : -1;
    }
    last = -1;
    for (let r = H - 1; r >= 0; r--) {
      if (now - stamp[r] <= fresh) last = r;
      next[r] = last >= 0 && last - r <= gap ? last : -1;
    }
    return [prev, next];
  }

  compose() {
    const H = this.H, px = this.px, L = this.luma, d = this.img.data, now = this.fc;
    const [prev, next] = Video.neighbours(this.stamp, H, now, FRESH_FIELDS, MAX_GAP);
    const useColor = this.color && this.nseg > 0 && this.cstamp;
    let cprev, cnext;
    if (useColor) [cprev, cnext] = Video.neighbours(this.cstamp, H, now, CHROMA_FRESH, CHROMA_GAP);
    const nseg = this.nseg, sat = this.saturation / 149;
    const bu = this.autoBalance ? this.meanU : 0, bv = this.autoBalance ? this.meanV : 0;
    const hc = Math.cos(this.hue * Math.PI / 180), hs = Math.sin(this.hue * Math.PI / 180);
    const yRow = new Float32Array(px), uRow = new Float32Array(px), vRow = new Float32Array(px);
    for (let r = 0; r < H; r++) {
      // brightness: this row, or the blend of the nearest fresh rows, or (nothing near) whatever it last had
      const a = prev[r], b = next[r];
      if (a === r || (a < 0 && b < 0)) {
        for (let x = 0; x < px; x++) yRow[x] = L[r * px + x];
      } else if (a >= 0 && b >= 0) {
        const t = (r - a) / (b - a);
        for (let x = 0; x < px; x++) yRow[x] = L[a * px + x] * (1 - t) + L[b * px + x] * t;
      } else {
        const c = a >= 0 ? a : b;
        for (let x = 0; x < px; x++) yRow[x] = L[c * px + x];
      }
      let haveC = false;
      if (useColor) {
        const ca = cprev[r], cb = cnext[r];
        if (ca >= 0 || cb >= 0) {
          haveC = true;
          const t = ca >= 0 && cb >= 0 && cb !== ca ? (r - ca) / (cb - ca) : 0, r0 = ca >= 0 ? ca : cb, r1 = cb >= 0 ? cb : ca;
          for (let x = 0; x < px; x++) {
            const f = Math.max(0, Math.min(nseg - 1, (x + 0.5) / px * nseg - 0.5)), j = Math.floor(f), w = f - j, j1 = Math.min(nseg - 1, j + 1);
            const u0 = this.cu[r0 * nseg + j] * (1 - w) + this.cu[r0 * nseg + j1] * w, u1 = this.cu[r1 * nseg + j] * (1 - w) + this.cu[r1 * nseg + j1] * w;
            const v0 = this.cv2[r0 * nseg + j] * (1 - w) + this.cv2[r0 * nseg + j1] * w, v1 = this.cv2[r1 * nseg + j] * (1 - w) + this.cv2[r1 * nseg + j1] * w;
            const uu = u0 * (1 - t) + u1 * t - bu, vv = v0 * (1 - t) + v1 * t - bv;
            uRow[x] = (uu * hc - vv * hs) * sat;
            vRow[x] = (uu * hs + vv * hc) * sat;
          }
        }
      }
      let o = r * px * 4;
      for (let x = 0; x < px; x++, o += 4) {
        const y = (yRow[x] - 64) / 149;
        if (haveC) {
          // no colour in near-black and near-white: there the chroma is mostly noise and cross-colour
          const k = Math.max(0, Math.min(1, Math.min(y * 5, (1.05 - y) * 5)));
          const u = uRow[x] * k, v = vRow[x] * k;
          d[o] = (y + 1.13983 * v) * 255;
          d[o + 1] = (y - 0.39465 * u - 0.5806 * v) * 255;
          d[o + 2] = (y + 2.03211 * u) * 255;
        } else {
          d[o] = d[o + 1] = d[o + 2] = y * 255;
        }
        d[o + 3] = 255;
      }
    }
  }

  live() { return performance.now() - this.last < 1500; }
  locked() { return this.live() && (this.state & VSTATE.LINE) !== 0; }
  frameLocked() { return this.live() && (this.state & VSTATE.FRAME) !== 0; }

  snapshot(name) {
    this.cv.toBlob(b => download(b, name + ".png"), "image/png");
  }

  // Records what the canvas shows (WebM). Returns a stop function.
  record(name) {
    const stream = this.cv.captureStream(25);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 1500000 } : undefined);
    const parts = [];
    rec.ondataavailable = e => e.data.size && parts.push(e.data);
    rec.onstop = () => download(new Blob(parts, { type: "video/webm" }), name + ".webm");
    rec.start(1000);
    return () => rec.stop();
  }
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
