export type RabiContributionHost = "web" | "desktop";

export type RabiContributionLabel = {
  key?: string;
  fallback: string;
};

export type RabiContributionBase = {
  id: string;
  hosts: readonly RabiContributionHost[];
  surface: string;
  slot: string;
  order?: number;
  icon?: string;
  requiredCapabilities?: readonly string[];
};

export type RabiManagerAction = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: Record<string, unknown>;
};

export type RabiUiContribution =
  | (RabiContributionBase & {
    kind: "navigation";
    label: RabiContributionLabel;
    target: string;
    routeScoped?: boolean;
  })
  | (RabiContributionBase & {
    kind: "settings-section";
    label: RabiContributionLabel;
    schema: Record<string, unknown>;
    endpoint: string;
  })
  | (RabiContributionBase & {
    kind: "status-card";
    label: RabiContributionLabel;
    query: string;
    renderer: string;
  })
  | (RabiContributionBase & {
    kind: "command";
    label: RabiContributionLabel;
    action: RabiManagerAction;
  })
  | (RabiContributionBase & {
    kind: "tray-menu";
    label: RabiContributionLabel;
    commandId: string;
  })
  | (RabiContributionBase & {
    kind: "hotkey";
    label: RabiContributionLabel;
    commandId: string;
    defaultBinding?: string;
  })
  | (RabiContributionBase & {
    kind: "theme";
    label: RabiContributionLabel;
    resourceRoot: string;
  });

export type RabiContributionRecord = RabiUiContribution & {
  pluginId: string;
  instanceId: string;
};

export type RabiContributionCatalog = {
  revision: number;
  contributions: RabiContributionRecord[];
};

function contributionKey(value: Pick<RabiUiContribution, "kind" | "id">): string {
  return `${value.kind}:${value.id}`;
}

function normalizeIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function cloneContribution<T extends RabiUiContribution | RabiContributionRecord>(value: T): T {
  return cloneValue(value);
}

function normalizeContribution(value: RabiUiContribution): RabiUiContribution {
  const normalized = cloneContribution(value);
  normalized.id = normalizeIdentity(normalized.id, "Contribution id");
  normalized.surface = normalizeIdentity(normalized.surface, `Contribution surface (${normalized.id})`);
  normalized.slot = normalizeIdentity(normalized.slot, `Contribution slot (${normalized.id})`);
  normalized.label = {
    key: normalized.label.key?.trim() || undefined,
    fallback: normalizeIdentity(normalized.label.fallback, `Contribution label fallback (${normalized.id})`)
  };
  normalized.requiredCapabilities = normalized.requiredCapabilities?.map(capability => capability.trim());
  return normalized;
}

function validateContribution(value: RabiUiContribution): void {
  normalizeIdentity(value.id, "Contribution id");
  normalizeIdentity(value.surface, `Contribution surface (${value.id})`);
  normalizeIdentity(value.slot, `Contribution slot (${value.id})`);
  if (!value.label.fallback.trim()) {
    throw new Error(`Contribution label fallback is required: ${value.id}`);
  }
  if (value.hosts.length === 0) throw new Error(`Contribution hosts are required: ${value.id}`);
  if (value.hosts.some(host => host !== "web" && host !== "desktop")) {
    throw new Error(`Contribution host is unsupported: ${value.id}`);
  }
  if (new Set(value.hosts).size !== value.hosts.length) {
    throw new Error(`Contribution hosts contain duplicates: ${value.id}`);
  }
  const capabilities = value.requiredCapabilities ?? [];
  if (capabilities.some(capability => !capability.trim())) {
    throw new Error(`Contribution required capability is empty: ${value.id}`);
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`Contribution required capabilities contain duplicates: ${value.id}`);
  }
}

export class ContributionRegistry {
  private readonly records = new Map<string, RabiContributionRecord & { sequence: number }>();
  private sequence = 0;
  private revision = 0;

  register(
    pluginId: string,
    contribution: RabiUiContribution,
    instanceId = pluginId
  ): () => void {
    return this.registerMany(pluginId, [contribution], instanceId);
  }

  registerMany(
    pluginId: string,
    contributions: readonly RabiUiContribution[],
    instanceId = pluginId
  ): () => void {
    const owner = normalizeIdentity(pluginId, "Contribution pluginId");
    const ownerInstance = normalizeIdentity(instanceId, "Contribution instanceId");
    const normalizedContributions = contributions.map(normalizeContribution);
    const keys = new Set<string>();
    for (const contribution of normalizedContributions) {
      validateContribution(contribution);
      const key = contributionKey(contribution);
      if (keys.has(key) || this.records.has(key)) {
        throw new Error(`Contribution already registered: ${key}`);
      }
      keys.add(key);
    }

    const inserted: string[] = [];
    for (const contribution of normalizedContributions) {
      const key = contributionKey(contribution);
      this.records.set(key, {
        ...contribution,
        pluginId: owner,
        instanceId: ownerInstance,
        sequence: ++this.sequence
      });
      inserted.push(key);
    }
    if (inserted.length) this.revision += 1;

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      let removed = false;
      for (const key of inserted) {
        const record = this.records.get(key);
        if (record?.pluginId !== owner || record.instanceId !== ownerInstance) continue;
        removed = this.records.delete(key) || removed;
      }
      if (removed) this.revision += 1;
    };
  }

  catalog(host?: RabiContributionHost): RabiContributionCatalog {
    const contributions = [...this.records.values()]
      .filter((record) => !host || record.hosts.includes(host))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.sequence - right.sequence)
      .map(({ sequence: _sequence, ...record }) => cloneContribution(record));
    return {
      revision: this.revision,
      contributions
    };
  }
}
