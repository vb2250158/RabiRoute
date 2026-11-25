import React from 'react';
import {createRoot} from 'react-dom/client';
import {createAssistantPanel} from '../../../../packages/assistant-runtime/ui/assistant-panel.js';
import {speechServerOptions} from '../../io.rabiroute.manager.speech/web/speech/peerServerPresentation';

const h=React.createElement;
function MachineModelMenu({label,deviceId,model,peers,kind,query,commit,disabled,onCustom,custom}){
  const [device,setDevice]=React.useState(null),[list,setList]=React.useState(null),[error,setError]=React.useState(''),[saving,setSaving]=React.useState(false);
  const sequence=React.useRef(0),menu=React.useRef(null),trigger=React.useRef(null),heading=React.useRef(null);
  const computers=speechServerOptions(peers||[],deviceId||'');
  const selectedComputer=computers.find(item=>item.value===(deviceId||''));
  const selection=custom?'自定义提供商':[selectedComputer?.title,model].filter(Boolean).join(' · ');
  React.useEffect(()=>{if(device)heading.current?.focus()},[device]);
  function reset(){++sequence.current;setDevice(null);setList(null);setError('')}
  async function load(option){
    const request=++sequence.current;setDevice(option);setList(null);setError('');
    try{
      const options=await query({action:'speech-models',deviceId:option.value});
      if(request===sequence.current)setList(options.filter(row=>row.capability===kind&&row.enabled&&row.available));
    }catch(cause){if(request===sequence.current)setError(cause?.message||'无法读取模型，请重试。')}
  }
  function close(){if(menu.current){menu.current.open=false;trigger.current?.focus()}}
  async function choose(save){
    setSaving(true);setError('');
    try{if(await save()===false)setError('无法保存选择，请重试。');else close()}
    catch(cause){setError(cause?.message||'无法保存选择，请重试。')}
    finally{setSaving(false)}
  }
  return h('details',{className:'rabi-host-model',ref:menu,onToggle:event=>{if(!event.currentTarget.open)reset()},
    onKeyDown:event=>{if(event.key==='Escape'&&menu.current?.open){event.stopPropagation();close()}}},
    h('summary',{ref:trigger},h('span',null,label),h('strong',null,selection)),
    h('div',{className:'rabi-host-model-options',role:'group','aria-label':device?'选择模型':'选择机器'},
      !device?h(React.Fragment,null,
        h('div',{className:'rabi-host-model-heading'},'选择机器'),
        computers.map(option=>h('button',{type:'button',key:option.value,disabled:disabled||saving||option.props.disabled,onClick:()=>void load(option)},
          h('span',null,option.title),h('small',null,option.detail),h('span',{'aria-hidden':true},'›'))),
        onCustom&&h('button',{type:'button',disabled:disabled||saving,onClick:()=>void choose(onCustom)},'自定义提供商')):
        h(React.Fragment,null,h('button',{type:'button',disabled:saving,onClick:()=>{reset();trigger.current?.focus()}},'‹ 返回机器列表'),
          h('div',{ref:heading,tabIndex:-1,className:'rabi-host-model-heading'},'选择模型 · '+device.title),
          list===null&&!error?h('p',{role:'status'},'正在读取模型…'):list?.length?list.map(option=>h('button',{type:'button',key:option.id,disabled:disabled||saving,onClick:()=>void choose(()=>commit(device.value,option.id))},option.name||option.id)):
            !error&&h('p',null,'这台机器没有可用模型。'),
          list===null&&error&&h('button',{type:'button',onClick:()=>void load(device)},'重新读取模型')),
      error&&h('p',{role:'alert'},error)));
}
export function HostSettings({state,settingsTab,speechKind,command,query,dirty}){
  const current=state?.hostSettings;if(!current)return null;
  const problem=current.lastError?h('details',{className:'va-host-problem'},h('summary',null,'上次宿主操作未完成 · 查看详情'),h('p',null,current.lastError.operationId),h('p',null,[current.lastError.statusCode?'HTTP '+current.lastError.statusCode:'',current.lastError.errorCode].filter(Boolean).join(' · ')),current.lastError.repair&&h('p',null,current.lastError.repair)):null;
  const update=patch=>command({action:'host-settings',patch},patch.personaId!==undefined?'人格已切换，切回时继续原历史。':patch.wakeEnabled!==undefined?'唤醒设置已保存。':'语音服务设置已保存。');
  const selector=(label,value,values,change)=>h('label',{className:'rabi-host-setting'},label,h('select',{value,disabled:dirty||state.context?.busy,onChange:event=>void change(event.target.value)},values.map(([id,title,disabled])=>h('option',{value:id,key:id,disabled},title))));
  if(settingsTab==='conversation')return h('fieldset',null,h('legend',null,'Rabi 人格'),problem,selector('人格',current.personaId,[['','自定义人设'],...current.personas.map(item=>[item.id,item.label])],personaId=>update({personaId})),h('p',null,current.personaId?'系统提示来自所选人格；每个人格分别保存对话历史。切换不会删除记录。':'使用下方的人设与当前对话。'),dirty&&h('p',null,'请先保存当前设置，再切换人格。'));
  if(settingsTab!=='speech')return null;
  const wakeLabels={disabled:'已关闭',starting:'正在启动唤醒',armed:'等待唤醒词',active:'实时对话中','local-fallback':'本机识别接续中',waiting:'等待常驻麦克风',unavailable:'唤醒暂不可用'};
  const kind=speechKind,source=current[kind+'Source'],model=current[kind+'Model'],selected=current.models.find(item=>item.id===model);
  const disabled=dirty||state.context?.busy;
  const nativeCapabilities=selected&&h('section',null,h('h3',null,'模型能力'),h('div',{className:'va-capabilities'},(selected.features||[]).map(id=>h('span',{key:id,className:'va-capability-chip'},id))),h('details',null,h('summary',null,'服务声明的输入参数'),(selected.requestFields||[]).map(field=>h('details',{key:field.id},h('summary',null,field.id),h('p',null,field.description||'当前服务未提供此参数的详细说明。')))),kind==='tts'&&h(React.Fragment,null,h('h3',null,'Agent 可动态使用'),h('p',null,state.speechExpression?.fields?.map(field=>field.label).join('、')||'当前宿主接口没有已适配的动态表达参数。'),Boolean(state.speechExpression?.fields?.length)&&h('label',null,h('input',{type:'checkbox',checked:Boolean(state.settings.ttsDynamicExpression),onChange:event=>command({action:'settings',patch:{ttsDynamicExpression:event.target.checked}},'动态表达设置已保存。')}),'根据人设与当前情境动态表达')));
  const wakeSetting=kind==='asr'&&h(React.Fragment,null,
    h('label',null,h('input',{type:'checkbox',checked:!!current.wakeEnabled,disabled:dirty||(!current.personaId&&!current.wakeEnabled),onChange:event=>update({wakeEnabled:event.target.checked})}),'本机关键词唤醒'),
    h('label',null,h('input',{type:'checkbox',checked:current.mobileLocalFallback!==false,disabled:dirty,onChange:event=>update({mobileLocalFallback:event.target.checked})}),'手机本机转写回退'),
    query&&h(MachineModelMenu,{label:'后台转写模型',deviceId:current.backgroundAsrDeviceId,model:current.backgroundAsrModel||'FireRedASR2-AED',
      peers:current.modelComputers,kind:'asr',query,disabled,commit:(backgroundAsrDeviceId,backgroundAsrModel)=>update({backgroundAsrDeviceId,backgroundAsrModel})}),
    h('p',{role:'status'},state.settings?.voiceEnabled===false?'语音助手已关闭。':current.wakeEnabled?(wakeLabels[current.wake?.phase]||'正在准备'):'开启关键词唤醒后，可用所选人格的唤醒词进入实时语音。'));
  const label=kind==='asr'?'实时识别模型':'播报模型';
  return h('fieldset',{className:'rabi-host-source'},h('legend',null,kind==='asr'?'语音识别':'语音播报'),problem,
    query&&h(MachineModelMenu,{key:kind,label,deviceId:current[kind+'DeviceId'],model:selected?.name||model,peers:current.modelComputers,kind,query,
      disabled,custom:source==='custom',onCustom:()=>source==='custom'||update({[kind+'Source']:'custom'}),
      commit:(deviceId,id)=>update({[kind+'Source']:'host',[kind+'DeviceId']:deviceId,[kind+'Model']:id})}),
    wakeSetting,source==='host'&&h(React.Fragment,null,
    h('p',{role:'status'},current[kind+'Issue']||(current.modelsError?'无法连接模型服务，请检查所选机器。':!model?'请选择可用模型。':kind==='tts'&&!current.voiceReady?'所选人格尚无声线，可配置人格声线或改用自定义播报。':kind==='tts'?'音色来自人格：'+(current.personaLabel||current.personaId||'未选择人格'):'使用所选机器的识别模型。')),
    nativeCapabilities,h('p',null,'麦克风和播放仍由同一助手循环管理。')),dirty&&h('p',null,'请先保存当前设置，再切换服务来源。'));
}
export function SettingsPage({children,title,onClose,open}){if(!open)return null;return h('section',{className:'rabi-assistant-settings'},h('div',{className:'rabi-settings-heading'},h('h2',null,title),h('button',{onClick:onClose},'返回对话')),children)}
export const Panel=createAssistantPanel(React,{Modal:SettingsPage,HostSettings,settingsPresentation:'page'});
export function mountAssistantPanel(element,{fetcher=fetch,resolveAvatarUrl}={}){
  const request=async(action,body)=>{const response=await fetcher('/api/voice-assistant/'+action,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});let value;try{value=await response.json()}catch{throw Error('ASSISTANT_PLUGIN_UNAVAILABLE')}if(!response.ok||value.code!==0)throw Error(value.message||'ASSISTANT_PLUGIN_UNAVAILABLE');return value.data};
  const adapter={read:async()=>{
    const state=await request('state'),id=state.hostSettings?.personaId;
    // The selected persona's existing public resource endpoint also serves the message-history page.
    return id?{...state,participants:{...state.participants,assistant:{name:state.hostSettings.personaLabel||state.settings.assistantName,avatarUrl:'/api/roles/'+encodeURIComponent(id)+'/avatar'}}}:state;
  },command:body=>request('command',body),resolveAvatarUrl,subscribeConversation(_id,listener,onError){let closed=false,timer;const poll=async()=>{try{const data=await request('messages');if(!closed)listener(data)}catch(error){if(!closed)onError(error)}finally{if(!closed)timer=setTimeout(poll,350)}};void poll();return()=>{closed=true;clearTimeout(timer)}}};
  const root=createRoot(element);root.render(h(React.Fragment,null,h('style',null,'.rabi-host-setting{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}.rabi-host-setting select{min-height:42px;border:1px solid #527080;border-radius:8px;padding:8px}.rabi-assistant-settings{width:100%}.rabi-settings-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}'),h(Panel,{adapter})));
  return()=>root.unmount();
}
