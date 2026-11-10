import { ApiContractError, apiDigest, freezeApiData, type ApiOperationDiscovery, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runPluginSynchronousWork } from "@rabiroute/host-api/plugin-kernel/synchronousExecution";
import type { ApiCatalogSnapshot, ApiPublishedOperation } from "@rabiroute/host-api/manager/apiOperationCatalog";

export type ApiDiscoveryCategoryView = Readonly<{
  id: string; title: string; description: string; parentId?: string; count: number; ownerPluginId?: string;
}>;
export type ApiOperationSummary = Readonly<{
  operationId: string; title: string; summary: string; categoryId: string; tags: readonly string[];
  provider: string; method: string; pathTemplate: string; effects: Pick<ApiPublishedOperation["contract"]["effects"], "mode">;
  requiredInputs: Readonly<{ path: readonly string[]; query: readonly string[]; headers: readonly string[]; body: readonly string[] }>;
  describe: Readonly<{ method: "GET"; path: string }>;
  discoveryIssues?: readonly string[];
}>;
export type ApiOperationFilters = Readonly<{
  category?: string; query?: string; provider?: string; owner?: string; method?: string; pathPrefix?: string;
}>;
type IndexedOperation = Readonly<{
  operation: ApiPublishedOperation; summary: ApiOperationSummary; discovery: ApiOperationDiscovery & { issues?: readonly string[] };
  searchable: string; searchFields: readonly Readonly<{ value: string; weight: number }>[];
}>;
export type ApiDiscoveryIndex = Readonly<{
  categories: readonly ApiDiscoveryCategoryView[];
  operations: readonly IndexedOperation[];
  byId: ReadonlyMap<string, IndexedOperation>;
}>;

const categoryDefinitions = [
  { id: "messages", title: "消息", description: "消息连接、会话、聊天记录、发送与消息附件" },
  { id: "agents", title: "Agent 协作", description: "Agent 软件、执行会话、投递、续投和回执" },
  { id: "knowledge", title: "记忆与计划", description: "持久计划、步骤、记忆、知识和计划材料" },
  { id: "devices", title: "电脑与设备", description: "电脑、终端、文件系统、屏幕和设备能力" },
  { id: "settings", title: "角色与 Rabi 配置", description: "人格、全局设置和配置定义" },
  { id: "automation", title: "自动化", description: "规则、触发条件、定时事件与调度记录" },
  { id: "runtime", title: "插件与运行", description: "Host、插件生命周期、运行状态、诊断与性能" }
] as const;

/** Navigation defaults for existing native operations. The active registry owns execution;
 * explicit per-operation discovery overrides these defaults. No operation is registered here.
 */
