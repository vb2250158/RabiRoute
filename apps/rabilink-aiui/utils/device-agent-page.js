import wx from 'wx';
import { getDeviceAgentContext, requestDeviceAgent } from './rabilink-api.js';
import { tokenStorageKey } from './rabilink-store.js';
const KEY='rabilink-aiui-device-agent-v1';
function stored() { const value=wx.getStorageSync(KEY); return value && typeof value==='object' && value.sessions ? value : {sessions:{},executions:{}}; }
function persist(value) { wx.setStorageSync(KEY,value); }
// Each synchronous write starts from current storage. Never publish a snapshot
// retained across a model/network await over another task's newer records.
function persistExecution(key,row) { const value=stored();value.executions[key]=row;persist(value); }
function matchesReceipt(receipt,row) {
  return Boolean(row.deliveryId && row.sessionId && row.ownerEpoch
    && receipt?.deliveryId===row.deliveryId && receipt.sessionId===row.sessionId && receipt.ownerEpoch===row.ownerEpoch);
}
function savedResponseValid(row) {
  const response=row.response;
  return Boolean(row.state==='response-pending' && response && response.sessionId===row.sessionId && response.ownerEpoch===row.ownerEpoch
    && typeof response.claimToken==='string' && response.claimToken
    && ['completed','failed','result-unknown'].includes(response.status)
    && typeof response.text==='string' && response.text.length<=32768
    && (response.errorCode===undefined || typeof response.errorCode==='string' && response.errorCode.length>0 && response.errorCode.length<=120)
    && Object.keys(response).every(key=>['sessionId','ownerEpoch','claimToken','status','text','errorCode'].includes(key)));
}
function matchesSavedResponse(receipt,row) {
  return savedResponseValid(row) && receipt.status===row.response.status
    && receipt.response?.status===row.response.status && receipt.response.text===row.response.text
    && (receipt.response.errorCode || '')===(row.response.errorCode || '');
}
export const deviceAgentPageMethods={
  async startDeviceAgentOwner() {
    if(this.deviceAgentOwnerStarting || this.deviceAgentOwner || this.destroyed || !this.pageVisible || this.data.modelProbe)return;
    const config=this.deviceAgentProfileConfig();if(!config)return;
    const generation=this.deviceAgentOwnerGeneration=(this.deviceAgentOwnerGeneration || 0)+1;
    const startup={generation,registering:false};this.deviceAgentOwnerStarting=startup;
    const current=()=>!this.destroyed && this.pageVisible && generation===this.deviceAgentOwnerGeneration && this.deviceAgentOwnerStarting===startup;
    try {
      const context=await getDeviceAgentContext(config);
      if(!current())return;
      const model=await this.ensureChatModel();
      if(!model || !current())return;
      const relayScope=String(config.relayBaseUrl || '').trim().replace(/\/+$/, '');
      const scope=relayScope+'|'+tokenStorageKey(config.token)+'|'+context.agentId+'|'+context.targetDeviceId,value=stored();
      const sessionId=value.sessions[scope] || ('device-session-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
      value.sessions[scope]=sessionId;persist(value);
      const capabilities=['language-model'];
      if(this.rabiApiRuntime && this.chatModelApiToolsCount>0)capabilities.push('rabi-api');
      if(this.asrAdapter?.getCapability().available)capabilities.push('asr');
      if(this.ttsAdapter?.getCapability().available)capabilities.push('tts');
      const state={config,context,scope,sessionId,generation,ownerEpoch:'',loaded:true,capabilities};
      startup.registering=true;
      const result=await requestDeviceAgent(config,context,'/session',{method:'PUT',body:{sessionId,ownerEpoch:value.ownerEpochs?.[scope] || '',name:this.data.lingzhuAgentName || 'AIUI',loaded:true,capabilities:state.capabilities}});
      const latest=stored();(latest.ownerEpochs || (latest.ownerEpochs={}))[scope]=result.session.ownerEpoch;persist(latest);
      if(!current()) {
        await requestDeviceAgent(config,context,'/session',{method:'PUT',body:{...result.session,loaded:false}});return;
      }
      state.ownerEpoch=result.session.ownerEpoch;this.deviceAgentOwner=state;
      this.scheduleDeviceAgentLease();void this.runDeviceAgentMailbox(state);
    } catch(error) { if(current())this.setData({deviceAgentProfileStatus:'设备 Agent 未就绪：'+String(error?.message || '连接失败')}); }
    finally{if(this.deviceAgentOwnerStarting===startup)this.deviceAgentOwnerStarting=false;}
  },
  deviceAgentTurnContext(state=this.deviceAgentOwner,delivery=null) {
    return state ? {targetDeviceId:delivery?.ledgerOwnerDeviceId || state.context.targetDeviceId,ownerDeviceId:state.context.targetDeviceId,agentId:state.context.agentId,agentAdapter:'deviceAgent',sessionId:state.sessionId,sessionName:this.data.lingzhuAgentName || 'AIUI'} : null;
  },
  scheduleDeviceAgentLease(delay=15000) {
    if(this.deviceAgentLeaseTimer)clearTimeout(this.deviceAgentLeaseTimer);
    const state=this.deviceAgentOwner;if(!state)return;
    const current=()=>!this.destroyed && this.deviceAgentOwner===state && this.deviceAgentLeaseTimer===timer;
    const timer=setTimeout(async()=>{
      if(!current())return;
      try {
        const loaded=Boolean(this.chatAssistant?.getState().ready);
        const result=await requestDeviceAgent(state.config,state.context,'/session',{method:'PUT',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,name:this.data.lingzhuAgentName || 'AIUI',loaded,capabilities:state.capabilities}});
        if(!current())return;
        if(!loaded) {this.stopDeviceAgentOwner();return;}
        if(result.session?.sessionId!==state.sessionId || result.session?.ownerEpoch!==state.ownerEpoch || result.session?.loaded!==true)throw new Error('DEVICE_AGENT_LEASE_CHANGED');
        state.leaseConfirmed=true;
        this.scheduleDeviceAgentLease();
        this.resumeDeviceAgentClaim();
        if(this.pageVisible)void this.runDeviceAgentMailbox(state);
      } catch {
        if(!current())return;
        this.stopDeviceAgentOwner();this.setData({deviceAgentProfileStatus:'设备 Agent 连接未确认；原任务保留'});
      }
    },delay);
    this.deviceAgentLeaseTimer=timer;
  },
  async waitForDeviceAgentTurnIdle(state) {
    while(this.deviceAgentOwner===state && !this.destroyed && this.pageVisible
      && (this.deviceAgentTurnActive || this.aiuiRuntime?.getState().inputPending || this.aiuiGuidanceQueue?.length)) {
      await new Promise(resolve=>{(this.deviceAgentIdleWaiters || (this.deviceAgentIdleWaiters=[])).push(resolve);});
    }
  },
  resumeDeviceAgentClaim() {const pending=this.deviceAgentIdleWaiters || [];this.deviceAgentIdleWaiters=[];for(const resolve of pending)resolve();},
  async reconcileDeviceAgentReceipts() {
    const state=this.deviceAgentOwner;if(!state || state.leaseConfirmed===false || !this.pageVisible || this.destroyed)return false;
    const current=()=>this.deviceAgentOwner===state && state.leaseConfirmed!==false && this.pageVisible && !this.destroyed;
    let confirmed=true;
    const value=stored();
    for(const [key,row] of Object.entries(value.executions || {})) {
      if(!key.startsWith(state.scope+'|') || row.state==='settled')continue;
      try {
        let result=await requestDeviceAgent(state.config,state.context,'/deliveries/'+encodeURIComponent(row.deliveryId));
        if(!current())return false;
        if(!matchesReceipt(result.receipt,row))throw new Error('DEVICE_AGENT_RECEIPT_MISMATCH');
        // Reconcile first. A saved answer can be resubmitted only to its original
        // still-claimed owner; this never re-enters inference or tool execution.
        if(result.receipt.status==='claimed' && savedResponseValid(row)
          && state.sessionId===row.sessionId && state.ownerEpoch===row.ownerEpoch) {
          result=await requestDeviceAgent(state.config,state.context,'/deliveries/'+encodeURIComponent(row.deliveryId)+'/response',
            {method:'POST',body:row.response,operationId:'device-agent-response:'+row.deliveryId});
          if(!current())return false;
          if(!matchesReceipt(result.receipt,row) || !matchesSavedResponse(result.receipt,row))throw new Error('DEVICE_AGENT_RESPONSE_UNCONFIRMED');
        }
        if(['completed','failed','result-unknown'].includes(result.receipt?.status)) {
          if(row.response && !matchesSavedResponse(result.receipt,row))throw new Error('DEVICE_AGENT_RESPONSE_CONFLICT');
          persistExecution(key,{deliveryId:row.deliveryId,sessionId:row.sessionId,ownerEpoch:row.ownerEpoch,state:'settled',status:result.receipt.status});
        } else {confirmed=false;this.setData({deviceAgentProfileStatus:'原任务结果未确认；未重新执行'});}
      } catch {if(current())this.setData({deviceAgentProfileStatus:'原任务回执不可用；未重新执行'});return false;}
    }
    return confirmed;
  },
  async runDeviceAgentMailbox(state) {
    if(this.deviceAgentOwner!==state || state.leaseConfirmed===false || !this.pageVisible || this.destroyed)return;
    if(state.mailboxWork)return;
    // Register the owner-local work before the first async read. Lease renewal,
    // startup and recovery must share one claim/execution loop.
    const work=Promise.resolve().then(async()=>{
      if(this.deviceAgentOwner!==state || state.leaseConfirmed===false || !this.pageVisible || this.destroyed)return;
      if(!await this.reconcileDeviceAgentReceipts())return;
      return this.processDeviceAgentMailbox(state);
    });
    state.mailboxWork=work;
    try {await work;}
    catch(error) {if(this.deviceAgentOwner===state && this.pageVisible && !this.destroyed)this.setData({deviceAgentProfileStatus:'路线任务未确认：'+String(error?.message || '连接失败')});}
    finally {if(state.mailboxWork===work)state.mailboxWork=null;}
  },
  async processDeviceAgentMailbox(state) {
    const current=()=>this.deviceAgentOwner===state && state.leaseConfirmed!==false && this.pageVisible && !this.destroyed;
    while(current()) {
      try {
        await this.waitForDeviceAgentTurnIdle(state);if(!current())return;
        const notice=await requestDeviceAgent(state.config,state.context,'/pending?waitMs=12000');
        if(!current())return;if(!notice.pending)continue;
        await this.waitForDeviceAgentTurnIdle(state);if(!current())return;
        const claimed=await requestDeviceAgent(state.config,state.context,'/deliveries/claim',{method:'POST',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch}});
        if(!current())return;
        if(claimed.activeReceipt) {this.setData({deviceAgentProfileStatus:'原路线任务仍在执行或结果未确认；未重复运行'});return;}
        const delivery=claimed.delivery;if(!delivery)continue;
        const value=stored(),key=state.scope+'|'+delivery.deliveryId,previous=value.executions[key];
        if(previous) {this.setData({deviceAgentProfileStatus:'原路线任务已有执行记录；仅核对回执'});return;}
        const execution={deliveryId:delivery.deliveryId,sessionId:state.sessionId,ownerEpoch:state.ownerEpoch};
        persistExecution(key,{...execution,state:'running'});
        await this.waitForDeviceAgentTurnIdle(state);if(!current())return;
        const result=await this.executeLingzhuAgentPrompt(delivery.prompt,{deviceContext:this.deviceAgentTurnContext(state,delivery)});
        const response={sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,claimToken:delivery.claimToken,status:result?.state==='completed' ? 'completed' : result?.state==='failed' ? 'failed' : 'result-unknown',text:result?.text || '',...(result?.errorCode ? {errorCode:result.errorCode} : {})};
        persistExecution(key,{...execution,state:'response-pending',response});
        if(!current())return;
        const receipt=await requestDeviceAgent(state.config,state.context,'/deliveries/'+encodeURIComponent(delivery.deliveryId)+'/response',{method:'POST',body:response,operationId:'device-agent-response:'+delivery.deliveryId});
        if(!matchesReceipt(receipt.receipt,execution) || receipt.receipt.status!==response.status)throw new Error('DEVICE_AGENT_RESPONSE_UNCONFIRMED');
        persistExecution(key,{...execution,state:'settled',status:receipt.receipt.status});
      } catch(error) {if(current())this.setData({deviceAgentProfileStatus:'路线任务未确认：'+String(error?.message || '连接失败')});return;}
    }
  },
  stopDeviceAgentOwner() {
    this.deviceAgentOwnerGeneration=(this.deviceAgentOwnerGeneration || 0)+1;
    // A cancelled read/model preparation may be replaced immediately. A remote
    // registration must settle (and unregister if stale) before another starts.
    if(!this.deviceAgentOwnerStarting?.registering)this.deviceAgentOwnerStarting=false;
    if(this.deviceAgentLeaseTimer)clearTimeout(this.deviceAgentLeaseTimer);this.deviceAgentLeaseTimer=null;
    const state=this.deviceAgentOwner;this.deviceAgentOwner=null;this.resumeDeviceAgentClaim();
    if(state)void requestDeviceAgent(state.config,state.context,'/session',{method:'PUT',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,name:this.data.lingzhuAgentName || 'AIUI',loaded:false,capabilities:state.capabilities}}).catch(()=>{});
  }
};
