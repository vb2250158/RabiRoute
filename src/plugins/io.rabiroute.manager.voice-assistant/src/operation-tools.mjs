import {createOperationTools} from '../../../../apps/rabi-mcp/lib/operation-tools.mjs';
const deliveryKeys=['action','agentAdapter','threadId','prompt','deliveryId','responsePolicy','instanceBinding'];
const exactString=(value,max)=>typeof value==='string'&&value.length>0&&value===value.trim()&&value.length<=max&&!/[\0\r\n\u2028\u2029]/.test(value);
function nativeFailureSummary(error){
  // Keep only machine codes and a function label. Native messages/stacks may
  // contain private paths or provider content and never become model input.
  const code=error?.code||error?.message,stage=String(error?.stack||'').split('\n')[1]?.trim().match(/^at ([A-Za-z_$][\w.$]*)\s*\(/)?.[1];
  return {...(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(code)?{causeCode:code}:{}),...(stage?{failureStage:stage.slice(0,100)}:{})};
}
function validateDelivery(args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!deliveryKeys.includes(key)))throw Error('AGENT_DELIVERY_INPUT_INVALID');
  if(!['send','reconcile_delivery'].includes(args.action)||!exactString(args.agentAdapter,4096)||!exactString(args.threadId,4096))throw Error('AGENT_DELIVERY_INPUT_INVALID');
  if(args.deliveryId!==undefined&&!exactString(args.deliveryId,100))throw Error('AGENT_DELIVERY_ID_REQUIRED');
  if(args.action==='reconcile_delivery'&&!args.deliveryId)throw Error('AGENT_DELIVERY_ID_REQUIRED');
  if(args.prompt!==undefined&&(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>200000)||args.action==='send'&&args.prompt===undefined)throw Error('AGENT_DELIVERY_INPUT_INVALID');
  if(args.responsePolicy!==undefined&&!['none','required'].includes(args.responsePolicy))throw Error('AGENT_DELIVERY_INPUT_INVALID');
  if(args.instanceBinding!==undefined){const value=args.instanceBinding,valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['instanceId','agentId','ownerDeviceId'].includes(key))||!valid(value.instanceId)||!valid(value.agentId)||value.ownerDeviceId!==undefined&&!valid(value.ownerDeviceId))throw Error('AGENT_DELIVERY_INPUT_INVALID');
  }
}
/** Reuse the same discovery, schema invocation, stream and receipt adapter as Rabi MCP. */
export function createRabiOperationTools({sdk,assertCurrent=()=>{},dispose=()=>{},sendAgent}){
  const tools=createOperationTools({client:{operations:sdk}}),definitions=tools.list();
  const nameOf=value=>value.name||value.functionName;
  const agentTool=sendAgent?{type:'function',function:{name:'rabi_agent_deliver',description:'Send to an already identified Rabi Agent session as this voice assistant, or reconcile its original deliveryId. Discover and read the exact target with Rabi operation tools first. Uses the original Manager permissions, receipts and target ownership. Source identity is injected by the current native owner; never include messageSource/sourceThreadId/sourceAgentType. Do not resend an unknown result.',parameters:{type:'object',properties:{action:{type:'string',enum:['send','reconcile_delivery']},agentAdapter:{type:'string',minLength:1,maxLength:4096},threadId:{type:'string',minLength:1,maxLength:4096},prompt:{type:'string',minLength:1,maxLength:200000},deliveryId:{type:'string',minLength:1,maxLength:100},responsePolicy:{type:'string',enum:['none','required']},instanceBinding:{type:'object',properties:{instanceId:{type:'string'},agentId:{type:'string'},ownerDeviceId:{type:'string'}},required:['instanceId','agentId'],additionalProperties:false}},required:['action','agentAdapter','threadId'],additionalProperties:false}}}:undefined;
  return {tools:[...definitions.map(({name,description,inputSchema})=>({type:'function',function:{name,description,parameters:inputSchema}})),...(agentTool?[agentTool]:[])],
    async executeTool(event){
      assertCurrent();const args={...(typeof event.arguments==='string'?JSON.parse(event.arguments):event.arguments||{})};let mutation=false;
      if(nameOf(event)==='rabi_agent_deliver'){
        if(!sendAgent)throw Error('AGENT_SOURCE_OWNER_UNAVAILABLE');
        validateDelivery(args);
        if(args.action==='send'&&event.writeReconciliationRequired)return {ok:false,mutation:true,uncertain:true,state:'not_started',dispatched:false,error:'WRITE_RECONCILIATION_REQUIRED'};
        if(args.action==='send')args.deliveryId??=event.callId;if(!exactString(args.deliveryId,100))throw Error('AGENT_DELIVERY_ID_REQUIRED');
        try{const receipt=await sendAgent(args),deliveryId=receipt.data?.delivery?.deliveryId||receipt.data?.communication?.deliveryId||receipt.data?.deliveryId||(args.action==='reconcile_delivery'?args.deliveryId:undefined);return {ok:receipt.statusCode>=200&&receipt.statusCode<300,mutation:args.action==='send',statusCode:receipt.statusCode,data:receipt.data,uncertain:receipt.data?.uncertain===true,...(deliveryId?{deliveryId}:{}),...(args.action==='send'?{callerDeliveryId:args.deliveryId}:{})}}
        catch(error){const notSent=error?.dispatched===false;return {ok:false,mutation:args.action==='send',uncertain:!notSent,state:notSent?'not_started':'unknown',...(notSent?{dispatched:false}:{}),...(args.action==='send'?{callerDeliveryId:args.deliveryId}:{deliveryId:args.deliveryId}),error:notSent?'AGENT_SOURCE_NOT_ADMITTED':'AGENT_DELIVERY_OUTCOME_UNCONFIRMED',...nativeFailureSummary(error)}}
      }
      const supplied=Object.entries(args.input?.headers||{}).find(([key])=>key.toLowerCase()==='idempotency-key');
      if(nameOf(event)==='rabi_call'&&!args.requestId&&!args.idempotencyKey&&!supplied&&event.callId)args.requestId=event.callId;
      try{const result=await tools.call(nameOf(event),args,{signal:event.signal,writeReconciliationRequired:event.writeReconciliationRequired===true,onOperationEffect:value=>{mutation=value===true}});return {...result,mutation:result?.mutation===true||mutation}}
      catch(error){if(!mutation)throw error;return {ok:false,mutation:true,uncertain:true,error:'RABI_OPERATION_OUTCOME_UNKNOWN',state:'unknown',dispatched:true,operation:args.operation,requestId:args.requestId||args.idempotencyKey||supplied?.[1]}}
    },
    toolPolicy:{classify:decision=>({mutation:['rabi_session','rabi_agent_deliver'].includes(nameOf(decision))&&decision.arguments?.action==='send'}),inspectOutcome:result=>({uncertain:result?.uncertain===true||result?.identityChanged===true,failed:result?.ok===false,terminal:result?.terminal===true})},
    async dispose(){await tools.close();await dispose()}
  };
}
