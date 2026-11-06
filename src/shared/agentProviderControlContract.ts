import type { ApiOperationContract } from "../manager/apiOperationContract.js";

export type CopilotInstallResult = { stdout?: string; stderr?: string };
export type CopilotLoginExitStatus = { done: boolean; exitCode: number | null; error: string };
export type CopilotLoginResult =
  | { kind: "device-code"; code: string; url: string | null; pid?: number }
  | { kind: "completed" }
  | { kind: "timeout"; error?: string }
  | { kind: "failed"; error: string };
export type AstrbotLoginTestResult = Record<string, unknown> & { ok: boolean };
export type CopilotControlOperationsContext = {
  installCopilot(): Promise<CopilotInstallResult>;
  startCopilotLogin(callbacks: { onExit(status: CopilotLoginExitStatus): void }): Promise<CopilotLoginResult>;
  getCopilotStatus(): Promise<Record<string, unknown>>;
  publishEvent(eventType: string, data: unknown): void;
};
const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
export function createAgentProviderControlOperationContract(operationId: string, method: "GET" | "POST", pathTemplate: string, description: string,
  responses: ApiOperationContract["responses"], effects: ApiOperationContract["effects"], recovery: ApiOperationContract["recovery"], allowIgnoredBody = false): ApiOperationContract {
  return { operationId, aliases: [`agent:${method}:${pathTemplate}`], contractVersion: "1.0.0", method, pathTemplate, description,
    exposure: "public", transport: "http", request: { path: empty, query: ignored, headers: ignored, body: { kind: "none", ...(allowIgnoredBody ? { allowIgnoredBody: true } : {}) } }, responses, effects, recovery,
    validators: [{ id: "native-provider-owner", description: "Use the original provider owner and native environment/path defaults. An authenticated enabled remote connection needs no extra feature grant, persona or Route binding. Unknown query fields are ignored." }] };
}