const builtinApiNavigation: Readonly<Record<string, ApiOperationDiscovery>> = Object.freeze({
  "manager.rabilink.peer.servers.read": {
    title: "电脑列表与远程主机连接",
    summary: "查询 Rabi 主机目录及连接状态，使用 deviceId 定位主机。一台主机可有多个当前 Manager 执行实例；执行实例和登记 SDK 节点目录分别查询，不合并计作电脑数。",
    category: { id: "devices", title: "电脑与设备" },
    keywords: ["电脑列表", "电脑连接", "远程电脑", "computer list", "remote computers"],
    relatedOperations: ["manager.rabilink.peer.http.get", "manager.lan-agent.instances.list", "manager.lan-agent.nodes.list"]
  },
  "manager.lan-agent.instances.list": {
    title: "当前 Manager 的执行节点列表（本机及已接入）",
    summary: "查询当前 Manager 的本机与已接入执行实例，使用 instanceId 访问该实例能力。此目录不是 Rabi 主机目录，也不是登记 SDK 节点版本目录。",
    category: { id: "devices", title: "电脑与设备" },
    keywords: ["执行节点", "本机电脑", "computer instances"],
    relatedOperations: ["manager.rabilink.peer.servers.read", "manager.lan-agent.nodes.list", "manager.lan-agent.terminals.list"]
  },
  "manager.lan-agent.nodes.list": {
    title: "查询登记 SDK 节点与版本",
    summary: "查询登记 SDK 节点、nodeId 与版本状态。主机目录和当前 Manager 执行实例目录分别查询。",
    category: { id: "devices", title: "电脑与设备" },
    keywords: ["SDK 节点", "登记节点", "节点版本", "registered SDK nodes"],
    relatedOperations: ["manager.rabilink.peer.servers.read", "manager.lan-agent.instances.list"]
  },
  "manager.rabilink.peer.http.get": {
    title: "读取远程 Rabi 主机服务接口",
    summary: "从 Rabi 主机目录取得 deviceId，再按当前执行合同提供 service 和 path，读取对应主机服务。",
    category: { id: "devices", title: "电脑与设备" },
    keywords: ["远程主机服务", "peer HTTP", "remote host service"],
    inputSources: [{ field: "path.deviceId", operationId: "manager.rabilink.peer.servers.read", resultPath: "/peers", valuePath: "/deviceId" }],
    relatedOperations: ["manager.rabilink.peer.servers.read"]
  },
  "manager.lan-agent.terminals.list": {
    title: "查询执行实例的终端与可用 Shell",
    summary: "使用执行实例目录的 instanceId 查询终端；sessions 为空表示当前没有终端会话，不表示缺少控制能力，shells 列出可用 Shell。",
    category: { id: "devices", title: "电脑与设备" },
    keywords: ["终端", "terminal", "shell", "终端会话"],
    inputSources: [{ field: "path.instanceId", operationId: "manager.lan-agent.instances.list", resultPath: "/instances", valuePath: "/instanceId" }],
    relatedOperations: ["manager.lan-agent.instances.list", "manager.lan-agent.terminals.execute"]
  }
});

const fallbackCategories = [
  { id: "automation", pattern: /automation|scheduled|heartbeat/i },
  { id: "knowledge", pattern: /\/(?:knowledge|memory|plans|skills|diary)(?:\/|$)|(?:^|\.)knowledge\.|(?:^|\.)memory\.|(?:^|\.)plans\./i },
  { id: "messages", pattern: /\/qq(?:\/|$)|message-endpoint|\/agent\/send|\.qq\.|napcat|message-history|persona-messag|\/personas\/[^/]+\/messages/i },
  { id: "devices", pattern: /\/lan-agent\/(?:terminals|computer|files)|\/devices(?:\/|$)|computer-service|xiaomi|screen|desktop-pet|\/terminal|\/files(?:\/|$)|rabilink/i },
  { id: "agents", pattern: /\/agent\/(?:threads|requests)|\/remote-agent|\/agent-adapters|\/scan\/agents|\.agent\.|agent-communication|\/lan-agent\/(?:instances|nodes|agents)/i },
  { id: "settings", pattern: /\/roles(?:\/|$)|\/personas(?:\/|$)|\/configuration|\/settings|\/gateways|\/network-options|\/config(?:\/|$)/i }
] as const;
// Expand only the query's exact words; categories never inject terms into operations.
const querySynonyms: ReadonlyMap<string, readonly string[]> = new Map([
  ["记忆", ["memory", "memories"]], ["计划", ["plan", "plans"]], ["技能", ["skill", "skills"]],
  ["文件", ["file", "files", "filesystem"]], ["终端", ["terminal", "terminals", "shell"]],
  ["屏幕", ["screen", "screenshot"]], ["窗口", ["window"]], ["插件", ["plugin", "plugins"]],
  ["角色", ["role", "persona"]], ["配置", ["config", "settings"]], ["设置", ["config", "settings"]],
  ["消息", ["message", "chat"]], ["语音", ["speech", "voice"]], ["视频", ["video"]],
  ["电脑", ["computer", "computers"]], ["设备", ["device", "devices"]]
]);
const snapshotIndexes = new WeakMap<ApiCatalogSnapshot, ApiDiscoveryIndex>();
const filterResults = new WeakMap<ApiDiscoveryIndex, Map<string, readonly IndexedOperation[]>>();
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

