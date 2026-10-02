/** Version metadata fits the existing Relay capability channel without changing Relay. */
export const RABI_PC_VERSION_ADVERTISEMENT_PREFIX = "rabi-pc-version-";
const MAX_ADVERTISEMENT_LENGTH = 32;
const numericIdentifier = "(?:0|[1-9][0-9]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|[0-9]*[a-z-][0-9a-z-]*)`;
const versionPattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?$`);

/** Unsupported or unsafe metadata remains unknown; it is never an access decision. */
export function normalizeRabiPcVersion(value: unknown): string | null {
  if (typeof value !== "string" || value.length + RABI_PC_VERSION_ADVERTISEMENT_PREFIX.length > MAX_ADVERTISEMENT_LENGTH
    || !versionPattern.test(value)) return null;
  return value;
}

export function rabiPcVersionAdvertisement(version: unknown): string | null {
  const normalized = normalizeRabiPcVersion(version);
  return normalized === null ? null : RABI_PC_VERSION_ADVERTISEMENT_PREFIX + normalized;
}

export function isRabiPcVersionAdvertisement(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().startsWith(RABI_PC_VERSION_ADVERTISEMENT_PREFIX);
}

/** Every advertised value must agree; malformed/conflicting metadata cannot select a version. */
export function rabiPcVersionFromCapabilities(capabilities: unknown): string | null {
  if (!Array.isArray(capabilities) || capabilities.length > 64) return null;
  const versions = new Set<string>();
  for (const capability of capabilities) {
    if (!isRabiPcVersionAdvertisement(capability)) continue;
    const version = normalizeRabiPcVersion(capability.slice(RABI_PC_VERSION_ADVERTISEMENT_PREFIX.length));
    if (version === null || capability !== rabiPcVersionAdvertisement(version)) return null;
    versions.add(version);
  }
  return versions.size === 1 ? [...versions][0] : null;
}
