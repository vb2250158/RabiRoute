import { execFile, spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
export const ANDROID_DISPLAY_SERVER = Object.freeze({
  version: "4.0",
  sha256: "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a"
});
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const maxFrameBytes = 8 * 1024 * 1024;
const gamepadId = 1;
// Xbox-compatible HID layout from scrcpy v4.0 app/src/hid/hid_gamepad.c (Apache-2.0).
const gamepadDescriptor = Buffer.from(
  "05010905a101a10005010930093109330934150027ffff0000751095048102" +
  "050109320935150026ff7f75109502810205091901291015002501951075018102" +
  "0501093915012508750495018142c0c0", "hex");
const buttonBits = new Map([["A", 0], ["B", 1], ["X", 3], ["Y", 4], ["LB", 6], ["RB", 7],
  ["Back", 10], ["Start", 11], ["LS", 13], ["RS", 14]]);
const hatDirections = [[8, 1, 2], [7, 0, 3], [6, 5, 4]];

function gamepadReport(frame = {}) {
  const bytes = Buffer.alloc(20);
  bytes[0] = 13; // scrcpy TYPE_UHID_INPUT
  bytes.writeUInt16BE(gamepadId, 1);
  bytes.writeUInt16BE(15, 3);
  const invert = value => value === -32768 ? 32767 : -(value ?? 0);
  const axes = [frame.leftX ?? 0, invert(frame.leftY), frame.rightX ?? 0, invert(frame.rightY)];
  for (const [index, value] of axes.entries()) bytes.writeUInt16LE(32768 + value, 5 + index * 2);
  bytes.writeUInt16LE(Math.round((frame.leftTrigger ?? 0) * 32767 / 255), 13);
  bytes.writeUInt16LE(Math.round((frame.rightTrigger ?? 0) * 32767 / 255), 15);
  const buttons = new Set(frame.buttons);
  let mask = 0;
  for (const [button, bit] of buttonBits) if (buttons.has(button)) mask |= 1 << bit;
  bytes.writeUInt16LE(mask, 17);
  bytes[19] = hatDirections[1 + Number(buttons.has("Down")) - Number(buttons.has("Up"))]
    [1 + Number(buttons.has("Right")) - Number(buttons.has("Left"))];
  return bytes;
}

/** Execution transport for one explicitly selected, ADB-authorized Android display. */
export class AndroidDisplaySession {
  #adbExecutable;
  #serial;
  #socketName;
  #remoteJar;
  #listener;
  #video;
  #control;
  #gamepadSupported = false;
  #gamepadConnected = false;
  #server;
  #decoder;
  #remotePid;
  #reversed = false;
  #pushed = false;
  #log = "";
  #error;
  #display;
  #frame;
  #frameBytes = Buffer.alloc(0);
  #sequence = 0;
  #closePromise;

  constructor(adbExecutable, serial) {
    this.#adbExecutable = adbExecutable;
    this.#serial = serial;
    const id = randomInt(1, 0x8000_0000).toString(16).padStart(8, "0");
    this.#socketName = "scrcpy_" + id;
    this.#remoteJar = "/data/local/tmp/rabi-display-" + id + ".jar";
  }

  static async open({ serial, serverPath, adb = "adb", ffmpeg = "ffmpeg", width = 480, height = 800, dpi = 160, signal } = {}) {
    if (typeof serial !== "string" || !/^[A-Za-z0-9._:\[\]-]{1,128}$/.test(serial)) {
      throw new TypeError("Select an exact ADB device serial.");
    }
    for (const [name, value, min, max] of [["width", width, 160, 1920], ["height", height, 160, 1920], ["dpi", dpi, 72, 640]]) {
      if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid Android display " + name + ".");
    }
    signal?.throwIfAborted();
    const jar = await readFile(serverPath);
    if (createHash("sha256").update(jar).digest("hex") !== ANDROID_DISPLAY_SERVER.sha256) {
      throw new Error("Expected the official scrcpy " + ANDROID_DISPLAY_SERVER.version + " server.");
    }
    const session = new AndroidDisplaySession(adb, serial);
    try {
      await session.#start({ serverPath, ffmpeg, width, height, dpi, signal });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get display() { return this.#display; }
  get active() { return Boolean(this.#display && !this.#error && !this.#closePromise); }
  get gamepadSupported() { return this.active && this.#gamepadSupported && Boolean(this.#control?.writable && !this.#control.destroyed); }
  get gamepadConnected() { return this.gamepadSupported && this.#gamepadConnected; }

  #adb(args, signal) {
    return run(this.#adbExecutable, ["-s", this.#serial, ...args], { windowsHide: true, timeout: 9000, signal });
  }

  async #start({ serverPath, ffmpeg, width, height, dpi, signal }) {
    const state = await this.#adb(["get-state"], signal);
    if (state.stdout.trim() !== "device") throw new Error("The selected Android device is not authorized.");
    const platform = await this.#adb(["shell", "-T", "getprop", "ro.build.version.sdk"], signal).catch(() => {
      signal?.throwIfAborted();
      return undefined;
    });
    const control = Number(platform?.stdout.trim()) >= 35;
    this.#listener = createServer(socket => {
      if (this.#closePromise || !this.#decoder) { socket.destroy(); return; }
      if (this.#video) {
        if (!control || this.#control) { socket.destroy(); return; }
        this.#control = socket;
        socket.on("error", () => { this.#gamepadConnected = false; });
        socket.on("close", () => { this.#gamepadConnected = false; });
        socket.resume(); // Drain unsolicited device reports. Clipboard sync is disabled.
        this.#listener.close();
        return;
      }
      this.#video = socket;
      if (!control) this.#listener.close();
      socket.on("error", error => this.#fail(error));
      socket.on("end", () => this.#fail(new Error("Android video stream ended.")));
      socket.pipe(this.#decoder.stdin);
    });
    this.#listener.listen(0, "127.0.0.1");
    await once(this.#listener, "listening");
    const port = this.#listener.address().port;
    await this.#adb(["reverse", "--no-rebind", "localabstract:" + this.#socketName, "tcp:" + port], signal);
    this.#reversed = true;
    this.#pushed = true;
    await this.#adb(["push", serverPath, this.#remoteJar], signal);
    this.#decoder = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "h264",
      "-analyzeduration", "0", "-probesize", "32", "-threads", "1", "-i", "pipe:0", "-threads", "1",
      "-f", "image2pipe", "-c:v", "png", "-compression_level", "2", "pipe:1"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.#watchChild(this.#decoder, "Android frame decoder");
    this.#decoder.stdin.on("error", error => this.#fail(error));
    this.#decoder.stdout.on("data", chunk => { try { this.#decodeFrames(chunk); } catch (error) { this.#fail(error); } });

    const id = this.#socketName.slice("scrcpy_".length);
    const args = ["app_process", "/", "com.genymobile.scrcpy.Server", ANDROID_DISPLAY_SERVER.version,
      "scid=" + id, "audio=false", "control=" + control, "raw_stream=true",
      "clipboard_autosync=false", "power_on=false", "keep_active=false",
      "new_display=" + width + "x" + height + "/" + dpi, "max_fps=30", "stay_awake=false"];
    const command = "printf 'RABI_DISPLAY_PID=%d\\n' \"$$\"; CLASSPATH=" + this.#remoteJar + " exec " + args.join(" ");
    this.#server = spawn(this.#adbExecutable, ["-s", this.#serial, "shell", "-T", command],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.#watchChild(this.#server, "Android display");
    this.#server.stdout.on("data", chunk => {
      this.#appendLog(chunk);
      const pid = this.#log.match(/RABI_DISPLAY_PID=(\d+)\r?\n/);
      if (pid) this.#remotePid = Number(pid[1]);
      const display = [...this.#log.matchAll(/New display: (\d+)x(\d+)\/\d+ \(id=(\d+)\)/g)].at(-1);
      if (!display) return;
      const [width, height, id] = display.slice(1).map(Number);
      if (id <= 0 || this.#display && (id !== this.#display.id || width !== this.#display.width || height !== this.#display.height)) {
        this.#fail(new Error("Android display identity changed."));
      } else if (!this.#display) this.#display = Object.freeze({ id, width, height, layoutRevision: randomUUID() });
    });
    await this.#wait(() => this.#display, 12000, signal);
    if (control) {
      try {
        await this.#wait(() => this.#control, 1000, signal);
        await this.#connectGamepad(signal);
        this.#gamepadSupported = true;
      } catch {
        signal?.throwIfAborted();
        this.#assertActive();
      }
    }
  }

  #writeControl(bytes) {
    if (!this.#control?.writable || this.#control.destroyed) throw new Error("Android gamepad control is disconnected.");
    return new Promise((resolve, reject) => this.#control.write(bytes, error => error ? reject(error) : resolve()));
  }

  get #gamepadName() { return "Rabi Gamepad " + this.#socketName.slice(7); }

  async #registeredGamepad(signal) {
    const { stdout } = await this.#adb(["shell", "-T", "dumpsys", "input"], signal);
    return stdout.split(/^  Device \d+: /m).find(block => block.split(/\r?\n/, 1)[0] === this.#gamepadName);
  }

  async #connectGamepad(signal) {
    const nameBytes = Buffer.from(this.#gamepadName);
    const header = Buffer.alloc(8);
    header[0] = 12; // scrcpy TYPE_UHID_CREATE
    header.writeUInt16BE(gamepadId, 1);
    header.writeUInt16BE(0x045e, 3);
    header.writeUInt16BE(0x028e, 5);
    header[7] = nameBytes.length;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(gamepadDescriptor.length);
    const { stdout } = await this.#adb(["shell", "-T", "dumpsys", "display"], signal);
    const displayId = new RegExp(`\\bdisplayId ${this.#display.id}\\b`);
    const displayLine = stdout.split(/\r?\n/).find(line => line.includes("mBaseDisplayInfo=DisplayInfo{") && displayId.test(line));
    const uniqueId = displayLine?.match(/\buniqueId[= ]+"([^"\r\n]+)"/)?.[1];
    if (!uniqueId?.startsWith("virtual:")) throw new Error("Android did not identify this virtual display.");
    await this.#writeControl(Buffer.concat([header, nameBytes, length, gamepadDescriptor]));
    try {
      const deadline = performance.now() + 2000;
      do {
        const device = await this.#registeredGamepad(signal);
        if (device?.match(/^    AssociatedDisplayUniqueIdByPort:[ \t]*(.+)$/m)?.[1]?.trim() === uniqueId) {
          this.#gamepadConnected = true;
          return;
        }
        await delay(100, undefined, { signal });
      } while (performance.now() < deadline);
      throw new Error("Android did not bind the gamepad to this virtual display.");
    } catch (error) {
      await this.#destroyGamepad().catch(() => {});
      throw error;
    }
  }

  async gamepadFrame(frame, { signal } = {}) {
    this.#assertActive();
    signal?.throwIfAborted();
    if (!this.gamepadSupported) throw new Error("No gamepad is available for this virtual display.");
    if (!this.#gamepadConnected) await this.#connectGamepad(signal);
    signal?.throwIfAborted();
    await this.#writeControl(gamepadReport(frame));
    await delay(frame.durationMs, undefined, { signal });
  }

  async neutralGamepad() {
    if (this.#gamepadConnected) await this.#writeControl(gamepadReport());
  }

  async closeGamepad() {
    if (!this.#gamepadConnected) return;
    await this.#destroyGamepad();
    const verification = AbortSignal.timeout(2200);
    while (await this.#registeredGamepad(verification)) await delay(100, undefined, { signal: verification });
    this.#gamepadConnected = false;
  }

  #destroyGamepad() {
    const bytes = Buffer.alloc(3);
    bytes[0] = 14; // scrcpy TYPE_UHID_DESTROY
    bytes.writeUInt16BE(gamepadId, 1);
    return this.#writeControl(bytes);
  }

  #appendLog(chunk) { this.#log = (this.#log + String(chunk)).slice(-16000); }

  #watchChild(child, name) {
    child.once("error", error => this.#fail(error));
    child.once("exit", code => this.#fail(new Error(name + " exited (" + code + ").")));
    child.stderr.on("data", chunk => this.#appendLog(chunk));
  }

  #fail(error) {
    if (!this.#closePromise && !this.#error) {
      this.#error = error;
      void this.close();
    }
  }

  #decodeFrames(chunk) {
    this.#frameBytes = Buffer.concat([this.#frameBytes, chunk]);
    while (this.#frameBytes.length >= 33) {
      const bytes = this.#frameBytes;
      if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error("Invalid Android decoder output.");
      let offset = 8, complete = false;
      while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset) + 12;
        if (offset + size > maxFrameBytes) throw new Error("Android frame exceeds the capture limit.");
        if (offset + size > bytes.length) break;
        const end = bytes.toString("ascii", offset + 4, offset + 8) === "IEND";
        offset += size;
        if (!end) continue;
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (this.#frame && (width !== this.#frame.width || height !== this.#frame.height)) throw new Error("Android capture geometry changed.");
        this.#frame = { sequence: ++this.#sequence, width, height,
          data: bytes.subarray(0, offset), capturedAt: new Date().toISOString() };
        this.#frameBytes = bytes.subarray(offset);
        complete = true;
        break;
      }
      if (!complete) return;
    }
  }

  #assertActive() {
    if (this.#error) throw this.#error;
    if (this.#closePromise) throw new Error("Android display is closed.");
  }

  async #wait(read, timeoutMs, signal) {
    const deadline = performance.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      this.#assertActive();
      const value = read();
      if (value) return value;
      await delay(15, undefined, { signal });
    } while (performance.now() < deadline);
    throw new Error("Android display did not respond in time." + (this.#log ? "\n" + this.#log : ""));
  }

  async capture({ after = 0, timeoutMs = 3000, signal } = {}) {
    const frame = await this.#wait(() => this.#frame?.sequence > after ? this.#frame : undefined, timeoutMs, signal);
    return { ...frame, data: Buffer.from(frame.data), display: this.#display };
  }

  async openApp(component, { signal } = {}) {
    if (typeof component !== "string" || !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(component)) throw new TypeError("Select an exact Android launcher component.");
    this.#assertActive();
    const result = await this.#adb(["shell", "-T", "am start -W --display " + this.#display.id + " -n '" + component + "'"], signal);
    if (!/(?:^|\r?\n)Status: ok\r?(?:\n|$)/.test(result.stdout)) throw new Error("Android did not confirm launching the app on this display.");
  }

  async listApps({ signal } = {}) {
    this.#assertActive();
    const { stdout } = await this.#adb(["shell", "-T", "cmd", "package", "query-activities", "--brief", "--components",
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"], signal);
    return [...new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line)))]
      .map(appId => { const packageName = appId.split("/")[0]; return { appId, packageName, name: packageName.split(".").at(-1) }; });
  }

  async touch(action, { signal } = {}) {
    this.#assertActive();
    const { id, width, height } = this.#display;
    const coordinate = (value, limit) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= limit) throw new RangeError("Touch point is outside the Android display.");
      return String(Math.floor(value));
    };
    const x = coordinate(action?.x, width), y = coordinate(action?.y, height);
    const args = [x, y];
    if (action.type === "swipe") {
      if (!Number.isInteger(action.durationMs) || action.durationMs < 100 || action.durationMs > 1200) throw new RangeError("Invalid swipe duration.");
      args.push(coordinate(action.endX, width), coordinate(action.endY, height), String(action.durationMs));
    } else if (action.type !== "tap") throw new TypeError("Unsupported Android touch action.");
    await this.#adb(["shell", "-T", "input", "touchscreen", "-d", String(id), action.type, ...args], signal);
  }

  close() {
    this.#closePromise ||= this.#cleanup();
    return this.#closePromise;
  }

  async #cleanup() {
    this.#control?.destroy();
    this.#video?.destroy();
    if (this.#listener?.listening) this.#listener.close();
    this.#decoder?.kill();
    if (this.#server?.pid && this.#server.exitCode === null && this.#server.signalCode === null) {
      const exited = once(this.#server, "exit").catch(() => {});
      await Promise.race([exited, delay(1400)]);
      if (this.#server.exitCode === null && this.#server.signalCode === null && this.#remotePid > 0) {
        const pid = String(this.#remotePid);
        const result = await this.#adb(["shell", "-T", "cat", "/proc/" + pid + "/cmdline"]).catch(() => undefined);
        const command = result?.stdout.split("\0");
        if (command?.includes("com.genymobile.scrcpy.Server") && command.includes("scid=" + this.#socketName.slice(7))) {
          await this.#adb(["shell", "-T", "kill", "-TERM", pid]).catch(() => {});
        }
        await Promise.race([exited, delay(900)]);
      }
      if (this.#server.exitCode === null && this.#server.signalCode === null) this.#server.kill();
    }
    if (this.#reversed) await this.#adb(["reverse", "--remove", "localabstract:" + this.#socketName]).catch(() => {});
    if (this.#pushed) await this.#adb(["shell", "-T", "rm", "-f", this.#remoteJar]).catch(() => {});
  }
}
