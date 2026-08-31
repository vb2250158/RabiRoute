import { EventEmitter } from "node:events";
import {
  MANAGER_DISCOVERY_PATH,
  MANAGER_DISCOVERY_PROTOCOL_VERSION,
  MANAGER_DISCOVERY_SERVICE_TYPE
} from "./managerLanDiscovery.js";

export type ManagerDiscoveryStatus = Readonly<{
  state: "disabled" | "starting" | "published" | "failed" | "stopped";
  serviceType: "_rabiroute._tcp.local";
  port?: number;
  message?: string;
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
    txt: Readonly<Record<string, string>>;
  }>): BonjourService;
  destroy(): void;
}>;

export type BonjourFactory = (onError: (error: Error) => void) => BonjourInstance;

export type ManagerDiscoveryPublisher = Readonly<{
  status(): ManagerDiscoveryStatus;
  stop(): Promise<void>;
}>;

const SERVICE_TYPE = "_rabiroute._tcp.local" as const;

async function defaultBonjourFactory(onError: (error: Error) => void): Promise<BonjourInstance> {
  const { Bonjour } = await import("bonjour-service");
  return new Bonjour({}, onError) as unknown as BonjourInstance;
}

export async function startManagerDiscoveryPublisher(
  options: Readonly<{
    port: number;
    applicationGenerationId: string;
    managerInstanceId: string;
    onStatus?: (status: ManagerDiscoveryStatus) => void;
  }>,
  factory?: BonjourFactory
): Promise<ManagerDiscoveryPublisher> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("Manager DNS-SD publication requires the actual listener port.");
  }
  let current: ManagerDiscoveryStatus = Object.freeze({
    state: "starting",
    serviceType: SERVICE_TYPE,
    port: options.port
  });
  let stopped = false;
  const update = (status: ManagerDiscoveryStatus): void => {
    current = Object.freeze(status);
    options.onStatus?.(current);
  };
  update(current);
  const onError = (error: Error): void => update({
    state: "failed",
    serviceType: SERVICE_TYPE,
    port: options.port,
    message: error.message
  });
  const bonjour = factory ? factory(onError) : await defaultBonjourFactory(onError);
  let service: BonjourService;
  try {
    service = bonjour.publish({
      name: `RabiRoute-${options.managerInstanceId.slice(0, 12)}`,
      type: MANAGER_DISCOVERY_SERVICE_TYPE,
      protocol: "tcp",
      port: options.port,
      txt: {
        protocol: String(MANAGER_DISCOVERY_PROTOCOL_VERSION),
        path: MANAGER_DISCOVERY_PATH,
        applicationGenerationId: options.applicationGenerationId,
        managerInstanceId: options.managerInstanceId
      }
    });
  } catch (error) {
    try { bonjour.destroy(); } catch { }
    throw error;
  }
  service.once("up", () => update({
    state: "published",
    serviceType: SERVICE_TYPE,
    port: options.port
  }));
  service.on("error", onError);

  return Object.freeze({
    status: () => current,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(finish, 1_000);
        timeout.unref();
        try { service.stop(finish); }
        catch { finish(); }
      });
      try { bonjour.destroy(); } catch { }
      update({ state: "stopped", serviceType: SERVICE_TYPE, port: options.port });
    }
  });
}
