// Wire format of the detector firmware (firmware/src/frame.h) and the 5.8 GHz
// channel tables. Every byte from the C5 is inside a frame:
//   A5 5A | type | length u16 LE | payload | CRC-16/X-25 u16 LE (over type, length, payload)
// The phone sends plain text command lines.

export const BANDS = {
  R: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
  A: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  B: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  E: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  F: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  L: [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621],
};
export const BAND_ORDER = ["R", "F", "E", "A", "B", "L"];   // Raceband first for shared frequencies

// Channel name for an exact or near frequency ("R5", "F4~"), or "".
export function channelName(mhz, tol = 2) {
  let best = "", bestD = tol + 1;
  for (const b of BAND_ORDER) BANDS[b].forEach((f, i) => {
    const d = Math.abs(f - mhz);
    if (d < bestD) { bestD = d; best = b + (i + 1); }
  });
  if (!best) return "";
  return bestD < 0.5 ? best : best + "~";
}

export function allChannels() {
  const out = [];
  for (const b of BAND_ORDER) BANDS[b].forEach((f, i) => out.push({ name: b + (i + 1), mhz: f, band: b }));
  return out;
}

export function crc16x25(b, start, end) {
  let c = 0xFFFF;
  for (let i = start; i < end; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return (~c) & 0xFFFF;
}

// Byte-table CRC, same result, ~8x faster (video runs at ~0.5-0.9 MB/s).
const CRC_TAB = new Uint16Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
  return c;
});
export function crcFast(b, start, end) {
  let c = 0xFFFF;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TAB[(c ^ b[i]) & 0xFF];
  return (~c) & 0xFFFF;
}

export function encodeFrame(type, payload) {
  const out = new Uint8Array(payload.length + 7);
  out[0] = 0xA5; out[1] = 0x5A; out[2] = type.charCodeAt(0);
  out[3] = payload.length & 0xFF; out[4] = payload.length >> 8;
  out.set(payload, 5);
  const c = crcFast(out, 2, 5 + payload.length);
  out[5 + payload.length] = c & 0xFF; out[6 + payload.length] = c >> 8;
  return out;
}

// Streams bytes in, calls onFrame(type, payload) per valid frame.
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = new Uint8Array(1 << 18);
    this.len = 0;
    this.crcErrors = 0;
    this.bytes = 0;
  }
  push(chunk) {
    this.bytes += chunk.length;
    if (this.len + chunk.length > this.buf.length) {
      const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      n.set(this.buf.subarray(0, this.len));
      this.buf = n;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    const b = this.buf;
    let i = 0;
    for (;;) {
      while (i + 1 < this.len && !(b[i] === 0xA5 && b[i + 1] === 0x5A)) i++;
      if (i + 5 > this.len) break;
      const len = b[i + 3] | (b[i + 4] << 8);
      if (len > 4096) { i += 2; continue; }
      if (i + 7 + len > this.len) break;
      const crc = b[i + 5 + len] | (b[i + 6 + len] << 8);
      if (crcFast(b, i + 2, i + 5 + len) !== crc) { this.crcErrors++; i += 2; continue; }
      // slice(): the handler may keep it, the buffer is reused
      this.onFrame(String.fromCharCode(b[i + 2]), b.slice(i + 5, i + 5 + len));
      i += 7 + len;
    }
    if (i > 0) { b.copyWithin(0, i, this.len); this.len -= i; }
  }
}

// 'W' waterfall line (frame.h WaterfallHeader, 24 bytes) + mean[count] + peak[count].
// Level bytes: dB = byte / 2 + 40.
export function parseW(p) {
  if (p.length < 24) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const count = dv.getUint16(2, true);
  if (p.length < 24 + 2 * count) return null;
  return {
    seq: dv.getUint16(0, true), count,
    startKhz: dv.getUint32(4, true), stepHz: dv.getUint32(8, true),
    gain: p[12], sweeps: p[13], flags: p[14], encoding: p[15],
    sweepUs: dv.getUint32(16, true), clips: dv.getUint16(20, true), drops: dv.getUint16(22, true),
    mean: p.subarray(24, 24 + count), peak: p.subarray(24 + count, 24 + 2 * count),
  };
}
export const WF = { CLIPPED: 1, FINE: 2 };
export const levelDb = byte => byte / 2 + 40;

// 'R' record: 12-byte header + 14 bytes per pilot (AWL format). Track mode sends one pilot.
export function parseR(p) {
  if (p.length < 12) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = p[2], pilots = [];
  for (let k = 0; k < n && 12 + (k + 1) * 14 <= p.length; k++) {
    const o = 12 + k * 14;
    const raw = dv.getInt16(o + 4, true);
    pilots.push({
      tUs: dv.getUint32(o, true), raw: raw === -32768 ? NaN : raw / 100, filt: dv.getInt16(o + 6, true) / 100,
      mhz: dv.getUint16(o + 8, true), gain: p[o + 10], clips: p[o + 11], flags: p[o + 12], captures: p[o + 13],
    });
  }
  return { seq: dv.getUint16(0, true), drops: dv.getUint32(4, true), cycleUs: dv.getUint32(8, true), pilots };
}

// 'V' video (video/awl_video.h): 16-byte header + n records of (8 + px) bytes.
export const VF = { SYNC: 1, FIELD2: 2, VBI: 4, VLOCK: 8, VSYNC: 16, NTSC: 32, FULL: 64 };
export const VSTATE = { LINE: 1, FRAME: 2, NTSC: 4, POL: 8 };
export function parseVHeader(p) {
  if (p.length < 16) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    seq: dv.getUint16(0, true), n: p[2], state: p[3], px: dv.getUint16(4, true), mhz: dv.getUint16(6, true),
    tipKhz: dv.getInt16(8, true), blankKhz: dv.getInt16(10, true), gap: dv.getUint32(12, true),
  };
}
