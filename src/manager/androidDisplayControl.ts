import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { AndroidDisplaySession, type AndroidDisplayFrame, type AndroidDisplayOptions, type AndroidDisplayTouch, type AndroidGamepadFrame } from "../../apps/rabi-agent/lib/android-display-session.mjs";
import type { ApiOperationResult } from "./apiOperationContract.js";

type Bridge = Omit<AndroidDisplayOptions, "signal"> & { id: string; name: string };
type Target = { kind: "android-display"; bridgeId: string; surfaceId?: string };
type Source = { instanceId: string; frameId: string; layoutRevision: string; imageView?: { width: number; height: number } };
type Step = { type: "click" | "swipe" | "longPress"; x: number; y: number; endX?: number; endY?: number; durationMs?: number };
type Input = { action: string; requestId?: string; appId?: string; source?: Source; actions?: Step[]; frames?: AndroidGamepadFrame[]; captureAfter?: boolean | { waitMs: number }; waitMs?: number };
type Receipt = { requestId: string; state: string; completedActions: number; capture?: Record<string, unknown> };
type Mutation = { signature: string; cancelled: boolean; gamepadAbort?: AbortController; receipt: Receipt; done?: Promise<ApiOperationResult> };
type Opening = { done: Promise<ApiOperationResult>; target?: Target };
type Pointer = { requestId: string; label: string; action: AndroidDisplayTouch; kind: Step["type"]; started: number };
type Surface = { target: Target; session: AndroidDisplaySession; frames: Map<string, AndroidDisplayFrame>; receipts: Map<string, Mutation>;
  observers: Map<string, { label: string; expires: number }>; active?: Mutation; label?: string; pointer?: Pointer; gamepadClosing?: Promise<void> };

const run = promisify(execFile);
const responseHeaders = { "cache-control": "no-store" };
const success = (data: unknown): ApiOperationResult => ({ status: 200, headers: responseHeaders, body: { code: 0, data } });
const fail = (status: number, errorCode: string, message: string): ApiOperationResult =>
  ({ status, headers: responseHeaders, body: { code: -1, errorCode, message } });
const missing = () => fail(404, "ANDROID_DISPLAY_TARGET_UNKNOWN", "Choose a configured Android bridge or an original display from the device directory.");
const frameChanged = () => fail(409, "ANDROID_DISPLAY_FRAME_CHANGED", "Capture the selected display again before using coordinates.");
const requestConflict = () => fail(409, "ANDROID_DISPLAY_REQUEST_CONFLICT", "The original requestId belongs to another action.");

function cancelMutation(work?: Mutation) {
  if (!work) return;
  work.cancelled = true;
  work.gamepadAbort?.abort();
}

function readBridges(value: string | undefined): { bridges: Bridge[]; invalid: boolean } {
  if (!value) return { bridges: [], invalid: false };
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows)) throw new TypeError("Android display bridges must be a JSON array.");
  const ids = new Set<string>();
  const bridges: Bridge[] = [];
  let invalid = false;
  for (const row of rows as Bridge[]) {
    if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(row.id) || ids.has(row.id)
      || typeof row.name !== "string" || !row.name.trim() || row.name.length > 160
      || typeof row.serial !== "string" || !/^[A-Za-z0-9._:\[\]-]{1,128}$/.test(row.serial)
      || typeof row.serverPath !== "string" || !isAbsolute(row.serverPath)
      || [row.adb, row.ffmpeg].some(exe => exe !== undefined && (typeof exe !== "string" || !isAbsolute(exe)))
      || [[row.width, 160, 1920], [row.height, 160, 1920], [row.dpi, 72, 640]].some(([number, low, high]) =>
        number !== undefined && (!Number.isInteger(number) || number < low! || number > high!))) {
      invalid = true;
      continue;
    }
    ids.add(row.id);
    bridges.push(row);
  }
  return { bridges, invalid };
}

