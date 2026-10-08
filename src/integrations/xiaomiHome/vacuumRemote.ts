import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {executeDurableDelivery, readDurableDeliveryReceipt} from "../../manager/durableDeliveryIdempotency.js";
import {atomicWriteFileSync} from "../../shared/filePersistence.js";
import {recordDataMutationAudit} from "../../observability/dataMutationAudit.js";
import {XiaomiHomeManagerApiError, type XiaomiHomeManagerApiClient} from "./managerApi.js";

type Port = Pick<XiaomiHomeManagerApiClient,"getResource"|"getResourceActions"|"executeAction"|"listDevices">;
type Binding = {resourceId:string; watchdogResourceId:string};
export type VacuumRemoteSnapshot = {schemaVersion:1; sessionId:string; resourceId:string; state:"preparing"|"ready"|"moving"|"failed"|"stopped";
 stateVersion:string; startedAt:string; updatedAt:string; confirmation:"provider_acceptance"; error?:string};
type Session = {snapshot:VacuumRemoteSnapshot; binding:Binding; prefix:string; initialized:boolean; abort?:AbortController; pending?:Promise<unknown>; stopping?:Promise<VacuumRemoteSnapshot>; closing?:Promise<VacuumRemoteSnapshot>};
const namespace="xiaomi-vacuum-remote";
// Direction values are the pv11cn v61 protocol, shared by web and Agent callers.
const contracts:Readonly<Record<string,{enter:string;exit:string;remote:string;fault:string;repeatIntervalMs:number;directions:Readonly<Record<string,readonly [number,number]>>}>>={
 "xiaomi.vacuum.pv11cn":{enter:"_enter_remote_a_2_28",exit:"_exit_remote_a_2_29",remote:"_remote_control_a_2_26",fault:"_fault_p_2_3",repeatIntervalMs:200,directions:{forward:[1,2],left:[3,4],right:[5,6]}}
};
const fail=(message:string,status=409)=>new XiaomiHomeManagerApiError(status,"xiaomi_vacuum_remote_rejected",message);

