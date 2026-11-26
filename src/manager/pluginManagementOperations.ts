import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";
import { createPluginCatalogOwner, type PluginCatalogAction } from "./pluginCatalogOwner.js";
import type { PluginCatalogApiContext } from "./pluginCatalogRoutes.js";

/** Bootstrap-owned management stays reachable when a business plugin is disabled. */
export function createPluginManagementOperations(context: PluginCatalogApiContext, readOnly = false): readonly ApiOperationDefinition[] {
  const owner = createPluginCatalogOwner(context, readOnly);
  const instanceOperations = [false, true].map<ApiOperationDefinition>(update => {
    const action = update ? "instances.update" : "instances.read";
    const empty = { type: "object", additionalProperties: false };
    const contract: ApiOperationContract = {
      operationId: `manager.plugins.${action}`, contractVersion: "1.1.0", method: update ? "PATCH" : "GET",
      pathTemplate: update ? "/api/plugins/instances/:id" : "/api/plugins/instances", exposure: "public", transport: "http",
      description: update ? "Set the enabled state or select an installed version of the same plugin instance with revision CAS. Version selection preserves the enabled state unless explicitly supplied. Read actual lifecycle status separately."
        : "List configured plugin instances, including disabled and failed instances, without exposing raw configuration.",
      request: {
        path: update ? { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 } } } : empty,
        query: empty, headers: { type: "object" },
        body: update ? { kind: "json", maxBytes: 2048, schema: { type: "object", required: ["expectedRevision"], minProperties: 2, additionalProperties: false,
          properties: { expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" }, enabled: { type: "boolean" },
            version: { type: "string", pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$" } } } } : { kind: "none" }
      },
      responses: {
        "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "data"], properties: {
          code: { const: 0 }, data: { type: "object", required: ["applicationGenerationId", "managerInstanceId", "revision", "instances"], properties: {
            applicationGenerationId: { type: "string", minLength: 1 }, managerInstanceId: { type: "string", minLength: 1 },
            revision: { type: "string" }, removedInstances: { type: "array", items: { type: "object", required: ["instanceId", "pluginId", "version"], properties: {
              instanceId: { type: "string" }, pluginId: { type: "string" }, version: { type: "string" }
            } } }, instances: { type: "array", items: { type: "object", required: ["instanceId", "pluginId", "version", "enabled", "status"], properties: {
              instanceId: { type: "string" }, pluginId: { type: "string" }, version: { type: "string" }, runningVersion: { type: "string" }, enabled: { type: "boolean" }, status: { type: "string" }
            } } }
          } }
        } } },
        default: { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" },
          errorCode: { type: "string" }, field: { type: "string" }, repair: { type: "string" }, retryable: { const: false },
          help: { type: "object", required: ["method", "path"], properties: { method: { const: "GET" }, path: { type: "string" } }, additionalProperties: false } }, additionalProperties: true } }
      },
      effects: { mode: update ? "native-plugin-settings" : "read", description: update
        ? "Persist only this instance's override, preserving immutable package defaults and other instance settings; original Kernel ownership tracks initialization and retirement."
        : "Read original profile settings and actual native activation state. Do not start plugins or disclose credentials." },
      recovery: { strategy: update ? "native-settings-readback-no-replay" : "repeatable-read", description: update
        ? "After an uncertain result reread GET /api/plugins/instances; never replay an old revision or report an enabled setting as active execution."
        : "Read again against the current application identity." },
      validators: [{ id: "plugins.original-source-lease", description: "Bind the original authenticated source, owner and application identity before parsing; recheck at durable settings write and native publication." }]
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const bound = owner.prepare(input.request, action, input.signal);
      return (parsed: ApiOperationInput) => {
        const body = parsed.body as { expectedRevision?: string; enabled?: boolean; version?: string } | undefined;
        return bound.execute({ id: parsed.path.id, expectedRevision: body?.expectedRevision, enabled: body?.enabled, version: body?.version });
      };
    };
    return { contract, discovery: {
      title: update ? '修改插件实例状态或切换版本' : '查看插件实例运行状态',
      summary: update ? '使用当前 revision 修改启用状态，或选择原实例所属插件的已导入版本，再读取实际 runningVersion 和状态。' : '读取插件实例、可恢复的卸载实例、实际运行版本及当前 revision。',
      category: { id: 'runtime', title: '插件与运行' }, keywords: ['插件', '查看插件', 'plugin instances', update ? '启用插件' : 'plugin status'],
      ...(update ? { inputSources: [
        { field: 'path.id', operationId: 'manager.plugins.instances.read', resultPath: '/data/instances', valuePath: '/instanceId' },
        { field: 'body.expectedRevision', operationId: 'manager.plugins.instances.read', resultPath: '/data/revision' },
        { field: 'body.version', operationId: 'manager.plugins.packages.list', resultPath: '/data/packages', valuePath: '/version' }
      ] } : {}), relatedOperations: ['manager.plugins.packages.list', 'manager.plugins.instances.read']
    }, prepare, handler: input => prepare(input)(input) };
  });
  const revision = { type: "string", pattern: "^[a-f0-9]{64}$" };
  const symbol = { type: "string", minLength: 1 };
  const additions: { action: PluginCatalogAction; method: "GET" | "POST" | "DELETE"; path: string; description: string; body?: Record<string, unknown> }[] = [
    { action: "packages.list", method: "GET", path: "/api/plugins/packages", description: "List installed package versions available for plugin installation without executing them." },
    { action: "packages.import", method: "POST", path: "/api/plugins/packages", description: "Import a local SDK-built plugin directory into the persistent package store; existing version bytes remain immutable.",
      body: { type: "object", additionalProperties: false, required: ["sourceDirectory"], properties: { sourceDirectory: symbol } } },
    { action: "packages.inspectUrl", method: "POST", path: "/api/plugins/packages/inspect", description: "Download a plugin archive from an https URL and return its manifest for review without installing it.",
      body: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 8 }, subdirectory: { type: "string" } } } },
    { action: "packages.importUrl", method: "POST", path: "/api/plugins/packages/from-url", description: "Download and import a plugin archive from an https URL after the reviewed archive digest is confirmed.",
      body: { type: "object", additionalProperties: false, required: ["url", "expectedArchiveSha256"], properties: { url: { type: "string", minLength: 8 }, expectedArchiveSha256: revision, subdirectory: { type: "string" } } } },
    { action: "instances.install", method: "POST", path: "/api/plugins/instances", description: "Install or restore a plugin instance and initialize it asynchronously; user data retains its original instance identity.",
      body: { type: "object", additionalProperties: false, required: ["expectedRevision", "pluginId", "version"], properties: { expectedRevision: revision, pluginId: symbol, version: symbol, instanceId: symbol } } },
    { action: "instances.remove", method: "DELETE", path: "/api/plugins/instances/:id", description: "Uninstall an instance through the original lifecycle owner, preserving stored configuration and user data.",
      body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: { expectedRevision: revision } } }
  ];
  const packageOperations: ApiOperationDefinition[] = additions.map(item => {
    const mutation = item.method !== "GET";
    const contract: ApiOperationContract = {
      operationId: `manager.plugins.${item.action}`, contractVersion: "1.0.0", method: item.method, pathTemplate: item.path,
      exposure: "public", transport: "http", description: item.description,
      request: {
        path: item.path.includes(":id") ? { type: "object", required: ["id"], additionalProperties: false, properties: { id: symbol } } : { type: "object", additionalProperties: false },
        query: { type: "object", additionalProperties: false }, headers: { type: "object" },
        body: item.body ? { kind: "json", maxBytes: 0, schema: item.body } : { kind: "none" }
      },
      responses: {
        "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: { type: "object", ...(item.action.startsWith("packages.") ? { properties: {
          packages: { type: "array", items: { type: "object" } }, partial: { type: "boolean" }, diagnostics: { type: "array", items: { type: "object", required: ["root", "path", "code", "message"], properties: { root: symbol, path: symbol, code: symbol, message: symbol } } },
          ...(item.action === "packages.import" || item.action === "packages.importUrl" ? { importedPackage: { type: "object", required: ["id", "version", "revision"], properties: { id: symbol, version: symbol, revision } } } : {})
        } } : {}) } } } },
        default: { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" },
          errorCode: { type: "string" }, field: { type: "string" }, repair: { type: "string" }, retryable: { const: false },
          help: { type: "object", required: ["method", "path"], properties: { method: { const: "GET" }, path: { type: "string" } }, additionalProperties: false } }, additionalProperties: true } }
      },
      effects: { mode: mutation ? "native-plugin-settings" : "read", description: item.description },
      recovery: { strategy: mutation ? "native-settings-readback-no-replay" : "repeatable-read", description: "Read package availability and actual instance status after uncertain results; do not infer activation or stopped resources from a saved setting." },
      validators: []
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const bound = owner.prepare(input.request, item.action, input.signal);
      return (parsed: ApiOperationInput) => bound.execute({ ...(parsed.body as Record<string, string> ?? {}), id: parsed.path.id });
    };
    const titles: Partial<Record<PluginCatalogAction, string>> = { 'packages.list': '查看已安装插件包与版本', 'packages.import': '导入本地插件包', 'packages.inspectUrl': '预览 URL 插件包', 'packages.importUrl': '从 URL 安装插件包', 'instances.install': '安装插件实例', 'instances.remove': '卸载插件实例' };
    return { contract, discovery: {
      title: titles[item.action], summary: titles[item.action] + '。' + item.description,
      category: { id: 'runtime', title: '插件与运行' }, keywords: ['插件', titles[item.action]!, item.action.replaceAll('.', ' '), 'plugin packages'],
      relatedOperations: ['manager.plugins.packages.list', 'manager.plugins.instances.read'],
      ...(mutation && item.action !== 'packages.import' ? { inputSources: [
        { field: 'body.expectedRevision', operationId: 'manager.plugins.instances.read', resultPath: '/data/revision' },
        ...(item.action === 'instances.install' ? [
          { field: 'body.pluginId', operationId: 'manager.plugins.packages.list', resultPath: '/data/packages', valuePath: '/id' },
          { field: 'body.version', operationId: 'manager.plugins.packages.list', resultPath: '/data/packages', valuePath: '/version' }
        ] : [{ field: 'path.id', operationId: 'manager.plugins.instances.read', resultPath: '/data/instances', valuePath: '/instanceId' }])
      ] } : {})
    }, prepare, handler: input => prepare(input)(input) };
  });
  return [...instanceOperations, ...packageOperations];
}
