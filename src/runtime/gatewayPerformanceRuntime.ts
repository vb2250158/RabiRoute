import type { RabiCordisFiber, RabiCordisHost } from "./cordisHost.js";

export type GatewayPerformanceReporterStarter = () => () => void;

export function mountGatewayPerformanceReporter(
  host: RabiCordisHost,
  startReporter: GatewayPerformanceReporterStarter
): Promise<RabiCordisFiber> {
  return host.mount({
    name: "rabi.gateway.performance-reporter",
    apply(ctx) {
      ctx.effect(
        () => startReporter(),
        "run Gateway performance reporter"
      );
    }
  });
}
