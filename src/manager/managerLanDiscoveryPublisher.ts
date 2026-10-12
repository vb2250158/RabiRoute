import { EventEmitter } from "node:events";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import {
  MANAGER_DISCOVERY_PATH,
  MANAGER_DISCOVERY_PROTOCOL_VERSION,
  MANAGER_DISCOVERY_SERVICE_TYPE
} from "./managerLanDiscovery.js";

export type ManagerDiscoveryInterfaceStatus = Readonly<{
  name: string;
  address?: string;
  state: "starting" | "published" | "failed" | "stopped";
  message?: string;
}>;

export type ManagerDiscoveryStatus = Readonly<{
  state: "disabled" | "starting" | "published" | "failed" | "stopped";
  serviceType: "_rabiroute._tcp.local";
  port?: number;
  message?: string;
  // Local publication evidence, not proof that a remote client received an announcement.
  interfaces?: readonly ManagerDiscoveryInterfaceStatus[];
}>;

type BonjourService = EventEmitter & Readonly<{
  stop(callback?: () => void): void;
}>;

type BonjourInstance = Readonly<{
  publish(options: Readonly<{
    name: string;
    type: string;
    protocol: "tcp";
    port: number;
    probe: false;
    txt: Readonly<Record<string, string>>;
  }>): BonjourService;
  destroy(): void | Promise<void>;
}>;

export type BonjourInterfaceOptions = Readonly<{ interface?: string; bind?: string }>;
export type BonjourFactory = (
  onError: (error: Error) => void,
  options?: BonjourInterfaceOptions
) => BonjourInstance | Promise<BonjourInstance>;

type DiscoveryNetworkInterfaces = Readonly<Record<string, readonly Readonly<{
  address: string;
  family: string | number;
  internal: boolean;
}>[] | undefined>>;

export type ManagerDiscoveryPublisherDependencies = Readonly<{
  factory?: BonjourFactory;
  interfaces?: () => DiscoveryNetworkInterfaces;
}>;

export type ManagerDiscoveryPublisher = Readonly<{
  status(): ManagerDiscoveryStatus;
  stop(): Promise<void>;
}>;

type InterfacePublication = {
  status: ManagerDiscoveryInterfaceStatus;
  bonjour?: BonjourInstance;
  service?: BonjourService;
};

const SERVICE_TYPE = "_rabiroute._tcp.local" as const;

async function defaultBonjourFactory(
  onError: (error: Error) => void,
  options: BonjourInterfaceOptions = {}
): Promise<BonjourInstance> {
  const { Bonjour } = await import("bonjour-service");
  // The dependency forwards transport options, but incorrectly declares ServiceConfig here.
  const bonjour = new Bonjour(options as ConstructorParameters<typeof Bonjour>[0], onError);
  // bonjour-service 1.4.4 forwards query-response errors only and ignores announce
  // callback errors. Observe the transport without changing dependency files.
  type MdnsTransport = EventEmitter & { respond: (...args: unknown[]) => void };
  const mdns = (bonjour as unknown as { server: { mdns: MdnsTransport } }).server.mdns;
  mdns.on("error", onError);
  mdns.on("warning", onError);
  const respond = mdns.respond.bind(mdns);
  mdns.respond = (...args: unknown[]): void => {
    const callback = typeof args.at(-1) === "function" ? args.pop() as (...values: unknown[]) => void : undefined;
    respond(...args, (error?: Error, ...values: unknown[]) => {
      if (error) onError(error);
      callback?.(error, ...values);
    });
  };
  return {
    publish: publication => bonjour.publish(publication) as unknown as BonjourService,
    destroy: () => new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1_000);
      try { bonjour.destroy(() => { clearTimeout(timeout); resolve(); }); }
      catch (error) { clearTimeout(timeout); throw error; }
    })
  };
}

function eligibleInterfaces(interfaces: DiscoveryNetworkInterfaces): ManagerDiscoveryInterfaceStatus[] {
  const seen = new Set<string>();
  const result: ManagerDiscoveryInterfaceStatus[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4) || !isIPv4(entry.address)) continue;
      if (entry.address.startsWith("127.") || entry.address === "0.0.0.0" || seen.has(entry.address)) continue;
      seen.add(entry.address);
      result.push({ name, address: entry.address, state: "starting" });
    }
  }
  return result;
}

