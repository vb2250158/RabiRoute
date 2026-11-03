import fs from "node:fs";
import path from "node:path";
import type { GatewayDefinition } from "./gatewayConfigModel.js";
import { gatewayRouteSnapshotRevision, immutableGatewayRouteSnapshot, validGatewayRouteRevision } from "./gatewayRouteSnapshot.js";

/** The supervised process owns this generation's file; large Route documents never become environment variables. */
export function writeGatewayRouteBootSnapshot(directory: string, generation: string, definition: Readonly<GatewayDefinition>) {
  if (!/^[A-Za-z0-9_-]+$/.test(generation)) throw new Error("Invalid Gateway boot generation.");
  const snapshot = immutableGatewayRouteSnapshot(definition);
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${generation}.json`);
  fs.writeFileSync(filename, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
  return Object.freeze({ filename, revision: gatewayRouteSnapshotRevision(snapshot), definition: snapshot,
    dispose() { fs.rmSync(filename, { force: true }); }
  });
}

/** Called once before native activation. The mutable route catalog and startup environment are never reread. */
export function readGatewayRouteBootSnapshot(filename: string, revision: string, gatewayId: string): Readonly<GatewayDefinition> {
  if (!validGatewayRouteRevision(revision) || !path.isAbsolute(filename)) throw new Error("Gateway boot Route identity is invalid.");
  let parsed: GatewayDefinition;
  try { parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as GatewayDefinition; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Gateway boot Route snapshot is invalid JSON.");
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || parsed.id !== gatewayId || gatewayRouteSnapshotRevision(parsed) !== revision) {
    throw new Error("Gateway boot Route snapshot does not match its original revision.");
  }
  return immutableGatewayRouteSnapshot(parsed);
}
