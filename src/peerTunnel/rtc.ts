import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { rtcChannel, type TunnelChannel } from "./channel.js";
const label = "rabi.tunnel.v1";
function sdp(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 60_000 || !value.startsWith("v=0") || !value.includes("m=application ")
    || /^m=(audio|video) /m.test(value) || / typ relay(?: |\r|\n|$)/.test(value)) throw new Error("Invalid tunnel SDP.");
  return value;
}
export class TunnelRtc {
  private readonly peers = new Map<RTCPeerConnection, () => Promise<void>>();
  private readonly closing = new Set<Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly controller = new AbortController();
  private stopped = false;
  private retirement?: Promise<void>;
  private readonly closeErrors: unknown[] = [];
  constructor(private readonly stunUrls = ["stun:stun.l.google.com:19302"]) {}
  private create() {
    if (this.stopped) throw new Error("Tunnel RTC stopped.");
    if (this.peers.size >= 8) throw new Error("Tunnel connection limit reached.");
    const peer = new RTCPeerConnection({ iceServers: this.stunUrls.map(urls => ({ urls })) });
    let retirement: Promise<void> | undefined;
    const close = () => {
      if (retirement) return retirement;
      this.peers.delete(peer);
      // Defer the native close to make synchronous close-state callbacks reentrant.
      const closing = Promise.resolve().then(() => peer.close());
      retirement = closing;
      this.closing.add(closing);
      void closing.then(() => this.closing.delete(closing), error => { this.closeErrors.push(error); this.closing.delete(closing); });
      return closing;
    };
    this.peers.set(peer, close);
    peer.connectionStateChange.subscribe(state => { if (["closed", "failed", "disconnected"].includes(state)) close(); });
    return { peer, close };
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  offer(value: unknown, accept: (channel: TunnelChannel) => void): Promise<{ sdp: string }> {
    return this.track(this.offerCurrent(value, accept));
  }
  private async offerCurrent(value: unknown, accept: (channel: TunnelChannel) => void): Promise<{ sdp: string }> {
    const remote = sdp(value);
    const { peer, close } = this.create();
    const timer = setTimeout(() => { this.timers.delete(timer); void close(); }, getTimeoutMs("peer.rtcClose", 15000)); timer.unref(); this.timers.add(timer);
    let claimed = false;
    peer.onDataChannel.subscribe(channel => {
      if (claimed || channel.label !== label || !channel.ordered) { close(); return; } claimed = true;
      const opened = () => { clearTimeout(timer); this.timers.delete(timer); if (!this.stopped) accept(rtcChannel(channel, close)); else void close(); };
      if (channel.readyState === "open") opened(); else channel.stateChange.subscribe(state => { if (state === "open") opened(); });
    });
    try { await peer.setRemoteDescription({ type: "offer", sdp: remote }); await peer.setLocalDescription(await peer.createAnswer());
      return { sdp: peer.localDescription!.sdp }; }
    catch (error) { clearTimeout(timer); this.timers.delete(timer); await close(); throw error; }
  }
  async connect(signalOffer: (offer: { sdp: string }) => Promise<{ sdp: string }>, signal: AbortSignal): Promise<TunnelChannel> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const { peer, close } = this.create();
    const abort = () => { void close(); }; signal.addEventListener("abort", abort, { once: true });
    let rejectAbort!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const failAbort = () => rejectAbort(new Error("Tunnel attempt cancelled."));
    signal.addEventListener("abort", failAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("Tunnel attempt cancelled.");
      const channel = peer.createDataChannel(label, { ordered: true });
      const wrapped = rtcChannel(channel, close);
      const opened = this.track(new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); subscription.unSubscribe();
          signal.removeEventListener("abort", cancelled);
          if (error) reject(error); else resolve();
        };
        const cancelled = () => finish(new Error("Tunnel attempt cancelled."));
        const timer = setTimeout(() => finish(new Error("Tunnel channel open timed out.")), getTimeoutMs("peer.rtcOpen", 10000));
        const subscription = channel.stateChange.subscribe(state => {
          if (state === "open") finish();
          else if (state === "closed") finish(new Error("Tunnel channel closed."));
        });
        signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted) cancelled(); else if (channel.readyState === "open") finish();
      }));
      const producer = this.track((async () => {
        await peer.setLocalDescription(await peer.createOffer());
        signal.throwIfAborted();
        const answer = await signalOffer({ sdp: peer.localDescription!.sdp });
        if (signal.aborted) throw new Error("Tunnel attempt cancelled.");
        await peer.setRemoteDescription({ type: "answer", sdp: sdp(answer.sdp) }); await opened;
        if (channel.readyState !== "open") throw new Error("Tunnel channel closed.");
      })());
      await Promise.race([producer, failure]);
      return wrapped;
    } catch (error) { await close(); throw error; }
    finally { signal.removeEventListener("abort", abort); signal.removeEventListener("abort", failAbort); }
  }
  stop(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.stopped = true;
    this.controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const peers = [...this.peers.values()];
    this.retirement = (async () => {
      await Promise.allSettled([...this.closing, ...peers.map(close => close())]);
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await Promise.allSettled([...this.closing]);
      if (this.closeErrors.length === 1) throw this.closeErrors[0];
      if (this.closeErrors.length) throw new AggregateError(this.closeErrors, "Peer RTC cleanup failed.");
    })();
    return this.retirement;
  }
}
