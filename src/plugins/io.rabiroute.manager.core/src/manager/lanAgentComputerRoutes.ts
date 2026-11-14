import { computerActionDefinition, assertComputerActionEnabled, computerRequestSchemaForDefinition, BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, type ComputerSettingsDefinition } from "@rabiroute/host-api/shared/agentInteractiveProtocol";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import type { ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { LAN_AGENT_INTERACTIVE_ROUTES, interactiveOperation, type InteractiveContext } from "./lanAgentInteractiveContract.js";

export function createLanAgentComputerOperations(context: InteractiveContext & {computerSettingsDefinition?:ComputerSettingsDefinition}): readonly ApiOperationDefinition[] {
  return LAN_AGENT_INTERACTIVE_ROUTES.filter(route => route.key === "computer.execute").map(route => {
    const operation = interactiveOperation(route, context, async (input, guard) => {
    const body = input.body as Record<string, unknown>, instanceId = input.path.instanceId!;
    const computerDefinition=context.computerSettingsDefinition??context.registry.getComputerSettingsDefinition?.()??BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION;
    const definition = computerDefinition.actionDefinition(String(body.action)), capability = definition?.capability;
    if (!definition?.receipt && !definition?.recovery) computerDefinition.assertAction(context.registry.getComputerSettingsRaw(instanceId), String(body.action), instanceId);
    // The target owner checks actual execution support after original receipt lookup.
    // Cached discovery metadata is not a permission or a substitute for that owner.
    if (!capability) throw new Error("Unknown computer action; read the current computer action contract.");
    assertTrustedLanAgentPrincipal(input.request);
    const execution = { ...context.registry.computerExecutionSource(input.request), signal: input.signal };
    let data: unknown;
    try { data = await context.registry.manageAgent(instanceId, "computer", body, 45000, guard, execution); }
    catch (error) {
      // Old connectors use an exception for an ordinary missing-upload status read.
      if (body.action !== "upload.status" || !(error instanceof Error)
        || error.message !== "Upload not found; do not create a new ID after an uncertain write.") throw error;
      data = { uploadId: body.uploadId, state: "absent" };
    }
    guard();
    if (definition?.readOnly && !definition.recovery) computerDefinition.assertAction(context.registry.getComputerSettingsRaw(instanceId), String(body.action), instanceId);
    return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data } };
  });
    const definition=context.computerSettingsDefinition??context.registry.getComputerSettingsDefinition?.()??BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION;
    const contract=operation.contract;
    const successResponse=contract.responses["200"]!;
    if (contract.request.body.kind !== "json") throw new TypeError("Computer execution requires its existing JSON request contract.");
    return {...operation,contract:{...contract,
      request:{...contract.request,body:{...contract.request.body,schema:computerRequestSchemaForDefinition(definition)}},
      responses:{...contract.responses,"200":{...successResponse,schema:{
        ...(successResponse.schema as Record<string,unknown>),
        "x-rabiroute-media":[
          {path:"/data",type:"image",matchMimeType:"image/*"},
          {path:"/data/capture",type:"image",matchMimeType:"image/*"}
        ]
      }}},
      effects:{...contract.effects,request:{bodyPath:["action"],modes:Object.fromEntries(Object.entries(definition.actions).map(([key,value])=>[key,value.readOnly?"read":"write"])) as Record<string,"read"|"write">}}
    }};
  });
}
