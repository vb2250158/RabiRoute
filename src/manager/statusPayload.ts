import type { GatewayRuntime } from "./runtimeRegistry.js";

export type StatusPayloadContext = {
  runtimes: Iterable<GatewayRuntime>;
  runtimeStatus(runtime: GatewayRuntime): Record<string, unknown>;
  routeDir: string;
  rolesDir: string;
};

export function standaloneGatewayPayload(ctx: StatusPayloadContext): Record<string, unknown> {
  const runtimes = [...ctx.runtimes];
  return {
    code: 0,
    data: {
      config: {
        gateways: runtimes.map((runtime) => runtime.definition)
      },
      configFiles: {
        routeDir: ctx.routeDir,
        rolesDir: ctx.rolesDir
      },
      manager: runtimes.map(ctx.runtimeStatus)
    }
  };
}
