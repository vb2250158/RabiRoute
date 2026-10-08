import type { VacuumRemoteSnapshot } from "../../src/integrations/xiaomiHome/vacuumRemote";
export type RemoteSession = VacuumRemoteSnapshot;
export type RemoteCapabilities = {available:boolean;reason?:string;resourceId?:string;expectedStateVersion?:string;protocolRevision?:string;directions:string[];pauseBeforeEnter?:boolean;activeSession?:RemoteSession};
const root="/api/agent/xiaomi-home/vacuum-remote";
class RequestError extends Error {constructor(readonly status:number,message:string){super(message);}}
async function request<T>(url:string,init:RequestInit={}):Promise<T>{
 const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(30000),...init});const b=await r.json();
 if(!r.ok || b.code!==0)throw new RequestError(r.status,b.error?.message || b.message || "遥控请求失败。");return b.data;
}
async function identity(){
 const r=await fetch("/meta",{cache:"no-store",signal:AbortSignal.timeout(10000)});const m=await r.json();
 if(!r.ok || !m.applicationGenerationId || !m.managerInstanceId)throw Error("运行身份未确认，请刷新页面。");
 return {generation:String(m.applicationGenerationId),instance:String(m.managerInstanceId)};
}
async function write(command:string,body:Record<string,unknown>,key:string):Promise<RemoteSession>{
 const before=await identity();let outcome:{state:string;result?:RemoteSession;reason?:string};
 try{outcome=await request(root+"/"+command,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key,"x-rabiroute-expected-application-generation-id":before.generation,"x-rabiroute-expected-manager-instance-id":before.instance},body:JSON.stringify(body)});}
 catch(e){if(e instanceof RequestError && e.status<500)throw e;outcome=await request(root+"/status?"+new URLSearchParams({idempotencyKey:key}));}
 const after=await identity();
 if(before.generation!==after.generation || before.instance!==after.instance)throw Error("运行版本已变化，请查询原遥控会话。");
 if(outcome.state!=="completed" || !outcome.result)throw Error("动作结果尚未确认，请查询原动作回执；未重复发送。");return outcome.result;
}
export const vacuumRemoteClient={
 capabilities:(resourceId:string)=>request<RemoteCapabilities>(root+"/capabilities?"+new URLSearchParams({resourceId})),
 status:(sessionId:string)=>request<RemoteSession>(root+"/status?"+new URLSearchParams({sessionId})),
 start:(caps:RemoteCapabilities,key:string)=>write("start",{resourceId:caps.resourceId,expectedStateVersion:caps.expectedStateVersion,protocolRevision:caps.protocolRevision},key),
 pulse:(session:RemoteSession,direction:string,key:string)=>write("pulse",{sessionId:session.sessionId,expectedStateVersion:session.stateVersion,direction,durationMs:250},key),
 stop:(sessionId:string,key:string)=>write("stop",{sessionId},key),
 exit:(sessionId:string)=>write("exit",{sessionId},"remote-exit-"+sessionId)
};
