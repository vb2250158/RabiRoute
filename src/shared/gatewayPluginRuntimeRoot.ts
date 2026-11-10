import { createHash } from "node:crypto";
import path from "node:path";
import type { RuntimeLayout } from "./runtimeLayout.js";

/** Executable copies belong to this Host; shared Route data only supplies their namespace. */
export function resolveGatewayPluginRuntimeRoot(
  layout: RuntimeLayout,
  routeDataDir: string,
  kind: "endpoint-plugins" | "agent-command-plugins"
): string {
  const identity = path.resolve(routeDataDir);
  const routeKey = createHash("sha256")
    .update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex");
  return path.join(layout.stateRoot, "data", "plugins", ".runtime", "gateway", routeKey, kind);
}
