import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type InternalManagerHopClaims = Readonly<{
  kind: "peer" | "relay"; generation: string; scope: string; deviceId: string;
  method: string; target: string; nonce: string; issuedAt: number; authenticatedAt?: number;
}>;
type HopInput = Omit<InternalManagerHopClaims, "nonce" | "issuedAt">;
const key = randomBytes(32);
const lifetime = 30_000;
const used = new Map<string, number>();
type OwnedGuard = () => void | boolean;
const issuedGuards = new Map<string, { expiresAt: number; guard: OwnedGuard }>();
let lastCleanup = 0;
const admitted = new WeakMap<IncomingMessage, { proof: string; claims: InternalManagerHopClaims; guard?: OwnedGuard }>();
const domain = "rabi-internal-manager-hop-v1\n";

function validInput(value: HopInput): boolean {
  return (value.kind === "peer" || value.kind === "relay")
    && typeof value.generation === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.generation)
    && typeof value.scope === "string" && /^[a-f0-9]{64}$/.test(value.scope)
    && typeof value.deviceId === "string" && /^[A-Za-z0-9$][A-Za-z0-9$._:-]{0,127}$/.test(value.deviceId)
    && typeof value.method === "string" && /^[A-Z]{1,20}$/.test(value.method)
    && typeof value.target === "string" && value.target.length <= 8192 && value.target.startsWith("/")
    && !value.target.startsWith("//") && !/[\\#\u0000-\u0020\u007f]/.test(value.target)
    && (value.authenticatedAt === undefined || Number.isSafeInteger(value.authenticatedAt) && value.authenticatedAt >= 0 && value.authenticatedAt <= Date.now());
}
function mac(encoded: string): Buffer { return createHmac("sha256", key).update(domain + encoded).digest(); }
function cleanup(now: number): void {
  if (now - lastCleanup < 5000) return;
  for (const [nonce, expires] of used) if (expires < now) used.delete(nonce);
  for (const [nonce, owner] of issuedGuards) if (owner.expiresAt < now) issuedGuards.delete(nonce);
  lastCleanup = now;
}

/** Only authenticated transport owners call this issuer; the key lives in this process. */
export function issueInternalManagerHopHeaders(input: HopInput, guard?: OwnedGuard): Record<string, string> {
  if (!validInput(input)) throw new Error("Invalid internal Manager hop.");
  if (guard?.() === false) throw new Error("Internal Manager hop authority expired.");
  cleanup(Date.now());
  if (issuedGuards.size >= 50_000) throw new Error("Internal Manager hop admission capacity exceeded.");
  const claims: InternalManagerHopClaims = {
    kind: input.kind, generation: input.generation, scope: input.scope, deviceId: input.deviceId,
    method: input.method, target: input.target, nonce: randomBytes(24).toString("base64url"), issuedAt: Date.now(),
    ...(input.authenticatedAt === undefined ? {} : { authenticatedAt: input.authenticatedAt })
  };
  if (guard) issuedGuards.set(claims.nonce, { expiresAt: claims.issuedAt + lifetime + 1000, guard });
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {
    "x-rabilink-internal-hop": encoded + "." + mac(encoded).toString("base64url"),
    "x-rabilink-tunnel-local": input.generation,
    "x-rabilink-tunnel-device-id": input.deviceId,
    [input.kind === "peer" ? "x-rabiroute-peer-proxy" : "x-rabiroute-relay-proxy"]: "1"
  };
}

/** Rechecks live fences even for an admitted request; a nonce cannot admit another request. */
export function validateInternalManagerHop(request: IncomingMessage, expected: { generation: string; scope?: string }): InternalManagerHopClaims | null {
  const address = request.socket.remoteAddress || "";
  if (!(address === "::1" || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address))) return null;
  const proof = request.headers["x-rabilink-internal-hop"];
  if (typeof proof !== "string" || proof.length > 16_384) return null;
  const prior = admitted.get(request);
  let claims: InternalManagerHopClaims;
  if (prior) {
    if (prior.proof !== proof) return null;
    claims = prior.claims;
  } else {
    const parts = proof.split(".");
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const signature = Buffer.from(parts[1], "base64url");
    const actual = mac(parts[0]);
    if (signature.length !== actual.length || !timingSafeEqual(signature, actual)) return null;
    try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as InternalManagerHopClaims; } catch { return null; }
    if (!claims || !validInput(claims) || typeof claims.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(claims.nonce)
      || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt > Date.now() + 1000 || Date.now() - claims.issuedAt > lifetime) return null;
  }
  if (claims.generation !== expected.generation || expected.scope !== undefined && claims.scope !== expected.scope
    || claims.method !== request.method || claims.target !== request.url
    || request.headers["x-rabilink-tunnel-local"] !== claims.generation
    || request.headers["x-rabilink-tunnel-device-id"] !== claims.deviceId
    || request.headers[claims.kind === "peer" ? "x-rabiroute-peer-proxy" : "x-rabiroute-relay-proxy"] !== "1"
    || request.headers[claims.kind === "peer" ? "x-rabiroute-relay-proxy" : "x-rabiroute-peer-proxy"] !== undefined) return null;
  const guard = prior?.guard ?? issuedGuards.get(claims.nonce)?.guard;
  try { if (guard?.() === false) return null; } catch { return null; }
  if (!prior) {
    const now = Date.now();
    cleanup(now);
    if (used.has(claims.nonce) || used.size >= 50_000) return null;
    const frozen = Object.freeze({ ...claims });
    used.set(claims.nonce, claims.issuedAt + lifetime + 1000);
    admitted.set(request, { proof, claims: frozen, guard });
    return frozen;
  }
  return claims;
}
