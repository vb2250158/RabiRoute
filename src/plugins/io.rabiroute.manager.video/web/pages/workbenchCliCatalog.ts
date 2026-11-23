import { ref } from "vue";

const detectionError = "暂时无法检测本机 Agent。";

export type WorkbenchCliProvider = {
  id: string;
  label: string;
  installUrl: string;
  installed: boolean;
  ready?: boolean;
  models: { id: string; label: string }[];
};
export type WorkbenchCliSelection = { provider: string; model?: string };

export const cliProviders = ref<WorkbenchCliProvider[]>([]);
export const cliLoading = ref(false);
export const cliError = ref("");
let pending: Promise<void> | undefined;
let loaded = false;

export function loadWorkbenchCli(refresh = false) {
  if (pending) return pending;
  if (loaded && !refresh) return Promise.resolve();
  cliLoading.value = true;
  cliError.value = "";
  pending = (async () => {
    const response = await fetch(`/api/video/v2/cli${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(detectionError);
    const result = await response.json();
    cliProviders.value = result.providers;
    loaded = true;
  })().catch(() => { cliError.value = detectionError; }).finally(() => {
    pending = undefined;
    cliLoading.value = false;
  });
  return pending;
}
