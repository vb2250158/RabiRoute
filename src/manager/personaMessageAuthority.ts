import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type StoredPersonaMessageAuthority = {
  version: 1;
  secret: string;
};

export type PersonaMessageAuthority = {
  issue(routeId: string, personaId: string): string;
  verify(routeId: string, personaId: string, capability: string): boolean;
};

const AUTHORITY_VERSION = 1;
const CAPABILITY_PREFIX = "v1.";

function authorityPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), "data", "persona-messaging", "authority.json");
}

function parseSecret(filePath: string): Buffer {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StoredPersonaMessageAuthority>;
  if (parsed.version !== AUTHORITY_VERSION || typeof parsed.secret !== "string") {
    throw new Error("Persona messaging authority file is invalid.");
  }
  const secret = Buffer.from(parsed.secret, "base64url");
  if (secret.byteLength !== 32) throw new Error("Persona messaging authority secret is invalid.");
  return secret;
}

function loadOrCreateSecret(rootDir: string): Buffer {
  const filePath = authorityPath(rootDir);
  try {
    return parseSecret(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const secret = randomBytes(32);
  const stored: StoredPersonaMessageAuthority = {
    version: AUTHORITY_VERSION,
    secret: secret.toString("base64url")
  };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return parseSecret(filePath);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function routeCapability(secret: Buffer, routeId: string, personaId: string): string {
  return `${CAPABILITY_PREFIX}${createHmac("sha256", secret).update(`persona-message\u0000${routeId}\u0000${personaId}`, "utf8").digest("base64url")}`;
}

export function loadPersonaMessageAuthority(rootDir: string): PersonaMessageAuthority {
  const secret = loadOrCreateSecret(rootDir);
  return {
    issue(routeId: string, personaId: string): string {
      const normalizedRouteId = String(routeId || "").trim();
      const normalizedPersonaId = String(personaId || "").trim();
      if (!normalizedRouteId || !normalizedPersonaId) throw new Error("Cannot issue a persona messaging capability without a Route and persona id.");
      return routeCapability(secret, normalizedRouteId, normalizedPersonaId);
    },
    verify(routeId: string, personaId: string, capability: string): boolean {
      const normalizedRouteId = String(routeId || "").trim();
      const normalizedPersonaId = String(personaId || "").trim();
      const supplied = String(capability || "").trim();
      if (!normalizedRouteId || !normalizedPersonaId || !supplied.startsWith(CAPABILITY_PREFIX)) return false;
      const expected = Buffer.from(routeCapability(secret, normalizedRouteId, normalizedPersonaId), "utf8");
      const actual = Buffer.from(supplied, "utf8");
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
    }
  };
}
