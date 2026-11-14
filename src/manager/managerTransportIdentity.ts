import type http from "node:http";
import { MANAGER_TRANSPORT_ABI, MANAGER_CONTEXT_HEADER, EXPECTED_MANAGER_GENERATION_HEADER,
  EXPECTED_MANAGER_INSTANCE_HEADER, type ManagerTransportContext } from "../../apps/rabi-agent/lib/manager-transport-contract.mjs";

type Identity = Omit<ManagerTransportContext,"abi">;
/** One ingress owner supplies response facts; proxied business responses cannot impersonate that owner. */
export function createManagerTransportIdentity(read: () => Identity) {
  let previous: Identity | undefined, captured: ManagerTransportContext, serialized = "";
  const current = () => {
    const next = read();
    if (!previous || previous.applicationGenerationId !== next.applicationGenerationId || previous.managerInstanceId !== next.managerInstanceId || previous.metadataRevision !== next.metadataRevision) {
      captured = Object.freeze({ abi: MANAGER_TRANSPORT_ABI, ...next }); previous = captured; serialized = JSON.stringify(captured);
    }
    return captured;
  };
  const cleanHeaders = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      const result: unknown[]=[];
      for(let index=0;index<input.length;index+=2)if(String(input[index]).toLowerCase()!==MANAGER_CONTEXT_HEADER)result.push(input[index],input[index+1]);
      return result;
    }
    if(input && typeof input==="object")return Object.fromEntries(Object.entries(input).filter(([name])=>name.toLowerCase()!==MANAGER_CONTEXT_HEADER));
    return input;
  };
  return Object.freeze({
    protocolInfo() { const context = current(); return Object.freeze({ abi: MANAGER_TRANSPORT_ABI, metadataRevision: context.metadataRevision }); },
    capture(response: http.ServerResponse): ManagerTransportContext {
      const context = current(), header = serialized;
      const original = response.writeHead;
      response.setHeader(MANAGER_CONTEXT_HEADER, header);
      response.writeHead = function (this: http.ServerResponse, ...args: Parameters<http.ServerResponse["writeHead"]>) {
        const values: unknown[] = [...args];
        const index = typeof values[1] === "string" ? 2 : 1;
        if(values[index]!==undefined)values[index]=cleanHeaders(values[index]);
        this.setHeader(MANAGER_CONTEXT_HEADER, header);
        return Reflect.apply(original,this,values);
      } as typeof response.writeHead;
      return context;
    },
    rejectChanged(request: http.IncomingMessage, response: http.ServerResponse, context: ManagerTransportContext): boolean {
      const expectedGeneration = request.headers[EXPECTED_MANAGER_GENERATION_HEADER];
      const expectedInstance = request.headers[EXPECTED_MANAGER_INSTANCE_HEADER];
      if((expectedGeneration===undefined || expectedGeneration===context.applicationGenerationId)
        && (expectedInstance===undefined || expectedInstance===context.managerInstanceId))return false;
      response.writeHead(409,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      response.end(JSON.stringify({code:-1,errorCode:"MANAGER_IDENTITY_CHANGED",executionState:"not_started",
        message:"The intended Manager changed before this request was admitted. Rediscover the current Manager; the business handler was not invoked.",repair:{method:"GET",path:"/meta"}}));
      request.resume();return true;
    }
  });
}
