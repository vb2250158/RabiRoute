import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { discoverManager, createDiscoveryCooldown, verifyPublicEndpoint } from "./manager-discovery.mjs";

const endpointKeys = ["managerUrl", "managerGuid", "applicationGenerationId", "managerInstanceId"];
export function businessReady(meta) { return meta?.health?.requiredReady === true && ["healthy", "degraded"].includes(meta.health.state) && meta.health.live === true; }
export function sameIdentity(a, b) { return (!a?.rabiGuid || !b?.rabiGuid || a.rabiGuid === b.rabiGuid) && a?.applicationGenerationId === b?.applicationGenerationId && a?.managerInstanceId === b?.managerInstanceId; }

/** Endpoint hints are not business state. Merge only a verified endpoint into the actual config. */
function persistEndpoint(configPath, original, next) {
  if (!configPath) return;
  const lockPath = `${configPath}.endpoint-lock`; let lock;
  try { lock = fs.openSync(lockPath, "wx", 0o600); } catch { throw new Error("Endpoint configuration is busy; retry the read explicitly."); }
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (current.nodeId !== original.nodeId || current.nodeCredential !== original.nodeCredential || endpointKeys.some(key => current[key] !== original[key])) throw new Error("Endpoint configuration changed concurrently; reload it before continuing.");
    const merged = { ...current }; for (const key of endpointKeys) merged[key] = next[key];
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, configPath);
  } finally { try { fs.rmSync(temporary, { force: true }); } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
}

/** Existing trusted-LAN contract: public GUID avoids mistakes, not malicious peer impersonation. */
export function createEndpointSession({ config, configPath, fetchImpl = fetch, discover = discoverManager, timeoutMs = 5000, cooldownMs = 10_000 } = {}) {
  let current = { ...config }; let inFlight;
  const rediscover = createDiscoveryCooldown(cooldownMs);
  async function verify(origin, expected = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
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
    if (!response.ok) throw new Error("Manager node identity verification failed.");
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
    const next = { ...current, managerUrl: candidate.managerUrl, managerGuid: candidate.guid, applicationGenerationId: candidate.generation, managerInstanceId: candidate.instance };
    if (endpointKeys.some(key => next[key] !== current[key])) persistEndpoint(configPath, current, next);
    current = next;
    return { ...after, meta, config: { ...current } };
  }
  async function resolve({ diagnostic = false, forceDiscovery = false } = {}) {
    let endpoint;
    if (!forceDiscovery) { try { endpoint = await verify(current.managerUrl); } catch { /* One bounded discovery may recover a stale address. */ } }
    if (!endpoint) {
      // Legacy enrolled configurations may have no persisted GUID. Preserve their
      // explicit trusted origin as the only fallback; never broaden this into
      // unauthenticated LAN discovery.
      if (!current.managerGuid) {
        if (!current.managerUrl) throw new Error("Manager endpoint unavailable; stable identity or secure discovery is unavailable. Reconnect using an explicit trusted address.");
        endpoint = await verify(current.managerUrl);
      } else {
        if (new URL(current.managerUrl).protocol === "https:") throw new Error("Manager endpoint unavailable; stable identity or secure discovery is unavailable. Reconnect using an explicit trusted address.");
        const candidate = await rediscover(() => discover({ expected: { guid: current.managerGuid }, fetchImpl, timeoutMs }));
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
      const publicIdentity = await verifyPublicEndpoint(origin, { fetchImpl, guid: current.managerGuid, signal: AbortSignal.timeout(timeoutMs) });
      const response = await fetchImpl(`${publicIdentity.managerUrl}/meta`, { headers: { authorization: `Bearer ${current.nodeCredential}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error("Manager metadata verification failed.");
      const meta = await response.json();
      if (meta.rabiGuid !== publicIdentity.guid || meta.applicationGenerationId !== publicIdentity.generation || meta.managerInstanceId !== publicIdentity.instance) throw new Error("Manager metadata identity mismatch.");
      return meta;
    }
  };
}