/** HA owns physical control and the independent release timer; this owner serializes remote sessions. */
export class VacuumRemoteController {
 private active?:Session;
 private disposed=false;
 constructor(private readonly root:string,private readonly client:()=>Port){}
 private bindings():Binding[]{
  const file=path.join(this.root,"vacuum-remote-bindings.json");if(!fs.existsSync(file))return [];
  const raw=JSON.parse(fs.readFileSync(file,"utf8"));
  if(raw.schemaVersion!==1 || !Array.isArray(raw.bindings) || raw.bindings.length>64)throw fail("遥控绑定文件格式无效。",500);
  const ids=new Set<string>();
  for(const item of raw.bindings){if(!item || Object.keys(item).some(k=>!["resourceId","watchdogResourceId"].includes(k)) || !/^home:ha:vacuum\.[a-z0-9_]+$/.test(item.resourceId) || !/^home:ha:timer\.[a-z0-9_]+$/.test(item.watchdogResourceId) || ids.has(item.resourceId))throw fail("遥控绑定必须指定唯一的扫地机和 HA 松键计时器。",500);ids.add(item.resourceId);}
  return raw.bindings;
 }
 async capabilities(resourceId:string){
  const directory=await this.client().listDevices();const device=directory.devices.find(d=>d.resources.some(r=>r.resourceId===resourceId && r.kind==="vacuum"));
  const contract=device && contracts[device.model], binding=this.bindings().find(b=>b.resourceId===resourceId);
  if(!contract || !binding)return {available:false,reason:!contract?"该型号尚未核对遥控协议。":"尚未绑定 HA 独立松键计时器。",directions:[]};
  const vacuum=await this.client().getResource(resourceId);
  const prefix=vacuum.entityId.split(".")[1];
  const required=["button."+prefix+contract.enter,"button."+prefix+contract.exit,"notify."+prefix+contract.remote,"sensor."+prefix+contract.fault];
  if(required.some(id=>!device!.resources.some(r=>r.entityId===id)))throw fail("设备的遥控实体不完整。");
  const actions=await Promise.all(required.slice(0,3).map(id=>this.client().getResourceActions("home:ha:"+id)));
  const revisions=actions.map((r,i)=>r.actions?.find(a=>a.action===(i===2?"send_message":"press"))?.revision);
  if(revisions.some(r=>!r))throw fail("HA 未公布所需遥控动作。");
  const timer=await this.client().getResourceActions(binding.watchdogResourceId);
  if(!timer.actions?.some(a=>a.action==="start") || !timer.actions.some(a=>a.action==="cancel"))throw fail("HA 松键计时器动作缺失。");
  const pause=(await this.client().getResourceActions(resourceId)).actions?.find(a=>a.action==="pause")?.revision;
  const protocolRevision="vacuum-remote:"+createHash("sha256").update(JSON.stringify({model:device!.model,binding,contract,revisions,pause})).digest("hex").slice(0,24);
  const activeSession=this.active?.snapshot.resourceId===resourceId && this.active.snapshot.state!=="stopped"?{...this.active.snapshot}:undefined;
  return {available:true,resourceId,expectedStateVersion:vacuum.stateVersion,protocolRevision,directions:Object.keys(contract.directions),minDurationMs:100,maxDurationMs:500,repeatIntervalMs:contract.repeatIntervalMs,initializationMs:2000,pauseBeforeEnter:vacuum.state==="cleaning",activeSession,confirmation:"provider_acceptance",coordinateNavigation:false};
 }
 private save(session:Session){
  session.snapshot.updatedAt=new Date().toISOString();session.snapshot.stateVersion="remote:"+randomUUID();
  atomicWriteFileSync(path.join(this.root,"vacuum-remote-sessions",session.snapshot.sessionId+".json"),JSON.stringify(session.snapshot),{mode:0o600});
  recordDataMutationAudit({group:"integration.xiaomi-home",event:"vacuum.remote",owner:"VacuumRemoteController",action:"remote.session",target:{type:"remote-session",id:session.snapshot.sessionId},dataSource:{kind:"runtime",id:session.snapshot.resourceId},outcome:session.snapshot.state==="failed"?"failed":session.snapshot.state==="stopped"?"cancelled":"committed",result:session.snapshot.state});
 }
 status(sessionId:string):VacuumRemoteSnapshot{
  if(!/^[0-9a-f-]{36}$/.test(sessionId))throw fail("遥控会话 ID 无效。",400);
  if(this.active?.snapshot.sessionId===sessionId)return {...this.active.snapshot};
  const file=path.join(this.root,"vacuum-remote-sessions",sessionId+".json");if(!fs.existsSync(file))throw fail("遥控会话不存在。",404);
  const snapshot=JSON.parse(fs.readFileSync(file,"utf8")) as VacuumRemoteSnapshot;
  return {...snapshot,...(!["stopped","failed"].includes(snapshot.state)?{state:"stopped" as const,error:"manager_restarted"}:{})};
 }
 receipt(key:string){const value=readDurableDeliveryReceipt<VacuumRemoteSnapshot>(this.root,namespace,key);if(!value)throw fail("未找到原动作回执。",404);return {state:value.state,result:value.result};}
 private session(id:unknown){if(typeof id!=="string" || this.active?.snapshot.sessionId!==id || this.active.snapshot.state==="stopped")throw fail("遥控会话已结束，请查询原会话。");return this.active;}
 private async action(session:Session,entity:string,action:string,parameters:Record<string,unknown>,key:string){
  const fresh=await this.client().getResourceActions(entity), selected=fresh.actions?.find(a=>a.action===action);if(!selected || fresh.state==="unavailable")throw fail("遥控动作不可用。");
  const receipt=await this.client().executeAction({resourceId:entity,capability:"home.entity.action@1",arguments:{action,actionRevision:selected.revision,parameters},expectedStateVersion:fresh.stateVersion,reason:"Shared vacuum remote session",dryRun:false},key);
  if(!["accepted","succeeded"].includes(receipt.status))throw fail("设备动作未确认受理："+(receipt.error || receipt.status));
 }
 private async direction(session:Session,code:number,key:string){await this.action(session,"home:ha:notify."+session.prefix+contracts["xiaomi.vacuum.pv11cn"].remote,"send_message",{values:[code]},key);}
 private async release(session:Session,key:string){
  const errors:unknown[]=[];
  for(const code of [2,4,6]){try{await this.direction(session,code,key+"-release-"+code);}catch(e){errors.push(e);}}
  if(errors.length)throw fail("松键结果未确认；HA 独立计时器将尝试停止，请在设备旁核对。");
  await this.action(session,session.binding.watchdogResourceId,"cancel",{},key+"-watchdog-cancel");
 }
 async command(command:string,body:Record<string,unknown>,key:string){
  if(!/^[A-Za-z0-9._:-]{16,128}$/.test(key))throw fail("需要稳定的动作键。",400);
  const fields:Record<string,string[]>={start:["resourceId","expectedStateVersion","protocolRevision"],pulse:["sessionId","expectedStateVersion","direction","durationMs"],stop:["sessionId"],exit:["sessionId"]};
  if(!fields[command] || !body || Array.isArray(body) || Object.keys(body).some(k=>!fields[command].includes(k)))throw fail("遥控参数无效。",400);
  return executeDurableDelivery<VacuumRemoteSnapshot>({rootDir:this.root,namespace,deliveryId:key,payload:{command,body},waitForCompletionMs:15000,deliver:async()=>{
   if(this.disposed)throw fail("遥控服务已停止。");
   if(command==="start")return this.start(body,key);
   const session=this.session(body.sessionId);
   if(command==="pulse")return this.pulse(session,body,key);
   if(command==="exit")return this.exit(session,key);
   return this.stop(session,key);
  }});
 }
 private async start(body:Record<string,unknown>,key:string){
  if(this.active && this.active.snapshot.state!=="stopped")throw fail("已有遥控会话；先退出原会话，避免控制冲突。");
  const caps=await this.capabilities(String(body.resourceId));if(!caps.available || caps.protocolRevision!==body.protocolRevision || caps.expectedStateVersion!==body.expectedStateVersion)throw fail("能力或状态已变化，请重新读取遥控能力。");
  const binding=this.bindings().find(b=>b.resourceId===body.resourceId)!;
  const vacuum=await this.client().getResource(binding.resourceId);if(!["docked","idle","paused","cleaning"].includes(vacuum.state))throw fail("设备当前忙碌或离线。");
  const prefix=vacuum.entityId.split(".")[1];const fault=await this.client().getResource("home:ha:sensor."+prefix+contracts["xiaomi.vacuum.pv11cn"].fault);if(fault.state!=="0")throw fail("设备存在故障或故障状态未确认。");
  const session:Session={binding,prefix,initialized:false,snapshot:{schemaVersion:1,sessionId:randomUUID(),resourceId:binding.resourceId,state:"preparing",stateVersion:"",startedAt:new Date().toISOString(),updatedAt:"",confirmation:"provider_acceptance"}};
  // Publish ownership before yielding so two simultaneous clients cannot enter competing sessions.
  if(this.active && this.active.snapshot.state!=="stopped")throw fail("已有遥控会话。");this.active=session;this.save(session);
  const abort=new AbortController();session.abort=abort;
  const run=(async()=>{try{
   if(vacuum.state==="cleaning"){
    await this.action(session,binding.resourceId,"pause",{},key+"-pause");
    let paused=false;
    for(let attempt=0;attempt<10 && !abort.signal.aborted;attempt++){
     if((await this.client().getResource(binding.resourceId)).state==="paused"){paused=true;break;}
     await delay(500,undefined,{signal:abort.signal});
    }
    if(!paused)throw fail("清扫暂停尚未确认，未进入遥控。");
   }
   if(abort.signal.aborted)throw fail("进入遥控已取消。");
   await this.action(session,binding.watchdogResourceId,"start",{duration:"00:00:07"},key+"-watchdog");
   if(abort.signal.aborted)throw fail("进入遥控已取消。");
   await this.action(session,"home:ha:button."+prefix+contracts["xiaomi.vacuum.pv11cn"].enter,"press",{},key+"-enter");
   await delay(2000,undefined,{signal:abort.signal});
   await this.action(session,binding.watchdogResourceId,"cancel",{},key+"-watchdog-cancel");
   session.initialized=true;session.snapshot.state="ready";
  }catch(e){session.snapshot.state="failed";session.snapshot.error=(e as Error).message;}
  this.save(session);return {...session.snapshot};})();session.pending=run;
  try{return await run;}finally{if(session.pending===run){session.pending=undefined;session.abort=undefined;}}
 }
 private async pulse(session:Session,body:Record<string,unknown>,key:string){
  const contract=contracts["xiaomi.vacuum.pv11cn"],code=contract.directions[String(body.direction)],duration=body.durationMs;
  if(!code || typeof duration!=="number" || !Number.isInteger(duration) || duration<100 || duration>500)throw fail("只支持前进、左转、右转，单次100–500毫秒。",400);
  if(!session.initialized || session.snapshot.state!=="ready" || session.pending || session.stopping || session.closing || session.snapshot.stateVersion!==body.expectedStateVersion)throw fail("遥控正在执行或状态已变化；先读回状态。");
  const abort=new AbortController();session.abort=abort;session.snapshot.state="moving";this.save(session);
  const run=(async()=>{
   let error:unknown;
   try{
    const vacuum=await this.client().getResource(session.binding.resourceId);
    const fault=await this.client().getResource("home:ha:sensor."+session.prefix+contracts["xiaomi.vacuum.pv11cn"].fault);
    if(!["idle","paused","docked"].includes(vacuum.state) || fault.state!=="0")throw fail("设备状态变化，未发送方向指令。");
    await this.action(session,session.binding.watchdogResourceId,"start",{duration:"00:00:07"},key+"-watchdog");
    // The official video remote repeats while held. Serialize sends inside one absolute
    // pulse window; delayed HA responses must never extend it or trigger a catch-up burst.
    const started=performance.now(),deadline=started+duration;
    if(!abort.signal.aborted)await this.direction(session,code[0],key+"-down");
    for(let slot=1;slot*contract.repeatIntervalMs<duration && !abort.signal.aborted;slot++){
     const due=started+slot*contract.repeatIntervalMs,wait=due-performance.now();
     if(wait>0)await delay(wait,undefined,{signal:abort.signal});
     const now=performance.now();
     if(abort.signal.aborted || now>=deadline)break;
     if(now-due>=contract.repeatIntervalMs)continue;
     await this.direction(session,code[0],key+"-down-"+slot);
    }
    const remaining=deadline-performance.now();
    if(remaining>0 && !abort.signal.aborted)await delay(remaining,undefined,{signal:abort.signal});
   }catch(e){if(!(abort.signal.aborted && e instanceof Error && e.name==="AbortError"))error=e;}
   finally{try{await this.direction(session,code[1],key+"-up");await this.action(session,session.binding.watchdogResourceId,"cancel",{},key+"-watchdog-cancel");}catch(e){error=e;}}
   session.snapshot.state=error?"failed":"ready";if(error){session.initialized=false;session.snapshot.error=(error as Error).message;}this.save(session);return {...session.snapshot};
  })();session.pending=run;
  try{return await run;}finally{if(session.pending===run){session.pending=undefined;session.abort=undefined;}}
 }
 private stop(session:Session,key:string):Promise<VacuumRemoteSnapshot>{
  if(session.closing)return session.closing;if(session.stopping)return session.stopping;
  const prepared=session.initialized;session.abort?.abort();
  const run=(async()=>{await session.pending?.catch(()=>undefined);session.snapshot.state="preparing";this.save(session);
   try{await this.release(session,key);session.snapshot.state=prepared && session.initialized?"ready":"failed";if(session.snapshot.state==="ready")delete session.snapshot.error;else session.snapshot.error="遥控初始化或松键未确认，请退出后重新进入。";}catch(e){session.initialized=false;session.snapshot.state="failed";session.snapshot.error=(e as Error).message;}
   this.save(session);return {...session.snapshot};})();session.stopping=run;
  void run.finally(()=>{if(session.stopping===run)session.stopping=undefined;}).catch(()=>undefined);return run;
 }
 private exit(session:Session,key:string):Promise<VacuumRemoteSnapshot>{
  if(session.closing)return session.closing;
  session.abort?.abort();session.closing=(async()=>{await session.pending?.catch(()=>undefined);await session.stopping?.catch(()=>undefined);try{await this.release(session,key);await this.action(session,"home:ha:button."+session.prefix+contracts["xiaomi.vacuum.pv11cn"].exit,"press",{},key+"-exit");session.snapshot.state="stopped";}catch(e){session.snapshot.state="failed";session.snapshot.error=(e as Error).message;}this.save(session);return {...session.snapshot};})();return session.closing;
 }
 async shutdown(){this.disposed=true;if(this.active && this.active.snapshot.state!=="stopped")await this.exit(this.active,"remote-shutdown-"+this.active.snapshot.sessionId);}
 assertInactive(){if(this.active && this.active.snapshot.state!=="stopped")throw fail("请先退出遥控，再修改 Home Assistant 连接。");}
}