/** Owns live displays within one Manager generation, independent of its plugin publication cycle. */
export class AndroidDisplayControl {
  private readonly bridges = new Map<string, Bridge>();
  private readonly surfaces = new Map<string, Surface>();
  private readonly openings = new Map<string, Opening>();
  private readonly retirement = new AbortController();
  private invalidConfig = false;

  constructor(config: string | undefined) {
    try {
      const { bridges, invalid } = readBridges(config);
      this.invalidConfig = invalid;
      for (const row of bridges) this.bridges.set(row.id, row);
    }
    catch { this.invalidConfig = true; }
  }

  async list(signal?: AbortSignal) {
    const rows = [...this.bridges.values()];
    const base = await Promise.all(rows.map(async bridge => {
      const online = await Promise.all([
        stat(bridge.serverPath).then(value => value.isFile()).catch(() => false),
        run(bridge.adb ?? "adb", ["-s", bridge.serial, "get-state"], { windowsHide: true, timeout: 1500, signal })
          .then(value => value.stdout.trim() === "device").catch(() => false)
      ]).then(results => results.every(Boolean));
      return { name: bridge.name, online, capabilities: ["display.open"], target: { kind: "android-display", bridgeId: bridge.id } };
    }));
    signal?.throwIfAborted();
    const active = [...this.surfaces.values()].flatMap(row => {
      const { target, session } = row;
      if (!session.active) { row.frames.clear(); row.observers.clear(); row.pointer = undefined; return []; }
      return [{
        name: this.bridges.get(target.bridgeId)!.name + " · " + session.display.id, online: true,
        capabilities: ["screen.status", "screen.capture", "screen.wait", "input.perform", "input.status", "input.cancel", "apps.list", "apps.open", "display.close",
          ...(session.gamepadSupported ? ["input.gamepad", "input.gamepad.status", "input.gamepad.close"] : [])],
        target
      }];
    });
    return { targets: [...base, ...active], sourceErrors: this.invalidConfig ? [{ source: "android-display", message: "Check RABI_ANDROID_DISPLAY_BRIDGES." }] : [] };
  }

  async stop() {
    this.retirement.abort();
    await Promise.allSettled([...this.openings.values()].map(open => open.done));
    await Promise.allSettled([...this.surfaces.values()].map(async row => {
      cancelMutation(row.active);
      await row.session.close();
      row.frames.clear();
    }));
  }

