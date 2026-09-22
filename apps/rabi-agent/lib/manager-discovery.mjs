import net from "node:net";

export const SERVICE_TYPE = "_rabiroute._tcp";
export const DISCOVERY_PATH = "/.well-known/rabiroute-manager";
const MAX_CANDIDATES = 32;
function text(value) { return Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value ?? "").trim(); }
function isLan(host) {
  if (net.isIP(host) === 4) { const [a, b] = host.split(".").map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  if (net.isIP(host) === 6) { const first = Number.parseInt(host.split(":", 1)[0] || "0", 16); return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; }
  return false;
}
export async function readPublicJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { redirect: "error", signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Manager public identity is unavailable.");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new Error("Manager public identity exceeds limit."); } chunks.push(Buffer.from(part.value)); } } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function verifyPublicEndpoint(managerUrl, { fetchImpl = fetch, guid, generation, instance, signal = AbortSignal.timeout(5000) } = {}) {
  const url = new URL(managerUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Manager requires an explicit HTTP(S) origin.");
  const document = await readPublicJson(fetchImpl, `${url.origin}${DISCOVERY_PATH}`, signal);
  const identity = document?.data;
  if (document?.code !== 0 || String(identity?.protocolVersion) !== "1" || !identity.guid || !identity.applicationGenerationId || !identity.managerInstanceId) throw new Error("Manager discovery identity is invalid.");
  if ((guid && identity.guid !== guid) || (generation && identity.applicationGenerationId !== generation) || (instance && identity.managerInstanceId !== instance)) throw new Error("Manager discovery identity mismatch.");
  return { managerUrl: url.origin, guid: identity.guid, generation: identity.applicationGenerationId, instance: identity.managerInstanceId };
}

export async function discoverManager({ browse, fetchImpl = fetch, expected = {}, timeoutMs = 5000 } = {}) {
  // A generation is ephemeral. Only the enrolled stable identity may select a new generation.
  if (!expected.guid) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  let bonjour; let browser;
  try {
    if (!browse) {
      const { Bonjour } = await import("bonjour-service"); bonjour = new Bonjour();
      browse = () => new Promise(resolve => {
        const records = []; browser = bonjour.find({ type: "rabiroute", protocol: "tcp" });
        const timer = setTimeout(() => resolve(records), Math.min(1000, timeoutMs / 3));
        browser.on("up", record => { if (records.length < MAX_CANDIDATES) records.push(record); });
        browser.on("error", () => { clearTimeout(timer); resolve(records); });
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(records); }, { once: true });
      });
    }
    const records = await Promise.race([browse({ signal }), new Promise(resolve => signal.addEventListener("abort", () => resolve([]), { once: true }))]);
    const candidates = [];
    for (const record of (records || []).slice(0, MAX_CANDIDATES)) {
      const txt = record.txt || {}; const guid = text(txt.guid); const generation = text(txt.generation || txt.applicationGenerationId); const instance = text(txt.instance || txt.managerInstanceId);
      if (text(txt.protocol || txt.version) !== "1" || guid !== expected.guid || !generation || !instance || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
      for (const host of [...new Set((record.addresses || []).map(String).filter(isLan))]) {
        if (candidates.length >= MAX_CANDIDATES) break;
        candidates.push({ managerUrl: `http://${net.isIP(host) === 6 ? `[${host}]` : host}:${record.port}`, guid, generation, instance });
      }
    }
    let cursor = 0; const found = new Map();
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (!signal.aborted && cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try { const verified = await verifyPublicEndpoint(candidate.managerUrl, { ...candidate, fetchImpl, signal }); found.set(`${verified.managerUrl}|${verified.generation}|${verified.instance}`, verified); } catch { /* Untrusted advertisements are hints, never authority. */ }
      }
    }));
    // Multiple live origins (including multiple interfaces) are ambiguous, not a preference race.
    return !signal.aborted && found.size === 1 ? [...found.values()][0] : null;
  } finally { browser?.stop(); bonjour?.destroy(); }
}
export function createDiscoveryCooldown(minMs = 10_000) {
  let last = -Infinity; let inFlight;
  return async discover => { if (inFlight) return inFlight; if (Date.now() - last < minMs) return null; last = Date.now(); inFlight = Promise.resolve().then(discover).finally(() => { inFlight = undefined; }); return inFlight; };
}
