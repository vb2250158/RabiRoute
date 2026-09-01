import { createHash } from "node:crypto";

function canonicalJsonValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonValue(item) ?? "null").join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap(key => {
        const serialized = canonicalJsonValue(record[key]);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value) ?? "null";
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
