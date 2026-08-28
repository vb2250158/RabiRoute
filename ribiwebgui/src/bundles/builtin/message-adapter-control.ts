import { activateMessageAdapterControl } from "../builtinWebContributions";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateMessageAdapterControl>[0] }>;

export function activate(api: ModuleApi): () => void {
  const disposers = api.instanceIds.flatMap(instanceId => activateMessageAdapterControl(api.forInstance(instanceId)));
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
