export type RabiContributionHost = "web" | "desktop";

export type RabiContributionBase = {
  id: string;
  hosts: readonly RabiContributionHost[];
  order?: number;
};

export type RabiManagerAction = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: Record<string, unknown>;
};

export type RabiUiContribution =
  | (RabiContributionBase & {
    kind: "navigation";
    labelKey: string;
    target: string;
  })
  | (RabiContributionBase & {
    kind: "settings-section";
    labelKey: string;
    schema: Record<string, unknown>;
    endpoint: string;
  })
  | (RabiContributionBase & {
    kind: "status-card";
    labelKey: string;
    query: string;
    renderer: string;
  })
  | (RabiContributionBase & {
    kind: "command";
    labelKey: string;
    action: RabiManagerAction;
  })
  | (RabiContributionBase & {
    kind: "tray-menu";
    commandId: string;
  })
  | (RabiContributionBase & {
    kind: "hotkey";
    commandId: string;
    defaultBinding?: string;
  })
  | (RabiContributionBase & {
    kind: "theme";
    resourceRoot: string;
  });

export type RabiContributionRecord = RabiUiContribution & {
  pluginId: string;
};

export type RabiContributionCatalog = {
  revision: number;
  contributions: RabiContributionRecord[];
};

function contributionKey(value: Pick<RabiUiContribution, "kind" | "id">): string {
  return `${value.kind}:${value.id}`;
}

function normalizePluginId(pluginId: string): string {
  const value = pluginId.trim();
  if (!value) throw new Error("Contribution pluginId is required.");
  return value;
}

function validateContribution(value: RabiUiContribution): void {
  if (!value.id.trim()) throw new Error("Contribution id is required.");
  if (value.hosts.length === 0) throw new Error(`Contribution hosts are required: ${value.id}`);
  if (new Set(value.hosts).size !== value.hosts.length) {
    throw new Error(`Contribution hosts contain duplicates: ${value.id}`);
  }
}

export class ContributionRegistry {
  private readonly records = new Map<string, RabiContributionRecord & { sequence: number }>();
  private sequence = 0;
  private revision = 0;

  register(pluginId: string, contribution: RabiUiContribution): () => void {
    return this.registerMany(pluginId, [contribution]);
  }

  registerMany(pluginId: string, contributions: readonly RabiUiContribution[]): () => void {
    const owner = normalizePluginId(pluginId);
    const keys = new Set<string>();
    for (const contribution of contributions) {
      validateContribution(contribution);
      const key = contributionKey(contribution);
      if (keys.has(key) || this.records.has(key)) {
        throw new Error(`Contribution already registered: ${key}`);
      }
      keys.add(key);
    }

    const inserted: string[] = [];
    for (const contribution of contributions) {
      const key = contributionKey(contribution);
      this.records.set(key, {
        ...contribution,
        hosts: [...contribution.hosts],
        pluginId: owner,
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
        if (record?.pluginId !== owner) continue;
        removed = this.records.delete(key) || removed;
      }
      if (removed) this.revision += 1;
    };
  }

  catalog(host?: RabiContributionHost): RabiContributionCatalog {
    const contributions = [...this.records.values()]
      .filter((record) => !host || record.hosts.includes(host))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.sequence - right.sequence)
      .map(({ sequence: _sequence, ...record }) => ({
        ...record,
        hosts: [...record.hosts]
      }));
    return {
      revision: this.revision,
      contributions
    };
  }
}
