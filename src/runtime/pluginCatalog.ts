export type RabiPluginHost = "manager" | "gateway" | "web" | "desktop" | "worker";

export type RabiPluginKind = "builtin" | "package" | "external-process";

export type RabiPluginStatus =
  | "waiting_dependency"
  | "activating"
  | "active"
  | "failed"
  | "inactive";

export type RabiPluginManifest = {
  id: string;
  name: string;
  version: string;
  kind: RabiPluginKind;
  hosts: readonly RabiPluginHost[];
  capabilities?: readonly string[];
};

export type RabiPluginErrorSummary = {
  code: string;
  message: string;
};

export type RabiPluginInstanceRecord = {
  instanceId: string;
  pluginId: string;
  manifest: RabiPluginManifest;
  host: RabiPluginHost;
  scope: string;
  status: RabiPluginStatus;
  missingCapabilities: string[];
  startedAt?: string;
  stoppedAt?: string;
  error?: RabiPluginErrorSummary;
  sequence: number;
};

export type RabiPluginCatalogEntry = Omit<RabiPluginInstanceRecord, "sequence">;

export type RabiPluginCatalogSnapshot = {
  revision: number;
  plugins: RabiPluginCatalogEntry[];
};

export type RabiPluginInstanceDeclaration = {
  instanceId: string;
  manifest: RabiPluginManifest;
  host: RabiPluginHost;
  scope?: string;
  missingCapabilities?: readonly string[];
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

const PLUGIN_HOSTS = new Set<RabiPluginHost>(["manager", "gateway", "web", "desktop", "worker"]);
const PLUGIN_KINDS = new Set<RabiPluginKind>(["builtin", "package", "external-process"]);

function normalizePluginHost(value: string, field: string): RabiPluginHost {
  const normalized = required(value, field) as RabiPluginHost;
  if (!PLUGIN_HOSTS.has(normalized)) throw new Error(`${field} is unsupported: ${normalized}`);
  return normalized;
}

function normalizePluginKind(value: string, field: string): RabiPluginKind {
  const normalized = required(value, field) as RabiPluginKind;
  if (!PLUGIN_KINDS.has(normalized)) throw new Error(`${field} is unsupported: ${normalized}`);
  return normalized;
}

function uniqueHosts(values: readonly RabiPluginHost[]): RabiPluginHost[] {
  return [...new Set(values.map(value => normalizePluginHost(value, "Plugin manifest host")))];
}

function cloneManifest(manifest: RabiPluginManifest): RabiPluginManifest {
  return {
    id: required(manifest.id, "Plugin manifest id"),
    name: required(manifest.name, "Plugin manifest name"),
    version: required(manifest.version, "Plugin manifest version"),
    kind: normalizePluginKind(manifest.kind, "Plugin manifest kind"),
    hosts: uniqueHosts(manifest.hosts),
    ...(manifest.capabilities ? { capabilities: unique(manifest.capabilities) } : {})
  };
}

function cloneRecord(record: RabiPluginInstanceRecord): RabiPluginCatalogEntry {
  return {
    instanceId: record.instanceId,
    pluginId: record.pluginId,
    manifest: cloneManifest(record.manifest),
    host: record.host,
    scope: record.scope,
    status: record.status,
    missingCapabilities: [...record.missingCapabilities],
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
    ...(record.error ? { error: { ...record.error } } : {})
  };
}

function normalizedErrorCode(value: string): string {
  const normalized = required(value, "Plugin error code")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "plugin_failed";
}

export function sanitizePluginErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(/((?:["']?)(?:access[_-]?token|api[_-]?key|authorization|password|passwd|secret|token|cookie)(?:["']?)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(/\\\\[^\\\s"']+\\[^\s"']+/g, "<path>")
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|srv|mnt|private)(?:\/[^\s"')]+)+/gi, "$1<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Plugin activation failed.";
}

function sanitizeErrorSummary(error: RabiPluginErrorSummary): RabiPluginErrorSummary {
  return {
    code: normalizedErrorCode(error.code),
    message: sanitizePluginErrorMessage(error.message)
  };
}

function assertTransition(
  record: RabiPluginInstanceRecord,
  next: RabiPluginStatus,
  allowed: readonly RabiPluginStatus[]
): void {
  if (allowed.includes(record.status)) return;
  throw new Error(`Invalid plugin status transition: ${record.instanceId} ${record.status} -> ${next}`);
}

export class PluginCatalog {
  private readonly records = new Map<string, RabiPluginInstanceRecord>();
  private revision = 0;
  private sequence = 0;

  declare(declaration: RabiPluginInstanceDeclaration): RabiPluginCatalogEntry {
    const instanceId = required(declaration.instanceId, "Plugin instanceId");
    const manifest = cloneManifest(declaration.manifest);
    const pluginId = manifest.id;
    const host = normalizePluginHost(declaration.host, "Plugin host");
    if (this.records.has(instanceId)) {
      throw new Error(`Plugin instance already declared: ${instanceId}`);
    }

    if (!manifest.hosts.includes(host)) {
      throw new Error(`Plugin manifest does not support host ${host}: ${pluginId}`);
    }

    const missingCapabilities = unique(declaration.missingCapabilities ?? []);
    const record: RabiPluginInstanceRecord = {
      instanceId,
      pluginId,
      manifest,
      host,
      scope: required(declaration.scope ?? "global", "Plugin scope"),
      status: missingCapabilities.length ? "waiting_dependency" : "inactive",
      missingCapabilities,
      sequence: ++this.sequence
    };
    this.records.set(instanceId, record);
    this.revision += 1;
    return cloneRecord(record);
  }

  refreshDeclaration(declaration: RabiPluginInstanceDeclaration): RabiPluginCatalogEntry {
    const instanceId = required(declaration.instanceId, "Plugin instanceId");
    const record = this.require(instanceId);
    const manifest = cloneManifest(declaration.manifest);
    const host = normalizePluginHost(declaration.host, "Plugin host");
    const scope = required(declaration.scope ?? "global", "Plugin scope");
    if (!(record.status === "inactive" || record.status === "failed" || record.status === "waiting_dependency")) {
      throw new Error(`Plugin declaration cannot refresh from status ${record.status}: ${instanceId}`);
    }
    if (record.pluginId !== manifest.id || record.host !== host || record.scope !== scope) {
      throw new Error(`Plugin instance declaration changed: ${instanceId}`);
    }
    if (!manifest.hosts.includes(host)) {
      throw new Error(`Plugin manifest does not support host ${host}: ${manifest.id}`);
    }

    const missingCapabilities = unique(declaration.missingCapabilities ?? []);
    record.manifest = manifest;
    record.status = missingCapabilities.length ? "waiting_dependency" : "inactive";
    record.missingCapabilities = missingCapabilities;
    record.startedAt = undefined;
    record.error = undefined;
    this.revision += 1;
    return cloneRecord(record);
  }

  activating(instanceId: string): void {
    const record = this.require(instanceId);
    if (record.missingCapabilities.length) {
      throw new Error(`Plugin is waiting for dependencies: ${record.instanceId}`);
    }
    assertTransition(record, "activating", ["inactive", "failed"]);
    record.status = "activating";
    record.startedAt = undefined;
    record.stoppedAt = undefined;
    record.error = undefined;
    this.revision += 1;
  }

  active(instanceId: string, at = new Date().toISOString()): void {
    const record = this.require(instanceId);
    assertTransition(record, "active", ["activating"]);
    record.status = "active";
    record.startedAt = required(at, "Plugin startedAt");
    record.stoppedAt = undefined;
    record.error = undefined;
    this.revision += 1;
  }

  failed(instanceId: string, error: RabiPluginErrorSummary, at = new Date().toISOString()): void {
    const record = this.require(instanceId);
    assertTransition(record, "failed", ["activating"]);
    record.status = "failed";
    record.startedAt = undefined;
    record.stoppedAt = required(at, "Plugin stoppedAt");
    record.error = sanitizeErrorSummary(error);
    this.revision += 1;
  }

  inactive(instanceId: string, at = new Date().toISOString()): void {
    const record = this.require(instanceId);
    if (record.status === "waiting_dependency" || record.status === "inactive") return;
    assertTransition(record, "inactive", ["activating", "active", "failed"]);
    record.status = "inactive";
    record.stoppedAt = required(at, "Plugin stoppedAt");
    record.error = undefined;
    this.revision += 1;
  }

  remove(instanceId: string): boolean {
    const normalized = instanceId.trim();
    if (!normalized) return false;
    const removed = this.records.delete(normalized);
    if (removed) this.revision += 1;
    return removed;
  }

  clear(): void {
    if (!this.records.size) return;
    this.records.clear();
    this.revision += 1;
  }

  get(instanceId: string): RabiPluginCatalogEntry | undefined {
    const record = this.records.get(instanceId.trim());
    return record ? cloneRecord(record) : undefined;
  }

  snapshot(host?: RabiPluginHost): RabiPluginCatalogSnapshot {
    return {
      revision: this.revision,
      plugins: [...this.records.values()]
        .filter(record => !host || record.host === host)
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneRecord)
    };
  }

  private require(instanceId: string): RabiPluginInstanceRecord {
    const normalized = required(instanceId, "Plugin instanceId");
    const record = this.records.get(normalized);
    if (!record) throw new Error(`Plugin instance is not declared: ${normalized}`);
    return record;
  }
}