function requiredFields(schema: ApiSchema | undefined): readonly string[] {
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.required)) return [];
  return schema.required.filter((value): value is string => typeof value === "string");
}

function captureNavigation(operation: ApiPublishedOperation) {
  const metadata = { ...builtinApiNavigation[operation.contract.operationId], ...operation.discovery };
  const issues = [...(operation.discoveryIssues ?? [])];
  const strings = (key: "tags" | "keywords" | "relatedOperations") => {
    const value = metadata[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) { issues.push(`discovery_${key}_invalid`); return []; }
    if (value.some(item => !text(item))) issues.push(`discovery_${key}_item_invalid`);
    return [...new Set(value.map(item => text(item)).filter((item): item is string => !!item))];
  };
  for (const key of ["title", "summary"] as const) {
    if (metadata[key] !== undefined && !text(metadata[key])) issues.push(`discovery_${key}_invalid`);
  }
  if (metadata.provider !== undefined && typeof metadata.provider !== "string") issues.push("discovery_provider_invalid");
  const fallback = `${operation.contract.operationId} ${operation.contract.pathTemplate} ${operation.owner.instanceId}`;
  let categoryId = fallbackCategories.find(category => category.pattern.test(fallback))?.id ?? "runtime";
  let declaredCategory: Omit<ApiDiscoveryCategoryView, "count"> | undefined;
  if (metadata.category !== undefined) {
    const category = metadata.category;
    if (category && typeof category === "object" && text(category.id) && text(category.title)) {
      categoryId = text(category.id)!;
      declaredCategory = { id: categoryId, title: text(category.title)!, description: text(category.description) ?? "",
        ...(text(category.parentId) ? { parentId: text(category.parentId) } : {}),
        ...(operation.owner.pluginId ? { ownerPluginId: operation.owner.pluginId } : {}) };
    } else issues.push("discovery_category_invalid");
  }
  let inputSources = metadata.inputSources;
  if (inputSources !== undefined) {
    if (!Array.isArray(inputSources)) { inputSources = []; issues.push("discovery_inputSources_invalid"); }
    else {
      inputSources = inputSources.filter(source => {
        const parameters = source?.parameters;
        const validParameters = parameters === undefined || parameters && typeof parameters === "object" && !Array.isArray(parameters)
          && Object.values(parameters).every(mapping => mapping && typeof mapping === "object"
            && (Object.hasOwn(mapping, "value") || typeof (mapping as { from?: unknown }).from === "string"));
        const valid = source && typeof source === "object" && text(source.field) && text(source.operationId)
          && typeof source.resultPath === "string" && (!source.resultPath || source.resultPath.startsWith("/"))
          && (source.valuePath === undefined || typeof source.valuePath === "string" && (!source.valuePath || source.valuePath.startsWith("/")))
          && validParameters;
        if (!valid) issues.push("discovery_inputSource_invalid");
        return valid;
      });
    }
  }
  let automationTemplates = metadata.automationTemplates;
  if (automationTemplates !== undefined) {
    if (!Array.isArray(automationTemplates)) { automationTemplates = []; issues.push("discovery_automationTemplates_invalid"); }
    else automationTemplates = automationTemplates.filter(template => {
      const valid = template && typeof template === "object" && text(template.id) && text(template.version) && text(template.title);
      if (!valid) issues.push("discovery_automationTemplate_invalid");
      return valid;
    });
  }
  return { title: text(metadata.title) ?? operation.contract.operationId,
    summary: text(metadata.summary) ?? operation.contract.description, categoryId, declaredCategory,
    tags: strings("tags"), keywords: strings("keywords"), relatedOperations: strings("relatedOperations"),
    provider: text(metadata.provider) ?? "", inputSources, automationTemplates, issues };
}

