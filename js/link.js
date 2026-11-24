// USB link to the XIAO ESP32-C5 from the phone's browser.
//
// Chrome on Android 148+ (and desktop Chrome/Edge) has the Web Serial API.
// Where it is missing but WebUSB exists, Google's web-serial-polyfill drives
// the C5's USB Serial/JTAG port (a CDC-ACM device) over WebUSB instead.
//
// Events: "state" (detail: "connected" | "disconnected" | "error: ..."),
//         "frame" (detail: {type, payload}).
import { FrameParser } from "./proto.js";

const ESPRESSIF_VID = 0x303A;

async function serialApi() {
  if ("serial" in navigator) return { api: navigator.serial, kind: "Web Serial" };
  if ("usb" in navigator) {
    const m = await import("../vendor/web-serial-polyfill.js");
    return { api: m.serial, kind: "WebUSB (polyfill)" };
  }
  return null;
}

export function linkSupport() {
  if (!window.isSecureContext) return "Strona musi być otwarta przez HTTPS (albo localhost).";
  if (!("serial" in navigator) && !("usb" in navigator))
    return "Ta przeglądarka nie ma Web Serial ani WebUSB. Użyj Chrome na Androidzie (wersja 148 lub nowsza) albo Chrome/Edge na komputerze.";
  return "";
}

export class Link extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.kind = "";
    this.connected = false;
    this.parser = new FrameParser((type, payload) =>
      this.dispatchEvent(new CustomEvent("frame", { detail: { type, payload } })));
    this.enc = new TextEncoder();
    this.queue = Promise.resolve();
    this.wantOpen = false;
  }

  state(s) { this.dispatchEvent(new CustomEvent("state", { detail: s })); }

  // ask: show the browser's device picker (needs a tap). Otherwise use a port
  // the user already allowed.
  async connect(ask) {
    const s = await serialApi();
    if (!s) throw new Error("brak Web Serial / WebUSB");
    this.kind = s.kind;
    let port = null;
    if (!ask && s.api.getPorts) {
      const ports = await s.api.getPorts();
      port = ports.find(p => (p.getInfo?.().usbVendorId ?? ESPRESSIF_VID) === ESPRESSIF_VID) || null;
    }
    if (!port) {
      if (!ask) return false;
      port = await s.api.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
    }
    await this.open(port);
    if (s.api.addEventListener && !this.watching) {
      this.watching = true;
      s.api.addEventListener("connect", e => { if (this.wantOpen && !this.connected) this.open(e.target).catch(() => {}); });
    }
    return true;
  }

  async open(port) {
    // baudRate is required by the API; the C5's native USB ignores it.
    await port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    // DTR and RTS low: on the C5's USB Serial/JTAG they drive reset and boot mode.
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* polyfill */ }
    this.port = port;
    this.connected = true;
    this.wantOpen = true;
    port.addEventListener?.("disconnect", () => this.lost("disconnected"));
    this.state("connected");
    this.readLoop();
  }

  async readLoop() {
    const port = this.port;
    while (port && port.readable && this.port === port) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.parser.push(value);
        }
      } catch (e) {
        if (this.port === port) { this.lost("error: " + e.message); return; }
      } finally {
        try { this.reader.releaseLock(); } catch { /* closed */ }
      }
    }
  }

  lost(why) {
    if (!this.connected) return;
    this.connected = false;
    const p = this.port;
    this.port = null;
    p?.close().catch(() => {});
    this.state(why.startsWith("error") ? why : "disconnected");
  }

  send(line) {
    if (!this.port || !this.port.writable) return;
    const port = this.port, data = this.enc.encode(line + "\n");
    this.queue = this.queue.then(async () => {
      const w = port.writable.getWriter();
      try { await w.write(data); } finally { w.releaseLock(); }
    }).catch(() => {});
  }

  async disconnect() {
    this.wantOpen = false;
    const p = this.port;
    this.port = null;
    this.connected = false;
    try { await this.reader?.cancel(); } catch { /* */ }
    try { await p?.close(); } catch { /* */ }
    this.state("disconnected");
  }
}
