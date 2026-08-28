import { activatePersona } from "../builtinWebContributions";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activatePersona>[0] }>;

export function activate(api: ModuleApi): () => void {
  const disposers = api.instanceIds.flatMap(instanceId => activatePersona(api.forInstance(instanceId)));
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
