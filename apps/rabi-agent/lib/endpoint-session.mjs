import { createTimeoutSettings } from "./timeout-settings.mjs";
import fs from "node:fs";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { discoverManager, createDiscoveryCooldown, verifyPublicEndpoint } from "./manager-discovery.mjs";

const endpointKeys = ["managerUrl", "managerGuid", "applicationGenerationId", "managerInstanceId"];
export function businessReady(meta) { return meta?.health?.live === true && ["healthy", "degraded"].includes(meta.health.state); }
export function sameIdentity(a, b) { return (!a?.rabiGuid || !b?.rabiGuid || a.rabiGuid === b.rabiGuid) && a?.applicationGenerationId === b?.applicationGenerationId && a?.managerInstanceId === b?.managerInstanceId; }

class EndpointConfigurationError extends Error {}
export class EndpointAuthenticationError extends Error {}

async function acquireEndpointWriter(configPath) {
  // Resolve symlink/directory aliases before hashing and writing. Atomic rename must
  // replace the actual config, not turn a config symlink into an independent copy.
  const canonical = fs.realpathSync.native(configPath);
  const hash = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  // No pathname socket: probe-then-unlink recovery can race another successful
  // bind and remove its live socket. Both choices below are kernel-only owners;
  // process death releases them without any stale file/recovery lock to remove.
  // Unix loopback hash collisions fail conservatively as busy, never steal ownership.
  const address = process.platform === "win32"
    ? { path: `\\\\.\\pipe\\rabi-agent-endpoint-${hash}` }
    : { host: "127.0.0.1", port: 49152 + (Number.parseInt(hash.slice(0, 8), 16) % 16384), exclusive: true };
  const owner = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = error => {
      owner.removeListener("listening", listening);
      reject(error.code === "EADDRINUSE"
        ? new EndpointConfigurationError("Endpoint configuration is busy; retry the read explicitly.") : error);
    };
    const listening = () => { owner.removeListener("error", failed); resolve(); };
    owner.once("error", failed); owner.once("listening", listening);
    owner.listen(address);
  });
  return { canonical, release: () => new Promise((resolve, reject) => owner.close(error => error ? reject(error) : resolve())) };
}

/** Endpoint hints are not business state. Merge only a verified endpoint into the actual config. */
async function persistEndpoint(configPath, original, next) {
  if (!configPath) return;
  // Old .endpoint-lock files are inert diagnostics. Never infer their owner died
  // or delete them: mixed-version processes must be stopped before upgrading.
  const owner = await acquireEndpointWriter(configPath);
  const temporary = `${owner.canonical}.${randomUUID()}.tmp`;
  try {
    const current = JSON.parse(fs.readFileSync(owner.canonical, "utf8"));
    if (current.nodeId !== original.nodeId || current.nodeCredential !== original.nodeCredential || endpointKeys.some(key => current[key] !== original[key])) throw new EndpointConfigurationError("Endpoint configuration changed concurrently; reload it before continuing.");
    const merged = { ...current }; for (const key of endpointKeys) merged[key] = next[key];
    if (next.timeoutOverridesCache !== undefined) merged.timeoutOverridesCache = next.timeoutOverridesCache;
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, owner.canonical);
  } finally { try { fs.rmSync(temporary, { force: true }); } finally { await owner.release(); } }
}

