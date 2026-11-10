import { createHash } from "node:crypto";
import { ApiContractError, type ApiOperationContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { automationTemplateCatalog, DEFAULT_AUTOMATION_TEMPLATES } from "../automation/automationTemplates.js";

export type AutomationTemplateContext = { readAutomationTemplates?: () => readonly unknown[] | Promise<readonly unknown[]> };
const emptySources: readonly unknown[] = Object.freeze([]);
const empty = { type: "object", additionalProperties: false } as const;
const json = { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: { type: "object" } } } } as const;

/** Current plugin metadata is normalized once per immutable source snapshot. */
export function createAutomationTemplateOperations(context: AutomationTemplateContext): readonly ApiOperationDefinition[] {
  let previous: readonly unknown[] | undefined;
  let catalog = automationTemplateCatalog();
  let revision = "";
  async function current() {
    const sources = await context.readAutomationTemplates?.() ?? emptySources;
    if (sources !== previous) {
      catalog = automationTemplateCatalog(sources);
      revision = createHash("sha256").update(JSON.stringify(catalog.items)).digest("hex");
      previous = sources;
    }
    return { ...catalog, revision };
  }
  const contract = (detail: boolean): ApiOperationContract => ({
    operationId: "manager.personas.automation.templates." + (detail ? "read" : "list"), contractVersion: "1.0.0", method: "GET",
    pathTemplate: "/api/automation/templates" + (detail ? "/:templateId" : ""), exposure: "public", transport: "http",
    description: detail ? "Read one current plugin automation template and its complete editable action." : "List small editable automation template summaries from current plugins.",
    request: { path: detail ? { type: "object", required: ["templateId"], properties: { templateId: { type: "string", minLength: 1 } }, additionalProperties: false } : empty,
      query: detail ? empty : { type: "object", additionalProperties: false, properties: {
        query: { type: "string" }, cursor: { type: "string", minLength: 1 }, limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$" }
      } }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": json }, effects: { mode: "read", description: "Read template definitions without creating or dispatching rules." },
    recovery: { strategy: "repeatable-read", description: "Keep user-edited rules. Retain template id; refresh the summary after a changed catalog cursor." }, validators: []
  });
  const listContract = contract(false), detailContract = contract(true);
  return [{ contract: listContract,
    discovery: { title: "自动化投递模板", category: { id: "automation", title: "自动化规则与事件" }, tags: ["模板", "定时", "记忆", "Skill"], automationTemplates: DEFAULT_AUTOMATION_TEMPLATES },
    async handler(input) {
      const source = await current(), query = String(input.query.query ?? "").trim().toLocaleLowerCase();
      const matches = source.items.filter(item => !query || `${item.id} ${item.title} ${item.description}`.toLocaleLowerCase().includes(query));
      let offset = 0;
      if (input.query.cursor) {
        let cursor: { revision?: string; query?: string; offset?: number };
        try { cursor = JSON.parse(Buffer.from(String(input.query.cursor), "base64url").toString("utf8")); }
        catch { throw new ApiContractError(400, "AUTOMATION_TEMPLATE_CURSOR_INVALID", "cursor", listContract.operationId); }
        if (!cursor || cursor.revision !== source.revision || cursor.query !== query) throw new ApiContractError(409, "AUTOMATION_TEMPLATE_CATALOG_CHANGED", "cursor", listContract.operationId);
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! > matches.length) throw new ApiContractError(400, "AUTOMATION_TEMPLATE_CURSOR_INVALID", "cursor", listContract.operationId);
        offset = cursor.offset!;
      }
      const end = Math.min(offset + Number(input.query.limit ?? 20), matches.length);
      const items = matches.slice(offset, end).map(({ action: _action, ...summary }) => summary);
      const nextCursor = end < matches.length ? Buffer.from(JSON.stringify({ revision: source.revision, query, offset: end })).toString("base64url") : null;
      return { status: 200, headers: { "cache-control": "no-cache" }, body: { code: 0, data: { schemaVersion: "1", revision: source.revision, items, total: matches.length, nextCursor, warnings: source.warnings } } };
    }
  }, { contract: detailContract, async handler(input) {
    const source = await current(), item = source.items.find(template => template.id === input.path.templateId);
    if (!item) throw new ApiContractError(404, "AUTOMATION_TEMPLATE_NOT_FOUND", "templateId", detailContract.operationId);
    return { status: 200, headers: { "cache-control": "no-cache", etag: '"' + createHash("sha256").update(JSON.stringify(item)).digest("hex") + '"' }, body: { code: 0, data: { schemaVersion: "1", revision: source.revision, template: item } } };
  } }];
}
