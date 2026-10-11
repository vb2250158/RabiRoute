import wx from 'wx';
import { getDeviceAgentContext, requestDeviceAgent } from './rabilink-api.js';
import { tokenStorageKey } from './rabilink-store.js';
const KEY='rabilink-aiui-device-agent-v1';
function stored() { const value=wx.getStorageSync(KEY); return value && typeof value==='object' && value.sessions ? value : {sessions:{},executions:{}}; }
function persist(value) { wx.setStorageSync(KEY,value); }
export const deviceAgentPageMethods={
  async startDeviceAgentOwner() {
    if(this.deviceAgentOwnerStarting || this.deviceAgentOwner || this.destroyed || !this.pageVisible || this.data.modelProbe)return;
    const config=this.deviceAgentProfileConfig();if(!config)return;
    this.deviceAgentOwnerStarting=true;const generation=this.deviceAgentOwnerGeneration=(this.deviceAgentOwnerGeneration || 0)+1;
    try {
      const context=await getDeviceAgentContext(config);
      const model=await this.ensureChatModel();
      if(!model || this.destroyed || !this.pageVisible || generation!==this.deviceAgentOwnerGeneration)return;
      const relayScope=String(config.relayBaseUrl || '').trim().replace(/\/+$/, '');
      const scope=relayScope+'|'+tokenStorageKey(config.token)+'|'+context.agentId+'|'+context.targetDeviceId,value=stored();
      const sessionId=value.sessions[scope] || ('device-session-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
      value.sessions[scope]=sessionId;persist(value);
      const capabilities=['language-model'];
      if(this.rabiApiRuntime && this.chatModelApiToolsCount>0)capabilities.push('rabi-api');
      if(this.asrAdapter?.getCapability().available)capabilities.push('asr');
      if(this.ttsAdapter?.getCapability().available)capabilities.push('tts');
      const state={config,context,scope,sessionId,generation,ownerEpoch:'',loaded:true,capabilities};
      const result=await requestDeviceAgent(config,context,'/session',{method:'PUT',body:{sessionId,ownerEpoch:value.ownerEpochs?.[scope] || '',name:this.data.lingzhuAgentName || 'AIUI',loaded:true,capabilities:state.capabilities}});
      (value.ownerEpochs || (value.ownerEpochs={}))[scope]=result.session.ownerEpoch;persist(value);
      if(this.destroyed || !this.pageVisible || generation!==this.deviceAgentOwnerGeneration) {
        await requestDeviceAgent(config,context,'/session',{method:'PUT',body:{...result.session,loaded:false}});return;
      }
      state.ownerEpoch=result.session.ownerEpoch;this.deviceAgentOwner=state;
      this.scheduleDeviceAgentLease();void this.runDeviceAgentMailbox(state);
    } catch(error) { this.setData({deviceAgentProfileStatus:'设备 Agent 未就绪：'+String(error?.message || '连接失败')}); }
    finally{this.deviceAgentOwnerStarting=false;}
  },
  deviceAgentTurnContext(state=this.deviceAgentOwner,delivery=null) {
    return state ? {targetDeviceId:delivery?.ledgerOwnerDeviceId || state.context.targetDeviceId,ownerDeviceId:state.context.targetDeviceId,agentId:state.context.agentId,agentAdapter:'deviceAgent',sessionId:state.sessionId,sessionName:this.data.lingzhuAgentName || 'AIUI'} : null;
  },
  scheduleDeviceAgentLease() {
    if(this.deviceAgentLeaseTimer)clearTimeout(this.deviceAgentLeaseTimer);
    const state=this.deviceAgentOwner;if(!state)return;
    this.deviceAgentLeaseTimer=setTimeout(async()=>{
      this.deviceAgentLeaseTimer=null;
      if(this.destroyed || !this.pageVisible || this.deviceAgentOwner!==state)return;
      try {
        const loaded=Boolean(this.chatModel);
        await requestDeviceAgent(state.config,state.context,'/session',{method:'PUT',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,name:this.data.lingzhuAgentName || 'AIUI',loaded,capabilities:state.capabilities}});
        if(!loaded) {this.stopDeviceAgentOwner();return;}
        this.scheduleDeviceAgentLease();
      } catch {this.stopDeviceAgentOwner();this.setData({deviceAgentProfileStatus:'设备 Agent 连接未确认；原任务保留'});}
    },15000);
  },
  async waitForDeviceAgentTurnIdle() {
    while(this.deviceAgentTurnActive && !this.destroyed && this.pageVisible) {
      await new Promise(resolve=>{(this.deviceAgentIdleWaiters || (this.deviceAgentIdleWaiters=[])).push(resolve);});
    }
  },
  resumeDeviceAgentClaim() {const pending=this.deviceAgentIdleWaiters || [];this.deviceAgentIdleWaiters=[];for(const resolve of pending)resolve();},
  async reconcileDeviceAgentReceipts() {
    const state=this.deviceAgentOwner;if(!state)return;
    const value=stored();
    for(const [key,row] of Object.entries(value.executions || {})) {
      if(!key.startsWith(state.scope+'|') || row.state==='settled')continue;
      try {
        const result=await requestDeviceAgent(state.config,state.context,'/deliveries/'+encodeURIComponent(row.deliveryId));
        if(this.deviceAgentOwner!==state)return;
        if(['completed','failed','result-unknown'].includes(result.receipt?.status)) {
          value.executions[key]={deliveryId:row.deliveryId,sessionId:row.sessionId,ownerEpoch:row.ownerEpoch,state:'settled',status:result.receipt.status};persist(value);
        } else this.setData({deviceAgentProfileStatus:'原任务结果未确认；未重新执行'});
      } catch {this.setData({deviceAgentProfileStatus:'原任务回执不可用；未重新执行'});return;}
    }
  },
  async runDeviceAgentMailbox(state) {
    const current=()=>this.deviceAgentOwner===state && this.pageVisible && !this.destroyed;
    while(current()) {
      try {
        await this.waitForDeviceAgentTurnIdle();if(!current())return;
        const notice=await requestDeviceAgent(state.config,state.context,'/pending?waitMs=12000');
        if(!current())return;if(!notice.pending)continue;
        await this.waitForDeviceAgentTurnIdle();if(!current())return;
        const claimed=await requestDeviceAgent(state.config,state.context,'/deliveries/claim',{method:'POST',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch}});
        if(!current())return;
        if(claimed.activeReceipt) {this.setData({deviceAgentProfileStatus:'原路线任务仍在执行或结果未确认；未重复运行'});return;}
        const delivery=claimed.delivery;if(!delivery)continue;
        const value=stored(),key=state.scope+'|'+delivery.deliveryId,previous=value.executions[key];
        if(previous) {this.setData({deviceAgentProfileStatus:'原路线任务已有执行记录；仅核对回执'});return;}
        value.executions[key]={deliveryId:delivery.deliveryId,sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,state:'running'};persist(value);
        await this.waitForDeviceAgentTurnIdle();if(!current())return;
        const result=await this.executeLingzhuAgentPrompt(delivery.prompt,{deviceContext:this.deviceAgentTurnContext(state,delivery)});
        const response={sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,claimToken:delivery.claimToken,status:result?.state==='completed' ? 'completed' : result?.state==='failed' ? 'failed' : 'result-unknown',text:result?.text || '',...(result?.errorCode ? {errorCode:result.errorCode} : {})};
        value.executions[key]={...value.executions[key],state:'response-pending',response};persist(value);
        if(!current())return;
        const receipt=await requestDeviceAgent(state.config,state.context,'/deliveries/'+encodeURIComponent(delivery.deliveryId)+'/response',{method:'POST',body:response,operationId:'device-agent-response:'+delivery.deliveryId});
        if(receipt.receipt?.deliveryId!==delivery.deliveryId || receipt.receipt?.status!==response.status)throw new Error('DEVICE_AGENT_RESPONSE_UNCONFIRMED');
        value.executions[key]={deliveryId:delivery.deliveryId,sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,state:'settled'};persist(value);
      } catch(error) {if(current())this.setData({deviceAgentProfileStatus:'路线任务未确认：'+String(error?.message || '连接失败')});return;}
    }
  },
  stopDeviceAgentOwner() {
    this.deviceAgentOwnerGeneration=(this.deviceAgentOwnerGeneration || 0)+1;
    if(this.deviceAgentLeaseTimer)clearTimeout(this.deviceAgentLeaseTimer);this.deviceAgentLeaseTimer=null;
    const state=this.deviceAgentOwner;this.deviceAgentOwner=null;this.resumeDeviceAgentClaim();
    if(state)void requestDeviceAgent(state.config,state.context,'/session',{method:'PUT',body:{sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,name:this.data.lingzhuAgentName || 'AIUI',loaded:false,capabilities:state.capabilities}}).catch(()=>{});
  }
};
