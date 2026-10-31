import type http from 'node:http';
import path from 'node:path';
import { currentWearableHealthState,ingestWearableHealthObservation,queryWearableHealthHistory,readWearableHealthConfig,summarizeWearableHealth,updateWearableHealthConfig,type WearableHealthMetric,type WearableHealthObservationInput,type WearableHealthAlert } from '../wearableHealth.js';
import type { WearableHealthAlertDeliveryContext } from '../wearableHealthAlertDelivery.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';
export type PersonaHealthAction='config.read'|'config.patch'|'state'|'history'|'summary'|'observations';
export type PersonaHealthContext={
  roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity;
  lifecycleFence:PersonaResourceIdentity|null;managerPort:number;
  ingest?:typeof ingestWearableHealthObservation;
  deliverAlert(roleId:string,alert:WearableHealthAlert,context:WearableHealthAlertDeliveryContext):Promise<readonly unknown[]>;
};
function fail(statusCode:number,state:string,message:string):never{throw Object.assign(new Error(message),{statusCode,state});}
function fenceHeader(request:http.IncomingMessage,name:string):string{
  const value=request.headers[name];if(Array.isArray(value))return value.length===1?value[0]!.trim():'';
  const normalized=String(value??'').trim();return normalized.includes(',')?'':normalized;
}
function metrics(parameters:URLSearchParams):WearableHealthMetric[]|undefined{
  const values=parameters.getAll('metric').flatMap(value=>value.split(',')).map(value=>value.trim()).filter((value):value is WearableHealthMetric=>value==='heart_rate'||value==='sleep_session'||value==='sleep_stage'||value==='sleep_state');
  return values.length?[...new Set(values)]:undefined;
}
/** Original health store and optional alert router retain persistence and delivery ownership. */
export function createPersonaHealthOwner(context:PersonaHealthContext){
  return {prepare(request:http.IncomingMessage,roleId:string,action:PersonaHealthAction,signal?:AbortSignal){
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),roleDir=context.roleDirectory(roleId);
    const lifecycle=action==='observations'&&context.lifecycleFence?Object.freeze({...context.lifecycleFence}):null;
    let mutationStarted=false;
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Original role health directory changed.'),{statusCode:409});
      if(action==='observations'&&lifecycle&&(!context.lifecycleFence||context.lifecycleFence.applicationGenerationId!==lifecycle.applicationGenerationId||context.lifecycleFence.managerInstanceId!==lifecycle.managerInstanceId))fail(409,'stale_lifecycle_fence','Wearable observation lifecycle identity is stale.');};
    if(action==='observations'){
      if(!lifecycle)fail(503,'host_generation_unavailable','Wearable observations require a Host-owned Manager generation.');
      const generation=fenceHeader(request,'x-rabiroute-expected-application-generation-id'),instance=fenceHeader(request,'x-rabiroute-expected-manager-instance-id');
      if(!generation||!instance)fail(400,'invalid_lifecycle_fence','Wearable observations require complete Manager lifecycle fencing headers.');
      if(generation!==lifecycle.applicationGenerationId||instance!==lifecycle.managerInstanceId)fail(409,'stale_lifecycle_fence','Wearable observation lifecycle identity is stale.');
    }
    return {
      mutationOutcome:()=>mutationStarted?'unknown' as const:'not_started' as const,
      read(parameters:URLSearchParams){
        assertCurrent();const sourceDeviceId=parameters.get('sourceDeviceId')?.trim()||'',limit=Number(parameters.get('limit'));
        const query={sourceDeviceId,from:parameters.get('from')||undefined,to:parameters.get('to')||undefined,limit:Number.isFinite(limit)&&limit>0?limit:undefined};
        const data=action==='config.read'?readWearableHealthConfig(roleDir):action==='state'?currentWearableHealthState(roleDir,sourceDeviceId):action==='history'?queryWearableHealthHistory(roleDir,{...query,metrics:metrics(parameters),order:parameters.get('order')==='asc'?'asc':'desc'}):summarizeWearableHealth(roleDir,query);
        assertCurrent();return data;
      },
      async mutate(raw:unknown,parameters:URLSearchParams){
        assertCurrent();try{
          if(action==='config.patch'){mutationStarted=true;const data=updateWearableHealthConfig(roleDir,raw as {defaultPolicy?:unknown;devices?:unknown});assertCurrent();return data;}
          const body=raw as Record<string,unknown>,nested=body.health&&typeof body.health==='object'&&!Array.isArray(body.health)?body.health as Record<string,unknown>:{};
          const observation={...body,...nested,policy:nested.policy??body.policy,samples:nested.samples??body.samples} as WearableHealthObservationInput;
          assertCurrent();mutationStarted=true;const data=(context.ingest??ingestWearableHealthObservation)(roleDir,observation);assertCurrent();
          const deliverAlerts=['1','true','yes'].includes((parameters.get('deliverAlerts')||'').trim().toLowerCase());
          if(!deliverAlerts||data.alerts.length===0)return data;
          const port=context.managerPort;if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Manager listener is not ready.');
          const deliveries=[];
          for(const alert of data.alerts){assertCurrent();const sample=alert.sample;
            const results=await context.deliverAlert(roleId,alert,{agentRoleId:roleId,managerPort:port,sourceDeviceId:sample?.sourceDeviceId||data.state.sourceDeviceId,sourceDeviceName:sample?.sourceDeviceName,sourceDeviceKind:sample?.sourceDeviceKind,transport:sample?.transport||'manager-local'});
            assertCurrent();deliveries.push({alertId:alert.id,results});
          }
          return {...data,delivery:{requested:true,results:deliveries}};
        }catch(error){if(mutationStarted&&error&&typeof error==='object')Object.assign(error,{uncertain:true});throw error;}
      }
    };
  }};
}
