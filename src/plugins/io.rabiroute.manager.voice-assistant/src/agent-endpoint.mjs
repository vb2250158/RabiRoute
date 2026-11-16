import {createHash} from 'node:crypto';
const type='voice-assistant';
/** The registered Agent and the Web page address the exact same durable session owner. */
export function createVoiceAssistantAgent(owner,identity,assertCurrent,deliveryAuthorityId){
  if(typeof deliveryAuthorityId!=='string'||!deliveryAuthorityId.trim())throw Error('ASSISTANT_DELIVERY_AUTHORITY_UNAVAILABLE');
  const incarnation=sessionId=>createHash('sha256').update(JSON.stringify([identity.applicationGenerationId,identity.managerInstanceId,identity.activationId,sessionId])).digest('hex');
  const endpoint=sessionId=>({kind:'service',managerInstanceId:deliveryAuthorityId,agentId:'local:'+type,provider:type,sessionId,authorizationIncarnation:incarnation(sessionId)});
  const owns=value=>value?.provider===type&&value?.kind==='service';
  const authorize=value=>{assertCurrent();if(!owns(value)||value.managerInstanceId!==deliveryAuthorityId||value.agentId!=='local:'+type||value.authorizationIncarnation!==incarnation(value.sessionId))throw Error('ASSISTANT_ENDPOINT_RETIRED')};
  const serviceEndpoint={owns,handlesTarget:request=>request.agentAdapter===type,handlesSource:(_request,principal)=>principal?.provider===type,
    async resolveSource(request,principal){
      // A caller-supplied messageSource is descriptive metadata, never proof of this owner.
      if(principal?.provider!==type)return undefined;
      const session=await owner.session(),value={...endpoint(session.id),agentId:principal.agentId,sessionId:principal.sessionId,authorizationIncarnation:principal.authorizationIncarnation};
      authorize(value);if(value.sessionId!==session.id||request.sourceThreadId&&request.sourceThreadId!==session.id)throw Error('ASSISTANT_CONTEXT_CHANGED');
      return {agentAdapter:type,agentType:type,threadId:session.id,threadName:session.name,workspace:session.cwd,endpoint:value};
    },
    async resolveTarget(request){assertCurrent();const session=await owner.session();if(request.threadId&&request.threadId!==session.id)throw Error('ASSISTANT_CONTEXT_CHANGED');return {agentAdapter:type,agentType:type,threadId:session.id,threadName:session.name,workspace:session.cwd,endpoint:endpoint(session.id)}},
    authorize,async refresh(value){authorize(value);if((await owner.session()).id!==value.sessionId)throw Error('ASSISTANT_CONTEXT_CHANGED')},resolveExecutionOptions(){return {}},
    async transport(delivery,guard,reconcile){guard();authorize(delivery.target);const prior=await owner.recover(delivery.deliveryId,delivery.prompt);if(!prior&&reconcile)return;
      if(!prior){guard();await owner.submit(delivery.prompt,delivery.deliveryId,delivery.target.sessionId)}
      return {deliveryId:delivery.deliveryId,generation:delivery.generation,endpoint:delivery.target,promptHash:delivery.promptHash,executionOptionsHash:delivery.executionOptionsHash,accepted:true,action:'send',transport:'voice-assistant-owned-session'};
    }};
  const nativeArgs=(invocation)=>{invocation?.assertCurrent?.();if(!Array.isArray(invocation?.nativeArgs))throw Error('Original native invocation arguments are required.');return invocation.nativeArgs};
  return {serviceEndpoint,operations:{
    async scan(){const session=await owner.session();return {agents:{[type]:{type,label:'语音助手',maturity:'experimental',installed:true,auth:{required:false},transport:{protocol:'in-process',mode:'owned-session'},sessions:[{id:session.id,name:session.name,projectPath:session.cwd,live:true}],warnings:[]}},cwdOptions:[session.cwd]}},
    'binding.read':async()=>{const session=await owner.session();return {sessionId:session.id,sessionName:session.name,workspace:session.cwd}},
    'binding.configure':payload=>{const definition=structuredClone(payload.definition||{}),adapters=definition.agentAdapters||[];definition.agentAdapters=payload.body?.enabled===false?adapters.filter(value=>value!==type):[...new Set([...adapters,type])];return definition},
    async 'threads.request'({request},invocation){
      invocation?.assertCurrent?.();assertCurrent();if(request.agentAdapter!==type)throw Error('ASSISTANT_ENDPOINT_MISMATCH');
      const session=await owner.session(),summary={id:session.id,title:session.name,cwd:session.cwd,updatedAt:session.updatedAt||null,archived:false};
      if(request.action==='list'){const matches=!request.query||session.name.toLowerCase().includes(String(request.query).toLowerCase());return {statusCode:200,data:{code:0,action:'list',agentAdapter:type,threads:matches&&!(request.offset>0)?[summary]:[],nextOffset:null}}}
      if(!['read','resolve','open'].includes(request.action))throw Error('ASSISTANT_THREAD_OPERATION_UNSUPPORTED');
      if(request.threadId!==session.id)throw Error('ASSISTANT_CONTEXT_CHANGED');
      return {statusCode:200,data:{code:0,action:request.action,agentAdapter:type,thread:{...summary,messages:request.action==='read'?await owner.messages():undefined}}};
    },
    deliver:async({envelope,binding})=>owner.submit(envelope?.payload?.text||envelope?.text, envelope?.id,binding?.sessionId),
    ...Object.fromEntries(['resolveSource','resolveTarget','refresh','transport'].map(name=>['service.'+name,(_payload,invocation)=>serviceEndpoint[name](...nativeArgs(invocation))]))
  }};
}