async function releasePublication(publication: InterfacePublication): Promise<void> {
  if (publication.service) {
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 1_000);
      // Keep the deadline alive while callers await stop, even if a socket never calls back.
      try { publication.service!.stop(finish); }
      catch { finish(); }
    });
    publication.service = undefined;
  }
  try { await publication.bonjour?.destroy(); } catch { }
  publication.bonjour = undefined;
}

export async function startManagerDiscoveryPublisher(
  options: Readonly<{
    port: number;
    applicationGenerationId: string;
    managerInstanceId: string;
    guid?: string;
    onStatus?: (status: ManagerDiscoveryStatus) => void;
  }>,
  dependencies?: BonjourFactory | ManagerDiscoveryPublisherDependencies
): Promise<ManagerDiscoveryPublisher> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("Manager DNS-SD publication requires the actual listener port.");
  }
  // Preserve the original injected single-factory seam. Production and object-form
  // dependencies use per-interface publication; no OS-selected production fallback.
  const legacyFactory = typeof dependencies === "function" ? dependencies : undefined;
  const injected = typeof dependencies === "object" ? dependencies : undefined;
  const factory = legacyFactory ?? injected?.factory ?? defaultBonjourFactory;
  const publications: InterfacePublication[] = (legacyFactory
    ? [{ name: "default", state: "starting" as const }]
    : eligibleInterfaces((injected?.interfaces ?? networkInterfaces)())
  ).map(status => ({ status }));
  let stopped = false;
  let stopFlight: Promise<void> | undefined;
  let current: ManagerDiscoveryStatus;
  const update = (): void => {
    const interfaces = Object.freeze(publications.map(publication => Object.freeze({ ...publication.status })));
    const published = interfaces.some(iface => iface.state === "published");
    const starting = interfaces.some(iface => iface.state === "starting");
    const failures = interfaces.filter(iface => iface.state === "failed");
    current = Object.freeze({
      state: stopped ? "stopped" : published ? "published" : starting ? "starting" : "failed",
      serviceType: SERVICE_TYPE,
      port: options.port,
      interfaces,
      ...(!stopped && !interfaces.length
        ? { message: "No external IPv4 interface is available for Manager DNS-SD publication." }
        : failures.length ? {
          message: failures.map(iface => `${iface.name}${iface.address ? ` (${iface.address})` : ""}: ${iface.message}`).join("; ")
        } : {})
    });
    options.onStatus?.(current);
  };
  update();
  for (const publication of publications) {
    const onError = (error: Error): void => {
      if (stopped) return;
      publication.status = { ...publication.status, state: "failed", message: error.message };
      update();
    };
    try {
      const created = factory(onError, publication.status.address
        // Binding to ANY preserves reception of multicast queries on Windows;
        // `interface` selects membership AND the actual multicast egress address.
        ? { interface: publication.status.address, bind: "0.0.0.0" }
        : undefined);
      publication.bonjour = created instanceof Promise ? await created : created;
      publication.service = publication.bonjour.publish({
        name: `RabiRoute-${options.managerInstanceId.slice(0, 12)}`,
        type: MANAGER_DISCOVERY_SERVICE_TYPE,
        protocol: "tcp",
        port: options.port,
        // All sockets publish the same generation/instance, not competing services.
        // DNS-SD is discovery only: well-known/meta identity and auth stay unchanged.
        probe: false,
        txt: {
          protocol: String(MANAGER_DISCOVERY_PROTOCOL_VERSION),
          path: MANAGER_DISCOVERY_PATH,
          applicationGenerationId: options.applicationGenerationId,
          managerInstanceId: options.managerInstanceId,
          ...(options.guid ? { guid: options.guid } : {})
        }
      });
      publication.service.once("up", () => {
        if (stopped || publication.status.state === "failed") return;
        publication.status = { ...publication.status, state: "published" };
        update();
      });
      publication.service.on("error", onError);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      await releasePublication(publication);
    }
  }

  return Object.freeze({
    status: () => current,
    stop(): Promise<void> {
      if (stopFlight) return stopFlight;
      stopped = true;
      stopFlight = (async () => {
        await Promise.all(publications.map(releasePublication));
        for (const publication of publications) {
          publication.status = { ...publication.status, state: "stopped" };
        }
        update();
      })();
      return stopFlight;
    }
  });
}
