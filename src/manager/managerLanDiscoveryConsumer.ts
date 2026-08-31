import net from "node:net";
import {
  MANAGER_DISCOVERY_PATH,
  MANAGER_DISCOVERY_PROTOCOL_VERSION,
  MANAGER_DISCOVERY_SERVICE_TYPE,
  type ManagerLanDiscoveryDocument
} from "./managerLanDiscovery.js";

export type ManagerDiscoveryServiceRecord = Readonly<{
  name?: string;
  host?: string;
  port: number;
  addresses?: readonly string[];
  txt?: Readonly<Record<string, string | Buffer | undefined>>;
}>;

export type DiscoveredManagerEndpoint = ManagerLanDiscoveryDocument & Readonly<{
  host: string;
  port: number;
  baseUrl: string;
}>;

export type ManagerDiscoveryIssue = Readonly<{
  serviceName: string;
  code: "invalid_txt" | "unreachable" | "identity_mismatch" | "invalid_document" | "ambiguous_guid" | "limit_exceeded";
  message: string;
}>;

export type ManagerDiscoveryResult = Readonly<{
  observedServices: number;
  endpoints: readonly DiscoveredManagerEndpoint[];
  issues: readonly ManagerDiscoveryIssue[];
}>;

type WellKnownFetcher = (url: string) => Promise<unknown>;

const MAX_DISCOVERY_RECORDS = 32;
const MAX_HOSTS_PER_RECORD = 8;
const MAX_DISCOVERY_CONCURRENCY = 4;
const MAX_WELL_KNOWN_BYTES = 64 * 1024;

function text(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value ?? "").trim();
}

function serviceIdentity(record: ManagerDiscoveryServiceRecord): Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
}> | null {
  const protocol = text(record.txt?.protocol);
  const discoveryPath = text(record.txt?.path);
  const applicationGenerationId = text(record.txt?.applicationGenerationId);
  const managerInstanceId = text(record.txt?.managerInstanceId);
  if (protocol !== String(MANAGER_DISCOVERY_PROTOCOL_VERSION)
    || discoveryPath !== MANAGER_DISCOVERY_PATH
    || !applicationGenerationId
    || !managerInstanceId) return null;
  return { applicationGenerationId, managerInstanceId };
}

