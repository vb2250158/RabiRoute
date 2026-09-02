import http from "node:http";

// WHATWG Fetch blocks these ports before a request reaches the network stack.
// A Manager endpoint must be usable by the WebGUI and SDK clients, so an
// OS-assigned listener on one of these ports is not a valid READY endpoint.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6697, 10080
]);

export type ManagerPortPolicy =
  | { mode: "auto" }
  | { mode: "fixed"; port: number }
  | { mode: "preferred"; port: number };

export type ManagerListeningEndpoint = {
  host: string;
  port: number;
  baseUrl: string;
};

export function parseManagerPortPolicy(value: string | undefined): ManagerPortPolicy {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "0") {
    return { mode: "auto" };
  }
  const preferredMatch = /^prefer:(\d+)$/.exec(normalized);
  const port = Number(preferredMatch?.[1] ?? normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`GATEWAY_MANAGER_PORT must be auto, 0, prefer:<port>, or an integer from 1 to 65535; received ${value}.`);
  }
  return preferredMatch ? { mode: "preferred", port } : { mode: "fixed", port };
}

export function managerHostIsLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function listeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port <= 0) {
    throw new Error("RabiRoute Manager listener did not expose a usable TCP port.");
  }
  return address.port;
}

export function managerPortIsFetchSafe(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 && !FETCH_BLOCKED_PORTS.has(port);
}

function closeListeningServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function listenOnAutomaticSafePort(server: http.Server, host: string): Promise<void> {
  const maxAttempts = 128;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await listen(server, 0, host);
    if (managerPortIsFetchSafe(listeningPort(server))) return;
    await closeListeningServer(server);
    if (attempt === maxAttempts) {
      throw new Error(`Windows did not allocate a browser-safe Manager port after ${maxAttempts} attempts.`);
    }
  }
}

function portIsAlreadyInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

export async function listenManagerEndpoint(options: {
  server: http.Server;
  host: string;
  policy: ManagerPortPolicy;
}): Promise<ManagerListeningEndpoint> {
  const { server, host, policy } = options;
  if (policy.mode === "fixed") {
    if (!managerPortIsFetchSafe(policy.port)) {
      throw new Error(`GATEWAY_MANAGER_PORT ${policy.port} is blocked by browser Fetch and cannot publish a usable Manager endpoint.`);
    }
    await listen(server, policy.port, host);
  } else if (policy.mode === "preferred" && managerPortIsFetchSafe(policy.port)) {
    try {
      await listen(server, policy.port, host);
    } catch (error) {
      if (!portIsAlreadyInUse(error)) throw error;
      await listenOnAutomaticSafePort(server, host);
    }
  } else {
    await listenOnAutomaticSafePort(server, host);
  }

  const port = listeningPort(server);
  return {
    host,
    port,
    baseUrl: `http://127.0.0.1:${port}`
  };
}