  async execute(target: Target, record: Record<string, unknown>, label: string | undefined, signal?: AbortSignal): Promise<ApiOperationResult> {
    signal?.throwIfAborted();
    this.retirement.signal.throwIfAborted();
    const bridge = this.bridges.get(target.bridgeId);
    if (!bridge) return missing();
    const input = record as Input;
    if (input.action === "display.open" && !target.surfaceId) {
      const key = JSON.stringify([target.bridgeId, input.requestId]);
      let open = this.openings.get(key);
      if (!open) {
        const next: Opening = { done: this.openDisplay(bridge, input.requestId!, signal, opened => { next.target = opened; }) };
        this.openings.set(key, next);
        open = next;
      }
      if (open.target && !this.surfaces.get(open.target.surfaceId!)?.session.active) {
        return success({ requestId: input.requestId, state: "closed", target: open.target });
      }
      return open.done;
    }
    if (!target.surfaceId) return missing();
    const row = this.surfaces.get(target.surfaceId);
    if (!row || row.target.bridgeId !== target.bridgeId) return missing();
    const session = row.session;
    const previous = input.requestId ? row.receipts.get(input.requestId) : undefined;
    if (input.action === "input.status" || input.action === "input.cancel") {
      if (!previous) return success({ requestId: input.requestId, state: "absent", completedActions: 0 });
      if (input.action === "input.cancel" && row.active === previous) {
        cancelMutation(previous);
        if (row.pointer?.requestId === input.requestId) row.pointer = undefined;
        return success({ ...previous.receipt, state: "cancel-requested" });
      }
      return success(previous.receipt);
    }
    if (input.action === "input.gamepad.status") return success({
      state: row.gamepadClosing ? "closing" : row.active?.gamepadAbort ? "running" : session.gamepadSupported ? "ready" : "unavailable",
      connected: session.gamepadConnected
    });
    if (input.action === "input.gamepad.close") {
      if (!row.gamepadClosing) {
        const playing = row.active?.gamepadAbort ? row.active : undefined;
        cancelMutation(playing);
        row.gamepadClosing = Promise.resolve(playing?.done).then(() => session.closeGamepad());
      }
      const closing = row.gamepadClosing;
      try {
        await closing;
        return success({ state: "closed", connected: false });
      } catch { return fail(409, "ANDROID_DISPLAY_GAMEPAD_CLOSE_UNCONFIRMED", "Android has not confirmed releasing the gamepad. Check its status or close this display."); }
      finally { if (row.gamepadClosing === closing) row.gamepadClosing = undefined; }
    }
    if (input.action === "display.close") {
      cancelMutation(row.active);
      await row.active?.done;
      await session.close();
      row.frames.clear();
      row.observers.clear();
      row.pointer = undefined;
      return success({ state: "closed", target: row.target });
    }
    if (input.action === "screen.status") return success(session.active ? {
      state: "sharing", layoutRevision: session.display.layoutRevision, activity: this.activity(row)
    } : { state: "closed" });
    const baseline = input.source ? this.reference(row, input.source) : undefined;
    if (input.action === "screen.capture") {
      try { return success(await this.observe(row, label, async () => this.frame(row, await session.capture({ signal })))); }
      catch { signal?.throwIfAborted(); return fail(409, "ANDROID_DISPLAY_FRAME_UNAVAILABLE", "No current frame is available from this display."); }
    }
    if (input.action === "screen.wait") {
      if (!baseline) return frameChanged();
      return success(await this.observe(row, label, () => this.wait(row, baseline, input.waitMs ?? 2500, signal)));
    }
    if (input.action === "apps.list") {
      if (!session.active) return fail(409, "ANDROID_DISPLAY_CLOSED", "Open another Android display.");
      return success({ state: "ready", apps: await session.listApps({ signal }) });
    }
    const isGamepad = input.action === "input.gamepad";
    if (!(input.action === "input.perform" || input.action === "apps.open" || isGamepad)) return missing();
    const id = input.requestId!;
    const signature = JSON.stringify([input.action, input.appId, input.source?.frameId, input.source?.layoutRevision,
      input.source?.instanceId, input.source?.imageView?.width, input.source?.imageView?.height,
      input.actions?.map(step => [step.type, step.x, step.y, step.endX, step.endY, step.durationMs]),
      input.frames?.map(frame => [frame.durationMs, [...(frame.buttons ?? [])].sort(), frame.leftX ?? 0, frame.leftY ?? 0,
        frame.rightX ?? 0, frame.rightY ?? 0, frame.leftTrigger ?? 0, frame.rightTrigger ?? 0]),
      typeof input.captureAfter === "object" ? input.captureAfter.waitMs : Boolean(input.captureAfter)]);
    if (previous) {
      if (previous.signature !== signature) return requestConflict();
      await previous.done;
      return success(previous.receipt);
    }
    if (!session.active) return fail(409, "ANDROID_DISPLAY_CLOSED", "Open another Android display.");
    if (isGamepad && input.frames!.reduce((total, frame) => total + frame.durationMs, 0) > 8000) {
      return fail(400, "ANDROID_DISPLAY_GAMEPAD_DURATION_EXCEEDED", "A gamepad batch can hold controls for at most 8000 ms.");
    }
    if (isGamepad && !session.gamepadSupported) return fail(409, "ANDROID_DISPLAY_GAMEPAD_UNAVAILABLE", "This Android display has no verified display-bound gamepad. Android 15 or newer is required.");
    if ((input.action === "input.perform" || input.source) && !baseline) return frameChanged();
    if (row.active || (isGamepad && row.gamepadClosing)) return success({ requestId: id, state: "busy", completedActions: 0 });
    let actions: AndroidDisplayTouch[] = [];
    try {
      if (input.actions) actions = input.actions.map(step => this.touch(step, baseline!, input.source?.imageView));
    } catch { return frameChanged(); }
    const work: Mutation = { signature, cancelled: false, receipt: { requestId: id, state: "running", completedActions: 0 } };
    if (isGamepad) { work.gamepadAbort = new AbortController(); row.pointer = undefined; }
    row.receipts.set(id, work);
    row.active = work;
    row.label = label || "Rabi";
    work.done = this.perform(row, work, actions, input, baseline, signal);
    return work.done;
  }

