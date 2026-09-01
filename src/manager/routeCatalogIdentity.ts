import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalRouteCatalogDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function routeCatalogSnapshotIdentities(input: Readonly<{
  routeRoot: string;
  rolesRoot: string;
  gateways: readonly unknown[];
  personas: readonly unknown[];
}>): Readonly<{
  contentHash: string;
  routeConfigHash: string;
  presentationHash: string;
}> {
  const routeConfigHash = canonicalRouteCatalogDigest({
    routeRoot: input.routeRoot,
    rolesRoot: input.rolesRoot,
    gateways: input.gateways
  });
  const presentationHash = canonicalRouteCatalogDigest(input.personas);
  return Object.freeze({
    routeConfigHash,
    presentationHash,
    contentHash: canonicalRouteCatalogDigest({ routeConfigHash, presentationHash })
  });
}
