import manifest from "../../contracts/napcat-4.18.4.json" with { type: "json" };

/** Immutable public declarations are compiled into the same native plugin closure. */
export function readNapcatApiManifest() { return manifest; }
