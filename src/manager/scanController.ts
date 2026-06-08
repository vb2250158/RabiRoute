import type { AgentManagerApiContext } from "../agentAdapters/managerApi.js";
import type { MessageAdapterType } from "../shared/gatewayConfigModel.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type ScanControllerContext = {
  rootDir: string;
  getRuntimes(): Iterable<GatewayRuntime>;
  agentManagerApiContext(): AgentManagerApiContext;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
  adapterRuntimes(type: MessageAdapterType): GatewayRuntime[];
};

export class ScanController {
  constructor(readonly ctx: ScanControllerContext) {}

  runtimes(): GatewayRuntime[] {
    return [...this.ctx.getRuntimes()];
  }
}
