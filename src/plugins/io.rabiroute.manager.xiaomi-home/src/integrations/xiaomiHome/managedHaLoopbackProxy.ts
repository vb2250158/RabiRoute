import net, { type Socket } from "node:net";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";

/** Only the HA deployment owner may supply an address verified against its VM. */
export type ManagedHaTarget = Readonly<{ address: string; port: 80 | 8123 }>;
type Connection = { client: Socket; upstream: Socket; clientClosed: boolean; upstreamClosed: boolean };
type Options = Readonly<{
  maxConnections?: number;
  idleTimeoutMs?: number;
  connect?: (target: ManagedHaTarget) => Socket;
  onError?: (error: Error) => void;
  fetchPortBlocked?: (port: number) => Promise<boolean>;
}>;

/** Use the running Node fetch implementation rather than a duplicated, potentially stale port list. */
export async function fetchPortBlocked(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000), redirect: "error" });
    await response.body?.cancel();
    return false;
  } catch (error) {
    return error instanceof TypeError && error.cause instanceof Error && error.cause.message === "bad port";
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function checkedTarget(target: ManagedHaTarget): ManagedHaTarget {
  if (net.isIPv4(target.address) !== true || (target.port !== 80 && target.port !== 8123)) throw new Error("Invalid managed HA target.");
  const [first, second, third, fourth] = target.address.split(".").map(Number);
  if (first === 0 || first === 127 || first >= 224 || (first === 169 && second === 254)
    || (first === 255 && second === 255 && third === 255 && fourth === 255)) throw new Error("Invalid managed HA target.");
  return Object.freeze({ address: target.address, port: target.port });
}

/** Process-owned loopback TCP bridge. The target is supplied only by the verified HA owner. */
export class ManagedHaLoopbackProxy {
  private readonly connections = new Set<Connection>();
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly connect: (target: ManagedHaTarget) => Socket;
  private readonly server: net.Server;
  private target?: ManagedHaTarget;
  private closing?: Promise<void>;
  private failed?: Error;
  private constructor(private readonly options: Options) {
    this.maxConnections = boundedInteger(options.maxConnections ?? 32, 1, 256, "maxConnections");
    this.idleTimeoutMs = boundedInteger(options.idleTimeoutMs ?? 60000, 1000, 300000, "idleTimeoutMs");
    this.connect = options.connect ?? (target => net.createConnection({ host: target.address, port: target.port, allowHalfOpen: true }));
    this.server = net.createServer({ allowHalfOpen: true }, socket => this.accept(socket));
  }

  static async listen(options: Options = {}): Promise<ManagedHaLoopbackProxy> {
    const proxy = new ManagedHaLoopbackProxy(options);
    let available = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        proxy.server.once("error", failed);
        proxy.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          proxy.server.off("error", failed);
          resolve();
        });
      });
      try {
        const address = proxy.server.address();
        if (!address || typeof address === "string") throw new Error("Managed HA proxy address is unavailable.");
        if (!await (options.fetchPortBlocked ?? fetchPortBlocked)(address.port)) { available = true; break; }
      } catch (error) {
        await new Promise<void>(resolve => proxy.server.close(() => resolve()));
        throw error;
      }
      await new Promise<void>((resolve, reject) => proxy.server.close(error => error ? reject(error) : resolve()));
    }
    if (!available) throw new Error("Unable to allocate a managed HA port accepted by Fetch.");
    proxy.server.on("error", error => {
      proxy.failed = error;
      proxy.audit("listener", "failed");
      try { proxy.options.onError?.(error); }
      catch { proxy.audit("error-handler", "failed"); }
      finally { void proxy.close().catch(() => undefined); }
    });
    proxy.audit("listen", "committed");
    return proxy;
  }

  get baseUrl(): string {
    const address = this.server.address();
    if (this.closing || this.failed || !address || typeof address === "string") throw new Error("Managed HA proxy is not available.");
    return `http://127.0.0.1:${address.port}`;
  }

  setTarget(target?: ManagedHaTarget): void {
    if (this.closing || this.failed) throw new Error("Managed HA proxy is not available.");
    const next = target ? checkedTarget(target) : undefined;
    if (next?.address !== this.target?.address || next?.port !== this.target?.port) {
      for (const { client, upstream } of this.connections) { client.destroy(); upstream.destroy(); }
    }
    this.target = next;
    this.audit("set-target", "committed");
  }

  private accept(client: Socket): void {
    const target = this.target;
    if (this.closing || !target || this.connections.size >= this.maxConnections) {
      client.destroy();
      this.audit("connect", "rejected");
      return;
    }
    let upstream: Socket;
    try { upstream = this.connect(target); }
    catch { client.destroy(); this.audit("connect", "failed"); return; }
    const pair: Connection = { client, upstream, clientClosed: false, upstreamClosed: false };
    this.connections.add(pair);
    const destroy = () => { client.destroy(); upstream.destroy(); };
    let failed = false;
    const fail = (action: string) => { if (!failed) { failed = true; this.audit(action, "failed"); } destroy(); };
    const finish = () => { if (pair.clientClosed && pair.upstreamClosed) this.connections.delete(pair); };
    client.on("error", () => fail("stream"));
    upstream.on("error", () => fail("stream"));
    client.on("timeout", () => fail("timeout"));
    upstream.on("timeout", () => fail("timeout"));
    client.on("close", () => { pair.clientClosed = true; finish(); });
    upstream.on("close", () => { pair.upstreamClosed = true; finish(); });
    client.setTimeout(this.idleTimeoutMs);
    upstream.setTimeout(this.idleTimeoutMs);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.target = undefined;
    this.closing = new Promise<void>((resolve, reject) => {
      this.server.close(error => {
        if (error) { this.audit("close", "failed"); reject(error); return; }
        this.audit("close", "committed");
        resolve();
      });
      for (const { client, upstream } of this.connections) { client.destroy(); upstream.destroy(); }
    });
    return this.closing;
  }

  private audit(action: string, outcome: "committed" | "rejected" | "failed"): void {
    recordDataMutationAudit({ group: "xiaomi-home", event: `home_assistant_proxy_${action.replaceAll("-", "_")}`,
      owner: "home-assistant-loopback-proxy", action, target: { type: "service", id: "managed-ha-loopback" },
      dataSource: { kind: "runtime", id: "managed-ha-loopback" }, outcome });
  }
}