/** Existing trusted-LAN contract: public GUID avoids mistakes, not malicious peer impersonation. */
export function createEndpointSession({ config, configPath, fetchImpl = fetch, discover = discoverManager, timeoutMs = 5000, cooldownMs = 10_000, timeoutSettings = createTimeoutSettings(config?.timeoutOverridesCache ?? config?.timeoutOverrides) } = {}) {
  let current = { ...config }; let inFlight;
  const rediscover = createDiscoveryCooldown(cooldownMs);
  async function verify(origin, expected = {}) {
    const signal = AbortSignal.timeout(timeoutSettings.get("agent.client.discovery", timeoutMs));
    let candidate;
    try { candidate = await verifyPublicEndpoint(origin, { fetchImpl, guid: current.managerGuid, ...expected, signal }); }
    catch (error) {
      if (current.managerGuid) throw error;
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw error;
      candidate = { managerUrl: url.origin };
    }
    if (!current.nodeCredential || !current.nodeId) throw new Error("Endpoint verification requires an enrolled node identity.");
    const headers = { authorization: `Bearer ${current.nodeCredential}`, accept: "application/json" };
    const response = await fetchImpl(`${candidate.managerUrl}/api/lan-agent/self`, { headers, redirect: "error", signal });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new EndpointAuthenticationError(`Node credential rejected (HTTP ${response.status}). Existing node ID and Agent bindings are preserved; repair this node's credential rather than creating another node or a controlling Agent.`);
      }
      throw new Error("Manager node identity verification failed.");
    }
    const body = await response.json(); const self = body?.data;
    if (body?.code !== 0 || self?.nodeId !== current.nodeId || (candidate.guid && self.guid !== candidate.guid) || (candidate.generation && self.applicationGenerationId !== candidate.generation) || (candidate.instance && self.managerInstanceId !== candidate.instance)) throw new Error("Manager node identity mismatch.");
    candidate = { ...candidate, guid: self.guid, generation: self.applicationGenerationId, instance: self.managerInstanceId };
    const metaResponse = await fetchImpl(`${candidate.managerUrl}/meta`, { headers, redirect: "error", signal });
    if (!metaResponse.ok) throw new Error("Manager metadata verification failed.");
    const rawMeta = await metaResponse.json();
    // Manager returns an envelope; injected legacy transports may return the identity directly.
    const meta = rawMeta?.data && typeof rawMeta.data === "object" ? rawMeta.data : rawMeta;
    if ((meta.rabiGuid && candidate.guid && meta.rabiGuid !== candidate.guid)
      || meta.applicationGenerationId !== candidate.generation || meta.managerInstanceId !== candidate.instance) throw new Error("Manager metadata identity mismatch.");
    // Recheck credentialed identity after metadata; never persist an intervening generation.
    const after = await verifyPublicEndpoint(candidate.managerUrl, { fetchImpl, guid: candidate.guid, generation: candidate.generation, instance: candidate.instance, signal });
    timeoutSettings.adopt(meta);
    const next = { ...current, managerUrl: candidate.managerUrl, managerGuid: candidate.guid, applicationGenerationId: candidate.generation, managerInstanceId: candidate.instance, ...(meta.timeoutOverrides !== undefined || current.timeoutOverridesCache !== undefined ? { timeoutOverridesCache: timeoutSettings.snapshot() } : {}) };
    if (endpointKeys.some(key => next[key] !== current[key]) || JSON.stringify(next.timeoutOverridesCache) !== JSON.stringify(current.timeoutOverridesCache)) await persistEndpoint(configPath, current, next);
    current = next;
    return { ...after, meta, config: { ...current } };
  }
  async function resolve({ diagnostic = false, forceDiscovery = false } = {}) {
    let endpoint;
    if (!forceDiscovery) {
      try { endpoint = await verify(current.managerUrl); }
      catch (error) {
        if (error instanceof EndpointConfigurationError || error instanceof EndpointAuthenticationError) throw error;
        /* One bounded discovery may recover a stale address. */
      }
    }
    if (!endpoint) {
      // Legacy enrolled configurations may have no persisted GUID. Preserve their
      // explicit trusted origin as the only fallback; never broaden this into
      // unauthenticated LAN discovery.
      if (!current.managerGuid) {
        if (!current.managerUrl) throw new Error("Manager endpoint unavailable; stable identity or secure discovery is unavailable. Reconnect using an explicit trusted address.");
        endpoint = await verify(current.managerUrl);
      } else {
        if (new URL(current.managerUrl).protocol === "https:") throw new Error("Manager endpoint unavailable; stable identity or secure discovery is unavailable. Reconnect using an explicit trusted address.");
        const candidate = await rediscover(() => discover({ expected: { guid: current.managerGuid }, fetchImpl, timeoutMs: timeoutSettings.get("agent.client.discovery", timeoutMs) }));
        if (!candidate) throw new Error("Manager endpoint discovery failed or is cooling down.");
        if (new URL(candidate.managerUrl).protocol !== new URL(current.managerUrl).protocol) throw new Error("Manager discovery protocol downgrade rejected.");
        endpoint = await verify(candidate.managerUrl, { generation: candidate.generation, instance: candidate.instance });
      }
    }
    return endpoint;
  }
  return {
    get config() { return { ...current }; },
    async ensure(options = {}) {
      if (!inFlight) inFlight = resolve(options).finally(() => { inFlight = undefined; });
      const result = await inFlight;
      if (!options.diagnostic && !businessReady(result.meta)) throw new Error("Manager generation is not ready for business requests.");
      return result;
    },
    async identity(origin) {
      const publicIdentity = await verifyPublicEndpoint(origin, { fetchImpl, guid: current.managerGuid, signal: AbortSignal.timeout(timeoutSettings.get("agent.client.discovery", timeoutMs)) });
      const response = await fetchImpl(`${publicIdentity.managerUrl}/meta`, { headers: { authorization: `Bearer ${current.nodeCredential}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutSettings.get("agent.client.discovery", timeoutMs)) });
      if (!response.ok) throw new Error("Manager metadata verification failed.");
      const rawMeta = await response.json();
      const meta = rawMeta?.data && typeof rawMeta.data === "object" ? rawMeta.data : rawMeta;
      if (meta.rabiGuid !== publicIdentity.guid || meta.applicationGenerationId !== publicIdentity.generation || meta.managerInstanceId !== publicIdentity.instance) throw new Error("Manager metadata identity mismatch.");
      return meta;
    }
  };
}
