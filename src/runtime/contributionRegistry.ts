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

export type RabiCommandDangerLevel = "safe" | "confirm" | "dangerous";

export type RabiUiContribution =
  | (RabiContributionBase & {
    kind: "navigation";
    label: RabiContributionLabel;
    routeId: string;
  })
  | (RabiContributionBase & {
    kind: "settings-section";
    label: RabiContributionLabel;
    rendererId: string;
    schemaId: string;
    readCommandId: string;
    writeCommandId: string;
  })
  | (RabiContributionBase & {
    kind: "status-card";
    label: RabiContributionLabel;
    queryId: string;
    rendererId: string;
  })
  | (RabiContributionBase & {
    kind: "command";
    label: RabiContributionLabel;
    handlerId: string;
    dangerLevel?: RabiCommandDangerLevel;
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
    themeId: string;
    webResourceId?: string;
    desktopResourceId?: string;
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

function normalizeSymbol(value: string, field: string): string {
  const normalized = normalizeIdentity(value, field);
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(normalized)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return normalized;
}

function normalizeOptionalSymbol(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : normalizeSymbol(value, field);
}

function normalizeOptionalText(value: string | undefined, field: string, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeIdentity(value, field);
  if (normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return normalized;
}

function normalizeContribution(value: RabiUiContribution): RabiUiContribution {
  const id = normalizeSymbol(value.id, "Contribution id");
  const base = {
    id,
    label: {
      key: normalizeOptionalSymbol(value.label.key, `Contribution label key (${id})`),
      fallback: normalizeIdentity(value.label.fallback, `Contribution label fallback (${id})`)
    },
    hosts: value.hosts.map(host => normalizeIdentity(host, `Contribution host (${id})`) as RabiContributionHost),
    surface: normalizeSymbol(value.surface, `Contribution surface (${id})`),
    slot: normalizeSymbol(value.slot, `Contribution slot (${id})`),
    ...(value.order === undefined ? {} : { order: value.order }),
    ...(value.icon === undefined ? {} : { icon: normalizeSymbol(value.icon, `Contribution icon (${id})`) }),
    ...(value.requiredCapabilities === undefined ? {} : {
      requiredCapabilities: value.requiredCapabilities.map(capability =>
        normalizeSymbol(capability, `Contribution required capability (${id})`)
      )
    })
  };

  switch (value.kind) {
    case "navigation":
      return {
        ...base,
        kind: "navigation",
        routeId: normalizeSymbol(value.routeId, `Contribution routeId (${id})`)
      };
    case "settings-section":
      return {
        ...base,
        kind: "settings-section",
        rendererId: normalizeSymbol(value.rendererId, `Contribution rendererId (${id})`),
        schemaId: normalizeSymbol(value.schemaId, `Contribution schemaId (${id})`),
        readCommandId: normalizeSymbol(value.readCommandId, `Contribution readCommandId (${id})`),
        writeCommandId: normalizeSymbol(value.writeCommandId, `Contribution writeCommandId (${id})`)
      };
    case "status-card":
      return {
        ...base,
        kind: "status-card",
        queryId: normalizeSymbol(value.queryId, `Contribution queryId (${id})`),
        rendererId: normalizeSymbol(value.rendererId, `Contribution rendererId (${id})`)
      };
    case "command":
      return {
        ...base,
        kind: "command",
        handlerId: normalizeSymbol(value.handlerId, `Contribution handlerId (${id})`),
        dangerLevel: value.dangerLevel ?? "safe"
      };
    case "tray-menu":
      return {
        ...base,
        kind: "tray-menu",
        commandId: normalizeSymbol(value.commandId, `Contribution commandId (${id})`)
      };
    case "hotkey":
      return {
        ...base,
        kind: "hotkey",
        commandId: normalizeSymbol(value.commandId, `Contribution commandId (${id})`),
        ...(value.defaultBinding === undefined ? {} : {
          defaultBinding: normalizeOptionalText(value.defaultBinding, `Contribution defaultBinding (${id})`, 80)
        })
      };
    case "theme":
      return {
        ...base,
        kind: "theme",
        themeId: normalizeSymbol(value.themeId, `Contribution themeId (${id})`),
        ...(value.webResourceId === undefined ? {} : {
          webResourceId: normalizeSymbol(value.webResourceId, `Contribution webResourceId (${id})`)
        }),
        ...(value.desktopResourceId === undefined ? {} : {
          desktopResourceId: normalizeSymbol(value.desktopResourceId, `Contribution desktopResourceId (${id})`)
        })
      };
  }
}

function validateContribution(value: RabiUiContribution): void {
  if (value.hosts.length === 0) throw new Error(`Contribution hosts are required: ${value.id}`);
  if (value.hosts.some(host => host !== "web" && host !== "desktop")) {
    throw new Error(`Contribution host is unsupported: ${value.id}`);
  }
  if (new Set(value.hosts).size !== value.hosts.length) {
    throw new Error(`Contribution hosts contain duplicates: ${value.id}`);
  }
  if (value.order !== undefined && !Number.isSafeInteger(value.order)) {
    throw new Error(`Contribution order is unsupported: ${value.id}`);
  }
  const capabilities = value.requiredCapabilities ?? [];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`Contribution required capabilities contain duplicates: ${value.id}`);
  }
  if (value.kind === "command" && !["safe", "confirm", "dangerous"].includes(value.dangerLevel ?? "safe")) {
    throw new Error(`Contribution danger level is unsupported: ${value.id}`);
  }
}

function validateContributionRelationships(contributions: readonly RabiUiContribution[]): void {
  const commandIds = new Set(
    contributions.filter(contribution => contribution.kind === "command").map(contribution => contribution.id)
  );
  for (const contribution of contributions) {
    if ((contribution.kind === "tray-menu" || contribution.kind === "hotkey")
      && !commandIds.has(contribution.commandId)) {
      throw new Error(
        `Contribution command reference is missing from the same registration batch: ${contribution.kind}:${contribution.id} -> ${contribution.commandId}`
      );
    }
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
    validateContributionRelationships(normalizedContributions);
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