  private async openDisplay(bridge: Bridge, requestId: string, signal: AbortSignal | undefined, record: (target: Target) => void) {
    const stop = signal ? AbortSignal.any([signal, this.retirement.signal]) : this.retirement.signal;
    try {
      const session = await AndroidDisplaySession.open({ ...bridge, signal: stop });
      if (stop.aborted) { await session.close(); stop.throwIfAborted(); }
      const target: Target = { kind: "android-display", bridgeId: bridge.id, surfaceId: randomUUID() };
      this.surfaces.set(target.surfaceId!, { target, session, frames: new Map(), receipts: new Map(), observers: new Map() });
      record(target);
      return success({ requestId, state: "opened", target, width: session.display.width, height: session.display.height });
    } catch { return fail(503, "ANDROID_DISPLAY_OPEN_FAILED", "The selected ADB device or display tools could not start the display."); }
  }

  private frame(row: Surface, frame: AndroidDisplayFrame) {
    const frameId = randomUUID(), { width, height, display, capturedAt } = frame;
    row.frames.set(frameId, frame);
    if (row.frames.size > 8) row.frames.delete(row.frames.keys().next().value!);
    const bounds = { x: 0, y: 0, width: display.width, height: display.height };
    return { frameId, mimeType: "image/png", data: frame.data.toString("base64"), width, height, capturedAt, bounds,
      source: { instanceId: row.target.surfaceId, layoutRevision: display.layoutRevision, frameId, width, height, bounds,
        kind: "desktop", scope: "virtual", coordinateSpace: "capture", captureMethod: "android-scrcpy-display" } };
  }

  private reference(row: Surface, source: Source) {
    if (source?.instanceId !== row.target.surfaceId || source.layoutRevision !== row.session.display.layoutRevision) return undefined;
    return row.frames.get(source.frameId);
  }

  private async observe<T>(row: Surface, name: string | undefined, perform: () => Promise<T>) {
    this.observations(row);
    const id = randomUUID(), observation = { label: name || "Rabi", expires: Infinity };
    row.observers.set(id, observation);
    try { return await perform(); }
    finally { observation.expires = performance.now() + 2500; }
  }

  private observations(row: Surface) {
    const now = performance.now(), result = [];
    for (const [id, observation] of row.observers) {
      if (observation.expires <= now) row.observers.delete(id);
      else result.push({ id, label: observation.label });
    }
    return result;
  }

  private activity(row: Surface) {
    const operation = row.active ? { requestId: row.active.receipt.requestId, label: row.label } : undefined;
    const feedback = row.pointer;
    const action = feedback?.action;
    let pointer;
    if (feedback && action) {
      const duration = action.type === "swipe" ? action.durationMs : 0;
      const elapsed = performance.now() - feedback.started;
      const remainingMs = Math.floor(duration + 450 - elapsed);
      if (remainingMs > 0) {
        const { width, height } = row.session.display;
        const ratio = duration ? Math.min(1, elapsed / duration) : 0;
        const x = action.type === "swipe" ? action.x + (action.endX - action.x) * ratio : action.x;
        const y = action.type === "swipe" ? action.y + (action.endY - action.y) * ratio : action.y;
        pointer = { requestId: feedback.requestId, label: feedback.label, kind: feedback.kind, remainingMs,
          startX: action.x / width, startY: action.y / height, x: x / width, y: y / height };
      } else row.pointer = undefined;
    }
    return { observations: this.observations(row), operation, pointer };
  }