function hostForUrl(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function isLanAddress(host: string): boolean {
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (family === 6) {
    const first = Number.parseInt(host.split(":", 1)[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function usableHosts(record: ManagerDiscoveryServiceRecord): string[] {
  const values = (record.addresses ?? [])
    .map(value => String(value || "").trim().replace(/%[^%]+$/, ""))
    .filter(isLanAddress);
  return [...new Set(values)].sort((left, right) => {
    const leftIp = net.isIP(left);
    const rightIp = net.isIP(right);
    const leftRank = leftIp === 4 ? 0 : leftIp === 6 ? 1 : 2;
    const rightRank = rightIp === 4 ? 0 : rightIp === 6 ? 1 : 2;
    return leftRank - rightRank || left.localeCompare(right);
  }).slice(0, MAX_HOSTS_PER_RECORD);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

function parseDocument(value: unknown): ManagerLanDiscoveryDocument | null {
  const body = value && typeof value === "object" ? value as Record<string, any> : {};
  const candidate = body.data && typeof body.data === "object" ? body.data as Record<string, any> : {};
  if (body.code !== 0
    || candidate.protocolVersion !== MANAGER_DISCOVERY_PROTOCOL_VERSION
    || !String(candidate.applicationGenerationId || "").trim()
    || !String(candidate.managerInstanceId || "").trim()
    || !String(candidate.guid || "").trim()
    || !String(candidate.name || "").trim()
    || !String(candidate.computerName || "").trim()
    || candidate.deviceType !== "RabiRoute Manager"
    || !String(candidate.version || "").trim()) return null;
  return Object.freeze({
    protocolVersion: MANAGER_DISCOVERY_PROTOCOL_VERSION,
    applicationGenerationId: String(candidate.applicationGenerationId),
    managerInstanceId: String(candidate.managerInstanceId),
    guid: String(candidate.guid),
    name: String(candidate.name),
    computerName: String(candidate.computerName),
    deviceType: "RabiRoute Manager",
    version: String(candidate.version)
  });
}

async function validateRecord(
  record: ManagerDiscoveryServiceRecord,
  fetchWellKnown: WellKnownFetcher
): Promise<{ endpoint?: DiscoveredManagerEndpoint; issue?: ManagerDiscoveryIssue }> {
  const serviceName = String(record.name || record.host || "unknown-service");
  const identity = serviceIdentity(record);
  if (!identity || !Number.isInteger(record.port) || record.port < 1 || record.port > 65_535) {
    return { issue: { serviceName, code: "invalid_txt", message: "DNS-SD TXT identity or actual port is invalid." } };
  }
  const hosts = usableHosts(record);
  if (!hosts.length) {
    return { issue: { serviceName, code: "unreachable", message: "DNS-SD service published no usable address." } };
  }
  let lastInvalidDocument = false;
  for (const host of hosts) {
    const baseUrl = `http://${hostForUrl(host)}:${record.port}`;
    let body: unknown;
    try {
      body = await fetchWellKnown(`${baseUrl}${MANAGER_DISCOVERY_PATH}`);
    } catch {
      continue;
    }
    const document = parseDocument(body);
    if (!document) {
      lastInvalidDocument = true;
      continue;
    }
    if (document.applicationGenerationId !== identity.applicationGenerationId
      || document.managerInstanceId !== identity.managerInstanceId) {
      return { issue: { serviceName, code: "identity_mismatch", message: "DNS-SD and well-known Manager identities do not match." } };
    }
    return { endpoint: Object.freeze({ ...document, host, port: record.port, baseUrl }) };
  }
  return {
    issue: {
      serviceName,
      code: lastInvalidDocument ? "invalid_document" : "unreachable",
      message: lastInvalidDocument
        ? "Manager well-known document is invalid."
        : "Manager well-known endpoint did not respond."
    }
  };
}

export async function validateManagerDiscoveryRecords(
  records: readonly ManagerDiscoveryServiceRecord[],
  fetchWellKnown: WellKnownFetcher
): Promise<ManagerDiscoveryResult> {
  const boundedRecords = records.slice(0, MAX_DISCOVERY_RECORDS);
  const validated = await mapWithConcurrency(boundedRecords, MAX_DISCOVERY_CONCURRENCY, record => validateRecord(record, fetchWellKnown));
  const issues: ManagerDiscoveryIssue[] = validated.flatMap(item => item.issue ? [item.issue] : []);
  if (records.length > boundedRecords.length) {
    issues.push({
      serviceName: MANAGER_DISCOVERY_SERVICE_TYPE,
      code: "limit_exceeded",
      message: `Manager discovery ignored ${records.length - boundedRecords.length} services beyond the bounded LAN budget.`
    });
  }
  const candidates = validated.flatMap(item => item.endpoint ? [item.endpoint] : []);
  const byGuid = new Map<string, DiscoveredManagerEndpoint[]>();
  for (const endpoint of candidates) {
    const group = byGuid.get(endpoint.guid) ?? [];
    group.push(endpoint);
    byGuid.set(endpoint.guid, group);
  }
  const endpoints: DiscoveredManagerEndpoint[] = [];
  for (const [guid, group] of byGuid) {
    const identities = new Set(group.map(item => `${item.applicationGenerationId}\u0000${item.managerInstanceId}`));
    const authorities = new Set(group.map(item => item.baseUrl));
    if (identities.size > 1 || authorities.size > 1) {
      issues.push({
        serviceName: guid,
        code: "ambiguous_guid",
        message: "One RabiRoute GUID published competing Manager generations or network authorities."
      });
      continue;
    }
    endpoints.push(group[0]!);
  }
  return Object.freeze({
    observedServices: records.length,
    endpoints: Object.freeze(endpoints.sort((left, right) => left.guid.localeCompare(right.guid))),
    issues: Object.freeze(issues)
  });
}

type BonjourBrowser = Readonly<{
  on(event: "up", listener: (service: ManagerDiscoveryServiceRecord) => void): BonjourBrowser;
  stop(): void;
}>;

type BonjourInstance = Readonly<{
  find(options: Readonly<{ type: string; protocol: "tcp" }>): BonjourBrowser;
  destroy(): void;
}>;

async function browseManagerServices(timeoutMs: number): Promise<ManagerDiscoveryServiceRecord[]> {
  const { Bonjour } = await import("bonjour-service");
  let browserError: Error | null = null;
  const bonjour = new Bonjour({}, (error: Error) => { browserError = error; }) as unknown as BonjourInstance;
  const services: ManagerDiscoveryServiceRecord[] = [];
  const browser = bonjour.find({ type: MANAGER_DISCOVERY_SERVICE_TYPE, protocol: "tcp" });
  browser.on("up", service => {
    if (services.length < MAX_DISCOVERY_RECORDS) services.push(service);
  });
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  try { browser.stop(); } catch { }
  try { bonjour.destroy(); } catch { }
  if (browserError && !services.length) throw browserError;
  return services;
}

async function fetchWellKnownJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_WELL_KNOWN_BYTES) throw new Error("Manager well-known document exceeds the bounded discovery size.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WELL_KNOWN_BYTES) throw new Error("Manager well-known document exceeds the bounded discovery size.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function discoverManagerLanEndpoints(options: Readonly<{
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  browse?: (timeoutMs: number) => Promise<ManagerDiscoveryServiceRecord[]>;
}>): Promise<ManagerDiscoveryResult> {
  const timeoutMs = Math.max(120, Math.min(3_000, Math.floor(options.timeoutMs)));
  const records = await (options.browse ?? browseManagerServices)(timeoutMs);
  const result = await validateManagerDiscoveryRecords(
    records,
    url => fetchWellKnownJson(url, timeoutMs, options.fetchImpl ?? globalThis.fetch)
  );
  if (result.observedServices > 0 && result.endpoints.length === 0) {
    const error = new Error(`Manager DNS-SD services were observed, but none passed generation fencing: ${result.issues.map(issue => issue.code).join(", ")}.`);
    Object.assign(error, { statusCode: 502, discovery: result });
    throw error;
  }
  return result;
}

export async function verifyManagerDiscoveryEndpoint(
  endpoint: DiscoveredManagerEndpoint,
  options: Readonly<{ timeoutMs?: number; fetchImpl?: typeof fetch }> = {}
): Promise<void> {
  const body = await fetchWellKnownJson(
    `${endpoint.baseUrl}${MANAGER_DISCOVERY_PATH}`,
    options.timeoutMs ?? 3_000,
    options.fetchImpl ?? globalThis.fetch
  );
  const document = parseDocument(body);
  if (!document
    || document.guid !== endpoint.guid
    || document.applicationGenerationId !== endpoint.applicationGenerationId
    || document.managerInstanceId !== endpoint.managerInstanceId) {
    const error = new Error("Remote Manager generation changed after discovery.");
    Object.assign(error, { statusCode: 409 });
    throw error;
  }
}
