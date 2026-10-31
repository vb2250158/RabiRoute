import type http from "node:http";
import type { XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";
import { createXiaomiHomeManagerOperations } from "./managerOperations.js";
import { compileApiOperation, apiPathParameters, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult } from "../../manager/apiOperationContract.js";

export type XiaomiHomeOperationFixtureContext = XiaomiHomeManagerRoutesContext & {
  readJsonBody<T>(request: http.IncomingMessage): Promise<T>;
  jsonResponse(response: http.ServerResponse, status: number, body: unknown): void;
};
const fixtureDefinitions = new WeakMap<XiaomiHomeOperationFixtureContext, ReturnType<typeof compileDefinitions>>();
function compileDefinitions(context: XiaomiHomeOperationFixtureContext) {
  return { runtime: context.runtime, operations: createXiaomiHomeManagerOperations(context).operations.map(definition => ({ definition, compiled: compileApiOperation(definition) })) };
}

/** Controlled native test fixtures use the real executable definitions; production never imports this adapter. */
export function invokeFixtureXiaomiOperation(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: XiaomiHomeOperationFixtureContext): boolean {
  let cached = fixtureDefinitions.get(context); if (!cached || cached.runtime !== context.runtime) { cached = compileDefinitions(context); fixtureDefinitions.set(context, cached); }
  const selected = cached.operations.find(({ compiled }) => compiled.contract.method === request.method && compiled.pathPattern.test(url.pathname));
  if (!selected) { context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_route_not_found" } }); return true; }
  let path: Record<string, string>;
  try { const parameters = apiPathParameters(selected.compiled, url.pathname); if (!parameters) throw new Error("Fixture path no longer matches its selected contract."); path = parameters; }
  catch { context.jsonResponse(response, 400, { code: -1, error: { code: "xiaomi_home_path_invalid" } }); return true; }
  const controller = new AbortController();
  response.once?.("close", () => controller.abort());
  const input = { request, response, url, path, query: Object.fromEntries(url.searchParams), signal: controller.signal };
  const output = async (result: ApiOperationResult) => {
    if (result.stream) {
      response.writeHead(result.status, { "Content-Type": "text/event-stream" }); response.flushHeaders();
      const close = () => { void result.stream!.cancel(new Error("Fixture response closed.")); };
      response.once("close", close);
      try { for await (const frame of result.stream.frames) response.write(`event: ${(frame as any).event}\ndata: ${JSON.stringify((frame as any).data)}\n\n`); }
      finally { await result.stream.cancel(new Error("Fixture stream finished.")); response.off("close", close); }
    } else context.jsonResponse(response, result.status, result.body);
  };
  const execute = (prepared: ApiOperationDefinition["handler"] | ApiOperationResult) => {
    if (typeof prepared !== "function") { if (prepared.stream) void output(prepared); else context.jsonResponse(response, prepared.status, prepared.body); return; }
    const body = selected.compiled.contract.request.body.kind === "json" ? context.readJsonBody(request) : Promise.resolve(undefined);
    void body.then(value => prepared({ ...input, body: value })).then(output);
  };
  const prepared = selected.definition.prepare?.(input) ?? selected.definition.handler;
  if (prepared instanceof Promise) void prepared.then(execute); else execute(prepared);
  return true;
}
