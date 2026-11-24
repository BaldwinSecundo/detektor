// Analog FPV picture from the C5's 'V' frames (luma only).
// Lines arrive with their ITU line number once the demodulator has vertical
// lock. With "fields" on (default) the C5 sends only the even lines of field 1,
// so every received line is painted 4 rows tall: a whole, steady picture at
// ~25 frames/s instead of a random half of the lines.
import { parseVHeader, VF, VSTATE } from "./proto.js";

const LUT = new Uint8ClampedArray(256).map((_, v) => Math.round(Math.min(1, Math.max(0, (v - 64) / 149)) * 255));

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
    this.dirty = false;
    this.freeRow = 0;   // before vertical lock: lines are stacked as they come
    this.clearStats();
    this.state = 0;
    this.last = 0;
    const loop = () => {
      if (this.dirty && this.img) { this.ctx.putImageData(this.img, 0, 0); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  clearStats() { this.stats = { lines: 0, bytes: 0, lost: 0, gap: 0, frames: 0, seq: -1 }; }

  setup(px, ntsc) {
    const rows = ntsc ? 480 : 576;
    if (this.img && this.img.width === px && this.img.height === rows) return;
    this.cv.width = px; this.cv.height = rows; this.ntsc = ntsc;
    this.img = this.ctx.createImageData(px, rows);
    this.blank();
  }

  blank() {
    if (!this.img) return;
    const d = this.img.data;
    for (let k = 0; k < d.length; k += 4) { d[k] = d[k + 1] = d[k + 2] = 8; d[k + 3] = 255; }
    this.dirty = true;
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
    const px = h.px, rec = 8 + px, d = this.img.data, H = this.img.height;
    for (let k = 0; k < h.n && 16 + (k + 1) * rec <= p.length; k++) {
      const o = 16 + k * rec, line = p[o] | (p[o + 1] << 8), flags = p[o + 2];
      s.lines++;
      let r, rep;
      if (flags & VF.VLOCK) {
        r = rowOf(line, this.ntsc);
        if (r < 0) continue;
        rep = this.gate && !(flags & VF.FIELD2) ? 4 : 1;
      } else {
        // line lock only: stack lines so something is visible while it locks
        r = this.freeRow; this.freeRow = (this.freeRow + 2) % H; rep = 2;
      }
      for (let rr = r; rr < Math.min(H, r + rep); rr++) {
        let dd = rr * px * 4;
        for (let j = 0; j < px; j++, dd += 4) { const yv = LUT[p[o + 8 + j]]; d[dd] = d[dd + 1] = d[dd + 2] = yv; }
      }
      this.dirty = true;
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
