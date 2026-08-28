import { activateSpeech } from "../builtinWebContributions";

type ModuleApi = Readonly<{ instanceIds: readonly string[]; forInstance(instanceId: string): Parameters<typeof activateSpeech>[0] }>;

export function activate(api: ModuleApi): () => void {
  const disposers = api.instanceIds.flatMap(instanceId => activateSpeech(api.forInstance(instanceId)));
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
