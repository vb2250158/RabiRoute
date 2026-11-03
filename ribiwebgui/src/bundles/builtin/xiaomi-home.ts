import { activateXiaomiHome } from "../builtinWebContributions";
import { registerMessageEndpointRenderer } from "../../messageEndpoints/registerMessageEndpointRenderer";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateXiaomiHome>[0] }>;

export function activate(api: ModuleApi): () => void {
  const disposers = api.instanceIds.flatMap(instanceId => [
    ...activateXiaomiHome(api.forInstance(instanceId)),
    registerMessageEndpointRenderer(api.forInstance(instanceId), "xiaomiHome", () => import("../../messageEndpoints/XiaomiHomeEndpointCard.vue"))
  ]);
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