function* buildDiscoveryIndex(snapshot: ApiCatalogSnapshot): Generator<void, ApiDiscoveryIndex> {
  const categories = new Map<string, Omit<ApiDiscoveryCategoryView, "count">>(categoryDefinitions.map(category =>
    [category.id, { id: category.id, title: category.title, description: category.description }]));
  const prepared: Array<{ operation: ApiPublishedOperation; navigation: ReturnType<typeof captureNavigation> }> = [];
  for (const operation of snapshot.operations) {
    prepared.push({ operation, navigation: captureNavigation(operation) });
    yield;
  }
  for (const { navigation } of prepared) {
    const category = navigation.declaredCategory;
    if (!category) continue;
    const known = categories.get(category.id);
    if (known) {
      if (!categoryDefinitions.some(builtin => builtin.id === category.id)
        && (known.title !== category.title || known.parentId !== category.parentId)) navigation.issues.push("discovery_category_conflict");
    } else categories.set(category.id, category);
    yield;
  }
  for (const category of [...categories.values()]) {
    if (category.parentId && !categories.has(category.parentId)) {
      categories.set(category.parentId, { id: category.parentId, title: category.parentId, description: "" });
    }
    yield;
  }
  const categoryIssues = new Map<string, string[]>();
  for (const category of [...categories.values()]) {
    const visited = new Set([category.id]);
    let parent = category.parentId;
    while (parent) {
      if (visited.has(parent)) {
        categories.set(category.id, { ...category, parentId: undefined });
        categoryIssues.set(category.id, ["discovery_category_cycle"]);
        break;
      }
      visited.add(parent);
      parent = categories.get(parent)?.parentId;
    }
    yield;
  }
  const byId = new Map<string, IndexedOperation>();
  const operations: IndexedOperation[] = [];
  for (const { operation, navigation } of prepared) {
    const contract = operation.contract;
    const issues = [...navigation.issues, ...(categoryIssues.get(navigation.categoryId) ?? [])];
    const discovery = { title: navigation.title, summary: navigation.summary,
      category: categories.get(navigation.categoryId)!, tags: navigation.tags, keywords: navigation.keywords,
      provider: navigation.provider, ...(navigation.inputSources ? { inputSources: navigation.inputSources } : {}),
      relatedOperations: navigation.relatedOperations,
      ...(navigation.automationTemplates ? { automationTemplates: navigation.automationTemplates } : {}),
      ...(issues.length ? { issues } : {}) };
    const summary: ApiOperationSummary = { operationId: contract.operationId, title: navigation.title, summary: navigation.summary,
      categoryId: navigation.categoryId, tags: navigation.tags, provider: navigation.provider, method: contract.method,
      pathTemplate: contract.pathTemplate, effects: { mode: contract.effects.mode },
      requiredInputs: { path: requiredFields(contract.request.path), query: requiredFields(contract.request.query),
        headers: requiredFields(contract.request.headers), body: contract.request.body.kind === "json" ? requiredFields(contract.request.body.schema) : [] },
      describe: { method: "GET", path: `/api/agent/operations/${encodeURIComponent(contract.operationId)}` },
      ...(issues.length ? { discoveryIssues: issues } : {}) };
    freezeApiData(summary);
    freezeApiData(discovery);
    // Categories narrow the catalog; only an operation's own metadata makes it relevant to a query.
    const searchFields = Object.freeze([
      { value: contract.operationId, weight: 128 },
      ...(contract.aliases ?? []).map(value => ({ value, weight: 96 })),
      { value: navigation.title, weight: 64 },
      ...navigation.keywords.map(value => ({ value, weight: 24 })),
      ...navigation.tags.map(value => ({ value, weight: 16 })),
      { value: contract.pathTemplate, weight: 8 },
      { value: navigation.summary, weight: 2 }
    ].map(field => Object.freeze({ ...field, value: normalize(field.value) })));
    const indexed = Object.freeze({ operation, summary, discovery, searchFields,
      searchable: searchFields.map(field => field.value).join(" ") });
    byId.set(contract.operationId, indexed);
    for (const alias of contract.aliases ?? []) byId.set(alias, indexed);
    operations.push(indexed);
    yield;
  }
  const counts = new Map<string, number>();
  for (const { summary } of operations) {
    let categoryId: string | undefined = summary.categoryId;
    while (categoryId) { counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1); categoryId = categories.get(categoryId)?.parentId; }
    yield;
  }
  const index = Object.freeze({ operations: Object.freeze(operations), byId,
    categories: Object.freeze([...categories.values()].map(category => Object.freeze({ ...category, count: counts.get(category.id) ?? 0 }))) });
  snapshotIndexes.set(snapshot, index);
  return index;
}

