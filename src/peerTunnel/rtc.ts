import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { rtcChannel, type TunnelChannel } from "./channel.js";
const label = "rabi.tunnel.v1";
function sdp(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 60_000 || !value.startsWith("v=0") || !value.includes("m=application ")
    || /^m=(audio|video) /m.test(value) || / typ relay(?: |\r|\n|$)/.test(value)) throw new Error("Invalid tunnel SDP.");
  return value;
}
export class TunnelRtc {
  private readonly peers = new Set<RTCPeerConnection>();
  constructor(private readonly stunUrls = ["stun:stun.l.google.com:19302"]) {}
  private create() {
    if (this.peers.size >= 8) throw new Error("Tunnel connection limit reached.");
    const peer = new RTCPeerConnection({ iceServers: this.stunUrls.map(urls => ({ urls })) });
    this.peers.add(peer);
    const close = () => { if (this.peers.delete(peer)) void peer.close(); };
    peer.connectionStateChange.subscribe(state => { if (["closed", "failed", "disconnected"].includes(state)) close(); });
    return { peer, close };
  }
  async offer(value: unknown, accept: (channel: TunnelChannel) => void): Promise<{ sdp: string }> {
    const remote = sdp(value);
    const { peer, close } = this.create();
    const timer = setTimeout(close, 15_000); timer.unref();
    let claimed = false;
    peer.onDataChannel.subscribe(channel => {
      if (claimed || channel.label !== label || !channel.ordered) { close(); return; } claimed = true;
      const opened = () => { clearTimeout(timer); accept(rtcChannel(channel, close)); };
      if (channel.readyState === "open") opened(); else channel.stateChange.subscribe(state => { if (state === "open") opened(); });
    });
    try { await peer.setRemoteDescription({ type: "offer", sdp: remote }); await peer.setLocalDescription(await peer.createAnswer());
      return { sdp: peer.localDescription!.sdp }; }
    catch (error) { clearTimeout(timer); close(); throw error; }
  }
  async connect(signalOffer: (offer: { sdp: string }) => Promise<{ sdp: string }>, signal: AbortSignal): Promise<TunnelChannel> {
    const { peer, close } = this.create();
    const abort = () => close(); signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("Tunnel attempt cancelled.");
      const channel = peer.createDataChannel(label, { ordered: true });
      const wrapped = rtcChannel(channel, close);
      const opened = channel.stateChange.watch(state => state === "open", 10_000); void opened.catch(() => {});
      const failure = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Tunnel attempt cancelled.")), { once: true });
      });
      await Promise.race([(async () => {
        await peer.setLocalDescription(await peer.createOffer());
        const answer = await signalOffer({ sdp: peer.localDescription!.sdp });
        if (signal.aborted) throw new Error("Tunnel attempt cancelled.");
        await peer.setRemoteDescription({ type: "answer", sdp: sdp(answer.sdp) }); await opened;
      })(), failure]);
      return wrapped;
    } catch (error) { close(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  stop() { for (const peer of this.peers) void peer.close(); this.peers.clear(); }
}