  private touch(step: Step, frame: AndroidDisplayFrame, view?: Source["imageView"]): AndroidDisplayTouch {
    const width = view?.width ?? frame.width, height = view?.height ?? frame.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      Math.abs(width * frame.height / frame.width - height) > 2) throw new Error("Display view geometry changed.");
    const map = (value: number, shown: number, native: number) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= shown) throw new Error("Unexpected touch coordinate.");
      return value / shown * native;
    };
    const x = map(step.x, width, frame.display.width), y = map(step.y, height, frame.display.height);
    if (step.type === "click") return { type: "tap", x, y };
    return { type: "swipe", x, y, durationMs: step.durationMs!,
      endX: step.type === "longPress" ? x : map(step.endX!, width, frame.display.width),
      endY: step.type === "longPress" ? y : map(step.endY!, height, frame.display.height) };
  }

  private async wait(row: Surface, baseline: AndroidDisplayFrame, waitMs: number, signal?: AbortSignal, work?: Mutation) {
    const deadline = performance.now() + waitMs;
    let after = baseline.sequence;
    try {
      while (row.session.active && !work?.cancelled && performance.now() < deadline) {
        const current = await row.session.capture({ after, timeoutMs: Math.max(1, deadline - performance.now()), signal });
        after = current.sequence;
        if (work?.cancelled) break;
        if (!current.data.equals(baseline.data)) return { state: "changed", capture: this.frame(row, current) };
      }
    } catch { signal?.throwIfAborted(); }
    return { state: work?.cancelled ? "cancelled" : row.session.active ? "unchanged" : "target-changed" };
  }

  private async perform(row: Surface, work: Mutation, actions: AndroidDisplayTouch[], input: Input, baseline?: AndroidDisplayFrame, signal?: AbortSignal) {
    const { receipt } = work;
    let capture: Record<string, unknown> | undefined;
    try {
      signal?.throwIfAborted();
      if (input.action === "apps.open") {
        const launched = (await row.session.listApps()).some(app => app.appId === input.appId);
        if (!launched) receipt.state = "app-unavailable";
        else if (!work.cancelled && !signal?.aborted) { await row.session.openApp(input.appId!); receipt.completedActions++; }
      }
      for (const [index, action] of actions.entries()) {
        if (work.cancelled || signal?.aborted) break;
        row.pointer = { requestId: receipt.requestId, label: row.label!, action, kind: input.actions![index]!.type, started: performance.now() };
        await row.session.touch(action);
        receipt.completedActions++;
      }
      if (work.gamepadAbort) {
        const abort = signal ? AbortSignal.any([signal, work.gamepadAbort.signal]) : work.gamepadAbort.signal;
        try {
          for (const frame of input.frames!) {
            await row.session.gamepadFrame(frame, { signal: abort });
            receipt.completedActions++;
          }
        } finally { await row.session.neutralGamepad(); }
      }
      if (receipt.state !== "app-unavailable") receipt.state = work.cancelled || signal?.aborted ? "cancelled" : "completed";
    } catch { receipt.state = work.cancelled || signal?.aborted ? "cancelled" : "uncertain"; }
    try {
      if (receipt.state === "completed" && input.captureAfter) {
        if (typeof input.captureAfter === "object" && baseline) {
          const outcome = await this.wait(row, baseline, input.captureAfter.waitMs, signal, work);
          capture = outcome.capture ? { state: "captured", ...outcome.capture } : { state: outcome.state };
        } else {
          const frame = await row.session.capture({ after: baseline?.sequence ?? 0, signal });
          capture = { state: "captured", ...this.frame(row, frame) };
        }
        receipt.capture = { state: capture.state, frameId: capture.frameId };
      }
    } catch { receipt.capture = { state: "unavailable" }; }
    finally {
      if (receipt.state !== "completed" && row.pointer?.requestId === receipt.requestId) row.pointer = undefined;
      row.active = undefined; row.label = undefined;
      work.done = undefined;
    }
    return success({ ...receipt, ...(capture ? { capture } : {}) });
  }
}