/** Reuse a prepared snapshot for synchronous page selection and exact lookups. */
export function apiDiscoveryIndex(snapshot: ApiCatalogSnapshot): ApiDiscoveryIndex {
  const cached = snapshotIndexes.get(snapshot);
  if (cached) return cached;
  const preparation = buildDiscoveryIndex(snapshot);
  for (;;) { const step = preparation.next(); if (step.done) return step.value; }
}

/** Cold catalogs yield through the same cooperative batches as full API help. */
export async function prepareApiDiscoveryIndex(snapshot: ApiCatalogSnapshot, signal?: AbortSignal): Promise<ApiDiscoveryIndex> {
  const cached = snapshotIndexes.get(snapshot);
  if (cached) return cached;
  const preparation = buildDiscoveryIndex(snapshot);
  for (;;) {
    await yieldToEventLoop(undefined, { signal });
    const step = runPluginSynchronousWork(() => {
      const started = performance.now();
      let current: IteratorResult<void, ApiDiscoveryIndex>;
      for (let count = 0;; count++) {
        signal?.throwIfAborted();
        current = preparation.next();
        if (current.done || count >= 255 || performance.now() - started >= 8) return current;
      }
    }, "prepare API navigation index batch");
    if (step.done) return step.value;
  }
}

function belongsToCategory(index: ApiDiscoveryIndex, categoryId: string, selected: string): boolean {
  let current: string | undefined = categoryId;
  while (current) {
    if (current === selected) return true;
    current = index.categories.find(category => category.id === current)?.parentId;
  }
  return false;
}

function filteredOperations(index: ApiDiscoveryIndex, filters: ApiOperationFilters): readonly IndexedOperation[] {
  const key = apiDigest(filters);
  let cache = filterResults.get(index);
  if (!cache) { cache = new Map(); filterResults.set(index, cache); }
  const cached = cache.get(key);
  if (cached) return cached;
  const query = normalize(filters.query ?? "").trim().replace(/\s+/gu, " ");
  const terms = query.split(" ").filter(Boolean).map(literal => {
    const aliases = querySynonyms.get(literal);
    return { literal, alternatives: aliases ? new RegExp(`(?:^|[^a-z0-9])(?:${aliases.join("|")})(?=$|[^a-z0-9])`, "u") : undefined };
  });
  let matches = index.operations.filter(item => (!filters.category || belongsToCategory(index, item.summary.categoryId, filters.category))
    && (!filters.provider || item.summary.provider === filters.provider)
    && (!filters.owner || item.operation.owner.instanceId === filters.owner)
    && (!filters.method || item.summary.method === filters.method || item.summary.method === "*")
    && (!filters.pathPrefix || item.summary.pathTemplate.startsWith(filters.pathPrefix))
    && terms.every(term => item.searchable.includes(term.literal) || term.alternatives?.test(item.searchable)));
  if (terms.length) {
    const ranked = matches.map(item => {
      let score = 0, literalMatches = 0;
      for (const term of terms) {
        let strongest = 0;
        for (const field of item.searchFields) {
          if (field.value.includes(term.literal)) strongest = Math.max(strongest, field.weight * (field.value === term.literal ? 2 : 1));
        }
        if (strongest) literalMatches++;
        else if (term.alternatives) {
          for (const field of item.searchFields) {
            if (term.alternatives.test(field.value)) strongest = Math.max(strongest, field.weight);
          }
        }
        score += strongest;
      }
      let phraseScore = 0;
      if (terms.length > 1) {
        for (const field of item.searchFields) {
          if (field.value.includes(query)) phraseScore = Math.max(phraseScore, field.weight);
        }
      }
      return { item, score, literalMatches, phraseScore };
    });
    ranked.sort((left, right) => right.phraseScore - left.phraseScore || right.literalMatches - left.literalMatches || right.score - left.score
      || left.item.summary.operationId.localeCompare(right.item.summary.operationId));
    matches = ranked.map(result => result.item);
  }
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, matches);
  return matches;
}

