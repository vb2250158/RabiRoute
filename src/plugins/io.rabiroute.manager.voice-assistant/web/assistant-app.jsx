import React from 'react';
import {createRoot} from 'react-dom/client';
import {createAssistantPanel} from '../../../../packages/assistant-runtime/ui/assistant-panel.js';
import {speechServerOptions} from '../../io.rabiroute.manager.speech/web/speech/peerServerPresentation';

const h=React.createElement;
function ManagedModelPicker({setModelPicker,label,kind,current,modelOptions,command,disabled,background=false}){
  const target=React.useRef(null),id=React.useId();
  const canUseHost=kind==='asr'||kind==='tts';
  const field=background?'backgroundAsr':kind;
  const deviceId=current[field+'DeviceId']||'';
  const selected=current.modelSelections?.[field];
  const sources=[
    ...(canUseHost?speechServerOptions(current.modelComputers||[],deviceId).map(option=>({...option,value:'host/'+option.value,subtitle:option.detail})):[]),
    ...(!background?[{value:'api',title:'在线 / API 模型'}]:[]),
  ];
  const props={label,source:selected?.group||'',selected:selected?.id||'',modelLabel:selected?.label,sources,disabled,
    setupHref:'#/model-services?tab='+kind,
    loadModels:group=>modelOptions(field,group),
    choose:id=>command({action:'model-service-select',kind:field,id},'已选择模型。'),
  };
  React.useLayoutEffect(()=>{setModelPicker(id,target.current,props);});
  React.useLayoutEffect(()=>()=>setModelPicker(id,null),[setModelPicker,id]);
  return h('div',{ref:target,className:'rabi-host-setting'});
}
export function HostSettings({state,settingsTab,speechKind,command,modelOptions,dirty,setModelPicker}){
  const current=state?.hostSettings;if(!current)return null;
  const problem=current.lastError?h('details',{className:'va-host-problem'},h('summary',null,'上次宿主操作未完成 · 查看详情'),h('p',null,current.lastError.operationId),h('p',null,[current.lastError.statusCode?'HTTP '+current.lastError.statusCode:'',current.lastError.errorCode].filter(Boolean).join(' · ')),current.lastError.repair&&h('p',null,current.lastError.repair)):null;
  const update=patch=>command({action:'host-settings',patch},patch.personaId!==undefined?'人格已切换，切回时继续原历史。':patch.wakeEnabled!==undefined?'唤醒设置已保存。':'语音服务设置已保存。');
  const disabled=dirty||state.context?.busy;
  const picker=(label,kind,background=false)=>setModelPicker&&h(ManagedModelPicker,{key:label,setModelPicker,label,kind,current,modelOptions,command,disabled,background});
  const selector=(label,value,values,change)=>h('label',{className:'rabi-host-setting'},label,h('select',{value,disabled:dirty||state.context?.busy,onChange:event=>void change(event.target.value)},values.map(([id,title,disabled])=>h('option',{value:id,key:id,disabled},title))));
  if(settingsTab==='conversation')return h(React.Fragment,null,
    h('fieldset',null,h('legend',null,'对话模型'),picker('对话模型','llm')),
    h('fieldset',null,h('legend',null,'Rabi 人格'),problem,selector('人格',current.personaId,[['','自定义人设'],...current.personas.map(item=>[item.id,item.label])],personaId=>update({personaId})),h('p',null,current.personaId?'系统提示来自所选人格；每个人格分别保存对话历史。切换不会删除记录。':'使用下方的人设与当前对话。'),dirty&&h('p',null,'请先保存当前设置，再切换人格。')));
  if(settingsTab==='search')return picker('搜索服务','search');
  if(settingsTab!=='speech')return null;
  const wakeLabels={disabled:'已关闭',starting:'正在启动唤醒',armed:'等待唤醒词',active:'实时对话中','local-fallback':'本机识别接续中',waiting:'等待常驻麦克风',unavailable:'唤醒暂不可用'};
  const kind=speechKind,source=current[kind+'Source'],model=current[kind+'Model'],selected=current.models.find(item=>item.id===model);
  const nativeCapabilities=selected&&h('section',null,h('h3',null,'模型能力'),h('div',{className:'va-capabilities'},(selected.features||[]).map(id=>h('span',{key:id,className:'va-capability-chip'},id))),h('details',null,h('summary',null,'服务声明的输入参数'),(selected.requestFields||[]).map(field=>h('details',{key:field.id},h('summary',null,field.id),h('p',null,field.description||'当前服务未提供此参数的详细说明。')))),kind==='tts'&&h(React.Fragment,null,h('h3',null,'Agent 可动态使用'),h('p',null,state.speechExpression?.fields?.map(field=>field.label).join('、')||'当前宿主接口没有已适配的动态表达参数。'),Boolean(state.speechExpression?.fields?.length)&&h('label',null,h('input',{type:'checkbox',checked:Boolean(state.settings.ttsDynamicExpression),onChange:event=>command({action:'settings',patch:{ttsDynamicExpression:event.target.checked}},'动态表达设置已保存。')}),'根据人设与当前情境动态表达')));
  const wakeSetting=kind==='asr'&&h(React.Fragment,null,
    h('label',null,h('input',{type:'checkbox',checked:!!current.wakeEnabled,disabled:dirty||(!current.personaId&&!current.wakeEnabled),onChange:event=>update({wakeEnabled:event.target.checked})}),'本机关键词唤醒'),
    h('label',null,h('input',{type:'checkbox',checked:current.mobileLocalFallback!==false,disabled:dirty,onChange:event=>update({mobileLocalFallback:event.target.checked})}),'手机本机转写回退'),
    picker('后台转写模型','asr',true),
    h('p',{role:'status'},state.settings?.voiceEnabled===false?'语音助手已关闭。':current.wakeEnabled?(wakeLabels[current.wake?.phase]||'正在准备'):'开启关键词唤醒后，可用所选人格的唤醒词进入实时语音。'));
  const label=kind==='asr'?'实时识别模型':'播报模型';
  return h('fieldset',{className:'rabi-host-source'},h('legend',null,kind==='asr'?'语音识别':'语音播报'),problem,
    picker(label,kind),
    wakeSetting,source==='host'&&h(React.Fragment,null,
    h('p',{role:'status'},current[kind+'Issue']||(current.modelsError?'无法连接模型服务，请检查所选机器。':!model?'请选择可用模型。':kind==='tts'&&!current.voiceReady?'可配置人格声线或选择 API 播报服务。':kind==='tts'?'音色来自人格：'+(current.personaLabel||current.personaId||'未选择人格'):'使用所选机器的识别模型。')),
    nativeCapabilities,h('p',null,'麦克风和播放仍由同一助手循环管理。')),dirty&&h('p',null,'请先保存当前设置，再切换服务来源。'));
}
export function SettingsPage({children,title,onClose,open}){if(!open)return null;return h('section',{className:'rabi-assistant-settings'},h('div',{className:'rabi-settings-heading'},h('h2',null,title),h('button',{onClick:onClose},'返回对话')),children)}
export const Panel=createAssistantPanel(React,{Modal:SettingsPage,HostSettings,settingsPresentation:'page'});
export function mountAssistantPanel(element,{fetcher=fetch,resolveAvatarUrl,setModelPicker}={}){
  const request=async(path,body)=>{const response=await fetcher(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});let value;try{value=await response.json()}catch{throw Error('ASSISTANT_PLUGIN_UNAVAILABLE')}if(!response.ok||value.code!==0)throw Error(value.message||'ASSISTANT_PLUGIN_UNAVAILABLE');return value.data};
  const assistant=(action,body)=>request('/api/voice-assistant/'+action,body);
  const modelOptions=(kind,group)=>request('/api/model-services/models?'+new URLSearchParams({kind,group}));
  const adapter={read:async()=>{
    const state=await assistant('state'),id=state.hostSettings?.personaId;
    // The selected persona's existing public resource endpoint also serves the message-history page.
    return id?{...state,participants:{...state.participants,assistant:{name:state.hostSettings.personaLabel||state.settings.assistantName,avatarUrl:'/api/roles/'+encodeURIComponent(id)+'/avatar'}}}:state;
  },command:({action,...body})=>action==='model-service-select'
    ? request('/api/model-services/assistant-selection',body)
    : assistant('command',{action,...body}),resolveAvatarUrl,subscribeConversation(_id,listener,onError){let closed=false,timer;const poll=async()=>{try{const data=await assistant('messages');if(!closed)listener(data)}catch(error){if(!closed)onError(error)}finally{if(!closed)timer=setTimeout(poll,350)}};void poll();return()=>{closed=true;clearTimeout(timer)}}};
  const root=createRoot(element);root.render(h(React.Fragment,null,h('style',null,'.rabi-host-setting{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}.rabi-host-setting select{min-height:42px;border:1px solid #527080;border-radius:8px;padding:8px}.rabi-assistant-settings{width:100%}.rabi-settings-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}'),h(Panel,{adapter,hostSettingsProps:{setModelPicker,modelOptions}})));
  return()=>root.unmount();
}
