import type { AgentScanModel } from "./types";

export type AgentModelPickerItem = {
  title: string;
  value: string;
  subtitle?: string;
};

function modelSubtitle(model: AgentScanModel): string | undefined {
  return model.description?.trim() || undefined;
}

export function codexModelPickerItems(models: AgentScanModel[]): AgentModelPickerItem[] {
  return [...models]
    .sort((left, right) => Number(right.isDefault === true) - Number(left.isDefault === true))
    .map((model) => ({
      title: model.name === model.id ? model.id : `${model.name} · ${model.id}`,
      value: model.id,
      ...(modelSubtitle(model) ? { subtitle: modelSubtitle(model) } : {})
    }));
}

export function dshModelValue(provider: string | undefined, model: string | undefined): string {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(model || "").trim();
  if (!normalizedProvider) return normalizedModel;
  return normalizedModel ? `${normalizedProvider}/${normalizedModel}` : `${normalizedProvider}/`;
}

export function parseDshModelValue(
  value: unknown,
  models: AgentScanModel[]
): { provider: string; model: string } {
  const normalized = String(value || "").trim();
  const slash = normalized.indexOf("/");
  if (slash > 0) {
    return { provider: normalized.slice(0, slash).trim(), model: normalized.slice(slash + 1).trim() };
  }
  const exact = models.filter((model) => model.id === normalized && model.provider);
  return exact.length === 1
    ? { provider: exact[0]!.provider!, model: normalized }
    : { provider: "", model: normalized };
}

export function dshModelPickerItems(models: AgentScanModel[]): AgentModelPickerItem[] {
  return models.flatMap((model): AgentModelPickerItem[] => {
    const provider = model.provider?.trim();
    if (!provider) return [];
    const providerName = model.providerName?.trim() || provider;
    return [{
      title: `${providerName} · ${model.name}`,
      value: dshModelValue(provider, model.id),
      ...(modelSubtitle(model) ? { subtitle: modelSubtitle(model) } : {})
    }];
  });
}

export function reasoningEffortPickerItems(
  models: AgentScanModel[],
  modelId: string | undefined,
  provider?: string
): string[] {
  const normalizedModel = String(modelId || "").trim();
  const normalizedProvider = String(provider || "").trim();
  const selected = models.find((model) => (
    model.id === normalizedModel
    && (!normalizedProvider || model.provider === normalizedProvider)
  ));
  return [...new Set((selected?.reasoningEfforts ?? []).map((effort) => effort.id).filter(Boolean))];
}
