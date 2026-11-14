import type { AutomationTemplate } from "../../src/automation/automationTemplates";
export { DEFAULT_AUTOMATION_TEMPLATES, BLANK_AUTOMATION_TEMPLATE_ID, automationTemplatePatch } from "../../src/automation/automationTemplates";
export type { AutomationTemplate } from "../../src/automation/automationTemplates";
export type AutomationTemplateChoice = Omit<AutomationTemplate, "action"> & { action?: AutomationTemplate["action"] };
export type AutomationTemplatePage = { items: AutomationTemplateChoice[]; nextCursor: string | null; total: number };
async function read(fetcher: typeof fetch, path: string, signal: AbortSignal) {
  const response = await fetcher(path, { signal }), result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || "自动化模板暂时无法加载");
  return result.data;
}
export async function loadAutomationTemplates(fetcher: typeof fetch, signal: AbortSignal, cursor?: string): Promise<AutomationTemplatePage> {
  const query = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) });
  const data = await read(fetcher, "/api/automation/templates?" + query, signal);
  if (!Array.isArray(data?.items)) throw new Error("自动化模板暂时无法加载");
  return data;
}
export async function loadAutomationTemplate(fetcher: typeof fetch, signal: AbortSignal, id: string): Promise<AutomationTemplate> {
  const data = await read(fetcher, "/api/automation/templates/" + encodeURIComponent(id), signal);
  if (!data?.template || data.template.id !== id || data.template.action?.type !== "deliver_agent" || typeof data.template.action.message !== "string") throw new Error("自动化模板暂时无法加载");
  return data.template;
}