export function apiOperationPage(snapshot: ApiCatalogSnapshot, filters: ApiOperationFilters, limit = 20, cursor?: string) {
  const index = apiDiscoveryIndex(snapshot);
  const operations = filteredOperations(index, filters);
  const filterDigest = apiDigest(filters);
  let offset = 0;
  if (cursor) {
    let page: Record<string, unknown>;
    try { page = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
    catch { throw new ApiContractError(400, "API_OPERATIONS_CURSOR_INVALID", "query.cursor", "manager.api.operations.list"); }
    if (!page || typeof page !== "object" || Array.isArray(page) || !Number.isSafeInteger(page.offset)
      || Number(page.offset) < 0 || Number(page.offset) > operations.length) {
      throw new ApiContractError(400, "API_OPERATIONS_CURSOR_INVALID", "query.cursor", "manager.api.operations.list");
    }
    if (page.manager !== snapshot.managerInstanceId || page.revision !== snapshot.catalogRevision
      || page.digest !== snapshot.catalogDigest || page.filters !== filterDigest) {
      throw new ApiContractError(409, "API_CATALOG_SNAPSHOT_CHANGED", "query.cursor", "manager.api.operations.list");
    }
    offset = Number(page.offset);
  }
  const end = Math.min(offset + limit, operations.length);
  const nextCursor = end < operations.length ? Buffer.from(JSON.stringify({ manager: snapshot.managerInstanceId,
    revision: snapshot.catalogRevision, digest: snapshot.catalogDigest, filters: filterDigest, offset: end })).toString("base64url") : "";
  return { items: operations.slice(offset, end).map(item => item.summary), count: end - offset, total: operations.length, nextCursor };
}

export function apiOperationDescription(snapshot: ApiCatalogSnapshot, operationId: string, view: "input" | "result" | "full" = "full") {
  const item = apiDiscoveryIndex(snapshot).byId.get(operationId);
  if (!item) throw new ApiContractError(404, "API_OPERATION_NOT_FOUND", "path.operationId", "manager.api.operations.describe");
  const { operation } = item;
  const { automationTemplates: _templates, ...navigation } = item.discovery;
  const discovery: ApiOperationDiscovery & { issues?: readonly string[] } = view === "full" ? item.discovery : navigation;
  return { id: operation.contract.operationId, contractDigest: operation.contractDigest, owner: operation.owner,
    discovery, transport: operation.contract.transport,
    ...(operation.binding ? { binding: operation.binding } : {}), ...(operation.access ? { access: operation.access } : {}),
    ...(view === "full" ? { contract: operation.contract } : view === "input"
      ? { request: operation.contract.request, effects: operation.contract.effects, recovery: operation.contract.recovery }
      : { responses: operation.contract.responses, recovery: operation.contract.recovery }) };
}
