import type { GatewayRuntime } from "./runtimeRegistry.js";

export type StatusPayloadContext = {
  runtimes: Iterable<GatewayRuntime>;
  runtimeStatus(runtime: GatewayRuntime): Record<string, unknown>;
  routeDir: string;
  rolesDir: string;
};

export type StatusPayloadOptions = {
  includeConfigDefinitions?: boolean;
};

export function gatewayPayloadIncludesDiagnostics(searchParams: Pick<URLSearchParams, "get">): boolean {
  return searchParams.get("summary") !== "1";
}

export function standaloneGatewayPayload(
  ctx: StatusPayloadContext,
  options: StatusPayloadOptions = {}
): Record<string, unknown> {
  const runtimes = [...ctx.runtimes];
  const includeConfigDefinitions = options.includeConfigDefinitions !== false;
  return {
    code: 0,
    data: {
      config: {
        gateways: includeConfigDefinitions ? runtimes.map((runtime) => runtime.definition) : []
      },
      configFiles: {
        routeDir: ctx.routeDir,
        rolesDir: ctx.rolesDir
      },
      manager: runtimes.map(ctx.runtimeStatus)
    }
  };
}
