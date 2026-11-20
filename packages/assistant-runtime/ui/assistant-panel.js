export {createMessageDetailsView,recognitionRows,speechParameterRows} from './message-details.js';
/** Optional shared presenter. No capture, playback, model loop, or owner teardown. */
import { assistantPanelStyles } from './assistant-panel-styles.js'
import {speechCapabilityHelp,createSpeechCapabilityChip} from './speech-capability-help.js'
import {assistantParticipants,messageTimeLabel,createMessageAvatar} from './message-presentation.js'
import {createVisualCanvasView,visualCanvasStyles} from './visual-canvas-panel.js'
export {assistantParticipants,messageTimeLabel} from './message-presentation.js'
const settingsDelta=(value,base)=>Object.fromEntries(Object.entries(value).filter(([key,item])=>!['speechProfiles','llmProfiles'].includes(key)&&item!==base?.[key]))
export function assistantSetupGaps(state){
  if(!state)return []
  const config=state.settings||{},gaps=[]
  const hostModels=state.capabilities?.hostModels
  const hasHostModel=state.selectedModel?.model&&(!Array.isArray(hostModels)||hostModels.some(item=>item.provider===state.selectedModel.provider&&item.model===state.selectedModel.model))
  if((state.capabilities?.modelConfiguration||state.capabilities?.host==='standalone')?!config.llmModel:!hasHostModel)gaps.push({section:'conversation',label:'选择对话模型'})
  if(state.hostSettings?.asrIssue)gaps.push({section:'asr',label:state.hostSettings.asrIssue})
  else if(config.asrMode!=='native'&&!config.asrModel)gaps.push({section:'asr',label:'选择识别模型'})
  if(config.asrMode==='volcengine'&&state.credentials?.asr?.configured===false)gaps.push({section:'asr',label:'填写识别密钥'})
  if(state.hostSettings?.ttsIssue)gaps.push({section:'tts',label:state.hostSettings.ttsIssue})
  else if(!config.ttsModel||!config.ttsVoice)gaps.push({section:'tts',label:!config.ttsModel?'选择播报模型':'选择播报音色'})
  if(config.ttsProvider==='volcengine'&&state.credentials?.tts?.configured===false)gaps.push({section:'tts',label:'填写播报密钥'})
  return gaps
}
export function assistantServiceRows(state) {
  if(!state)return []
  const config=state.settings,checks=state.diagnostics?.checks||{}
  const modelProvider=state.capabilities?.modelProviders?.find(item=>item.id===config.llmProvider)?.label||config.llmProvider
  const modelName=state.capabilities?.modelCatalogs?.llm?.find(item=>item.id===config.llmModel)?.label||config.llmModel
  const asrProvider=state.hostSettings?.asrSource==='host'?'本机服务':state.capabilities?.speechProviders?.asr?.find(item=>item.id===config.asrMode)?.label||config.asrMode
  const voice=state.speechCatalogs?.[config.ttsProvider]?.tts?.voices?.find(item=>item.id===config.ttsVoice)?.label||config.ttsVoice
  const definitions=[
    {id:'model',section:'conversation',title:'对话模型',selection:[modelProvider,modelName].filter(Boolean).join(' · '),missing:!config.llmModel?'请选择对话模型':null,action:'测试连接'},
    {id:'asr',section:'asr',title:'语音识别',selection:[asrProvider,config.asrModel].filter(Boolean).join(' · '),missing:state.hostSettings?.asrIssue||(!config.asrModel&&config.asrMode!=='native'?'请选择识别模型':null),action:'识别示例'},
    {id:'tts',section:'tts',title:'语音播报',selection:[state.hostSettings?.ttsSource==='host'?'本机服务':config.ttsProvider==='volcengine'?'火山豆包':config.ttsProvider,voice].filter(Boolean).join(' · '),missing:state.hostSettings?.ttsIssue||(!config.ttsVoice?'请选择播报音色':null),action:'试听声音'},
    {id:'microphone',section:'devices',title:'麦克风',selection:config.inputDeviceId?'已选择麦克风':'系统默认麦克风',action:'录音 3 秒'},
    {id:'voice',title:'语音对话',selection:'识别、回复、播报与启停',action:'运行完整测试'},
  ]
  return definitions.map(item=>{
    const check=checks[item.id],status=item.missing?'missing':check?.status||'untested'
    const passedLabel={model:'上次连接成功',asr:'上次识别成功',tts:'播放流程通过',microphone:'上次采集正常',voice:'示例流程通过'}[item.id]
    return {...item,status,checkedAt:check?.checkedAt,label:status==='passed'?passedLabel:({failed:'测试失败',running:'测试中',warning:'需要确认',stale:'配置已更改',untested:'待测试',missing:'未完成配置'})[status]||'待测试',
      detail:item.missing||(status==='stale'?'当前配置需要重新测试':check?.detail)||'已配置，尚未运行测试'}
  })
}
export function assistantLiveState(state,disconnected=false) {
  const phase=state?.voice?.phase,capture=state?.voice?.capture;
  const listening=phase==='running'&&capture==='listening';
  const working=['thinking','responding','searching','executing-tool','finishing'].includes(state?.activity?.status);
  const playing=Boolean(state?.interaction?.outputActive);
  let title='正在连接',detail='',action='start',actionLabel='开始实时语音';
  if(state){title='语音已停止';detail='点击「开始实时语音」后直接说话。'}
  if(phase==='starting'){title='正在准备麦克风';detail='正在连接音频设备，请稍候。'}
  if(phase==='running'){
    action=listening?'pause':'resume';actionLabel=listening?'暂停麦克风':'继续收音';
    title=listening?'正在聆听':'麦克风已暂停';
    detail=listening?'直接说话即可。':'麦克风已暂停，任务会继续执行。';
  }
  if(state?.interaction?.inputPending){title=state?.asrFeedback==='streaming'?'正在听你说话':'正在识别语音';detail=listening?'识别完成后自动发送；麦克风继续开启。':'识别完成后自动发送。'}
  if(working){title=state.activity.status==='thinking'?'正在思考':'正在生成回复';detail=listening?'麦克风开启，可以继续说话。':phase==='running'?'麦克风已暂停，文字回复会继续生成。':'文字回复会继续生成。'}
  if(state?.activity?.status==='searching'){title='正在联网搜索';detail=state.activity.query||'正在查找来源，搜索完成后继续回答。'}
  if(state?.activity?.status==='executing-tool'){title='正在使用工具';detail=listening?'麦克风开启，可以继续说话。':'工具正在执行，播报会同时继续。'}
  if(state?.activity?.status==='finishing'){title='正在整理回复';detail='正在根据已取得的结果回答。'}
  if(playing&&!working){title='正在播报';detail=listening?'麦克风开启，直接说话可打断声音。':'可停止本次播报，文字回复会继续。'}
  if(phase==='failed'){title='语音出现故障';detail='检查错误提示，修复后重新开启语音。'}
  if(state?.settings?.voiceEnabled===false){title='语音助手已关闭';detail='打开语音助手开关后可开始实时语音。'}
  if(disconnected){title='与助手的连接已断开';detail='重新连接后可查看当前状态。'}
  return {title,detail,listening,working,playing,action,actionLabel,
    captureLabel:listening?'收音开启':phase==='running'?'收音暂停':phase==='starting'?'准备收音':'收音关闭',
    generationLabel:working?(state.activity.status==='executing-tool'?'工具执行中':state.activity.status==='finishing'?'整理回复':state.activity.status==='searching'?'正在联网搜索':state.activity.status==='thinking'?'正在思考':'正在生成文字'):'当前无任务',
    playbackLabel:state?.voice?.outputEnabled===false?'播报静音':playing?'正在播报':state?.interaction?.responseSuppressed?'本次声音已打断':'当前无播报'};
}
export function distinctModelLabels(values) {
  const counts=new Map();for(const item of values)counts.set(item.label,(counts.get(item.label)||0)+1);
  return values.map(item=>({...item,label:counts.get(item.label)>1?item.label+' · '+item.id:item.label}));
}
export function speechFieldError(spec,value){
  if(spec.type==='number'){
    if(value===''||typeof value!=='number'||!Number.isFinite(value))return '请填写数值。'
    if(spec.integer&&!Number.isInteger(value))return '请填写整数。'
    if(spec.min!==undefined&&value<spec.min)return '不能小于 '+spec.min+'。'
    if(spec.max!==undefined&&value>spec.max)return '不能大于 '+spec.max+'。'
  }
  if(spec.maxLength&&String(value).length>spec.maxLength)return '最多 '+spec.maxLength+' 个字符。'
  return ''
}
export function createAssistantPanel(React, { Button = 'button', Input = 'input', Modal,HostSettings,settingsPresentation='modal' }) {
  const h = React.createElement
  const MessageDetails=createMessageDetailsView(React)
  const CapabilityChip=createSpeechCapabilityChip(React)
  const MessageAvatar=createMessageAvatar(React)
  const VisualCanvas=createVisualCanvasView(React)
  const layout = { display:'flex', flexDirection:'column', gap:12, padding:16, maxWidth:1000, margin:'0 auto', color:'var(--dsw-alias-text-primary, inherit)' }
  const row = { display:'flex', flexWrap:'wrap', gap:8, alignItems:'center' }
  const label = { display:'flex', flexDirection:'column', gap:6, marginBottom:12 }
  const errors = {
    TURN_DECISION_INVALID:'助手返回的动作格式有误，本轮未能完成。可以继续说话或重新发送。',
    TURN_INTERJECTION_RESPONSE_INVALID:'助手未能处理这次插话，可以再说一次。',
    SPEECH_SEND_BACKLOG:'识别音频发送积压，收音已停止。请检查网络后重新开启语音。',
    ASSISTANT_VOICE_DISABLED:'请先打开语音助手开关。',
    ASSISTANT_PERSONA_READ_FAILED:'无法读取所选人格，请查看人格设置中的错误详情。',
    ASSISTANT_HOST_OPERATION_FAILED:'Rabi 宿主操作未完成，请查看服务设置中的错误详情。',
    'Failed to fetch':'与本机助手的连接已断开，请确认后台服务正在运行后重试。',
    WEB_SEARCH_BUSY:'正在执行搜索或对话，请等待完成后重试。',
    WEB_SEARCH_UNSUPPORTED:'当前对话接口没有已适配的搜索能力。请在联网搜索中选择独立服务。',
    WEB_SEARCH_CREDENTIAL_REQUIRED:'请保存所选搜索服务的 API Key。',
    WEB_SEARCH_AUTH_FAILED:'搜索认证失败，请检查对应服务的密钥。',
    WEB_SEARCH_FORBIDDEN:'搜索服务拒绝访问，请检查账号权限和服务开通状态。',
    WEB_SEARCH_RATE_LIMITED:'搜索服务额度不足或请求过于频繁，请稍后重试。',
    WEB_SEARCH_PROVIDER_FAILED:'搜索服务未完成请求，请稍后重试。',
    WEB_SEARCH_FAILED:'搜索没有完成，请重新测试搜索连接。',
    WEB_SEARCH_CANCELLED:'搜索已停止或超时。',
    WEB_SEARCH_NO_SOURCES:'没有获得可用的来源，请换一个搜索问题重试。',
    WEB_SEARCH_NOT_EXECUTED:'当前模型没有实际执行搜索。请检查模型支持情况或选择独立服务。',
    WORKBUDDY_SEARCH_NOT_EXECUTED:'WorkBuddy 本轮未调用官方搜索，请重试。',
    WORKBUDDY_SEARCH_FAILED:'WorkBuddy 官方搜索失败，请检查官方登录和额度后重试。',
    MODEL_CATALOG_HTTP_401:'模型列表认证失败，请保存当前提供商的密钥后重试。',
    MODEL_CATALOG_UNAVAILABLE:'这个接口不提供模型列表，可手动填写模型名。',
    MODEL_CREDENTIAL_PROVIDER_MISMATCH:'这把密钥与当前提供商不匹配，请先选择正确的提供商。',
    WORKBUDDY_CLI_NOT_INSTALLED:'尚未找到官方 CodeBuddy CLI，请安装后配置本机启动路径。',
    WORKBUDDY_LOGIN_REQUIRED:'请在官方 CodeBuddy 中登录国内账号，再刷新模型。',
    WORKBUDDY_REPLY_FAILED:'WorkBuddy 没有返回有效回复。请运行对话连接测试，查看具体故障。',
    WORKBUDDY_CLI_FAILED:'官方 CodeBuddy 运行失败，请运行对话连接测试。',
    WORKBUDDY_CLI_INSTALL_INVALID:'当前 CodeBuddy CLI 安装不完整或默认 Agent 模板不可用，请修复或重新选择完整的官方 CLI。',
    WORKBUDDY_REQUEST_CANCELLED:'本轮对话已取消。',
    WORKBUDDY_REQUEST_TIMEOUT:'WorkBuddy 回复超时，本轮调用已停止。',
    WORKBUDDY_PROTOCOL_INVALID:'WorkBuddy 返回的数据无法解析，请重试或检查官方客户端。',
    DEVICE_PLAYBACK_BACKLOG:'播放缓冲区已满，请停止本次播报后重试。文字回复仍会保留。',
    WORKBUDDY_CLI_EXIT_UNCONFIRMED:'上一轮 WorkBuddy 进程尚未确认退出，请稍后重试。',
    LOCAL_ASR_NOT_CONFIGURED:'本机识别模型尚未就绪，请检查离线模型设置。',
    LOCAL_ASR_FAILED:'本机语音识别失败，请检查模型和运行环境后重试。',
    SPEECH_PROVIDER_ERROR_45000081:'识别服务等待音频包超时，请检查音频采集后重试。',
    ASR_SAMPLE_TIMEOUT:'识别示例超时，请检查识别服务和连接后重试。',
    ASR_SAMPLE_SOURCE_UNAVAILABLE:'识别示例文件缺失或损坏，请修复助手安装。也可返回对话，开启语音测试识别。',
    ASR_SAMPLE_CANCELLED:'识别示例已停止。',
    SPEECH_SAMPLE_FORMAT:'示例音频格式不支持。',
    ASR_SAMPLE_TEST_UNAVAILABLE:'当前识别模式尚不支持示例测试，请使用已配置的本机识别服务。',
    ASSISTANT_CHECK_BUSY:'测试正在进行，请等待当前测试结束。',
    SPEECH_TEST_UNMUTE_REQUIRED:'请先点击“恢复播报”，再测试声音。',
    SPEECH_PLAYBACK_TIMEOUT:'播放未在预期时间内结束，请检查扬声器后重试。',
    SPEECH_CREDENTIAL_REQUIRED:'当前语音服务缺少密钥，请在对应服务的配置中保存密钥。',
    SPEECH_TTS_MODEL_REQUIRED:'请在设置中填写播报模型和音色。', SPEECH_ASR_MODEL_REQUIRED:'请在设置中填写识别模型。',
    ASSISTANT_STOP_VOICE_BEFORE_TEST:'请先停止语音，再进行设备测试。', ASSISTANT_DEVICE_TEST_BUSY:'设备测试正在进行，请稍候。',
    DEVICE_START_TIMEOUT:'音频进程启动超时。', DEVICE_CAPTURE_INTERRUPTED:'麦克风采集已中断，请检查设备。',
    RESIDENT_CLEANUP_UNCONFIRMED:'旧音频资源尚未确认释放，暂不能再次开启。',
    ASSISTANT_PRESET_COMPLETE_PROMPT:'当前 DSH 默认预设锁定了完整系统提示词，无法应用可编辑人设。请在 DSH 预设中关闭完整提示词模式后重试。',
    SPEECH_NATIVE_UNAVAILABLE:'当前宿主尚未启用原生识别服务。请配置识别服务，或选择其它提供商；文字仍可使用。',
    ASSISTANT_MODEL_REQUIRED:'请在设置中选择对话模型。',
    ASSISTANT_TOOL_OUTCOME_UNCONFIRMED:'工具结果尚未确认。保留原请求编号，先核对原回执；没有自动重发。',
    SPEECH_PROVIDER_HTTP_403:'语音服务拒绝访问所选资源。请核对当前模型、计费资源是否已开通，以及该密钥是否有使用权限。',
    SPEECH_PROVIDER_HTTP_401:'语音服务未通过认证。请核对当前提供商、接口地址和 API Key。',
    ASSISTANT_MODEL_HTTP_401:'对话服务未通过认证。请核对模型接口与 API Key。',
    ASSISTANT_CONTEXT_CHANGED:'会话已切换，请核对当前对话后再发送。',
    ASSISTANT_CONTEXT_BUSY:'助手仍在处理消息，完成后再清除上下文。',
    ASSISTANT_CONTEXT_SAVE_FAILED:'对话保存失败，请重试保存，暂时不要退出助手。',
    ASSISTANT_CONTEXT_STORAGE_FULL:'对话所在磁盘已满。请释放该磁盘的空间，再重试连接或保存。',
    SPEECH_CREDENTIAL_TARGET_CHANGED:'提供商或接口地址已变化，请刷新设置后重新保存密钥。',
  }
  return function AssistantPanel({ adapter }) {
    const [state,setState] = React.useState(null), [messages,setMessages] = React.useState([])
    const [message,setMessage] = React.useState(''), [text,setText] = React.useState(''), [pending,setPending] = React.useState(null)
    const [editing,setEditing] = React.useState(false), [draft,setDraft] = React.useState({}), [devices,setDevices] = React.useState([])
    const [keys,setKeys] = React.useState({asr:'',tts:'',llm:'',search:''}), [busy,setBusy] = React.useState(false)
    const [settingsTab,setSettingsTab]=React.useState('conversation'),[catalogs,setCatalogs]=React.useState({}),[manual,setManual]=React.useState({}),[hostProvider,setHostProvider]=React.useState('')
    const [speechKind,setSpeechKind]=React.useState('asr'),[parameterSearch,setParameterSearch]=React.useState(''),[voiceSearch,setVoiceSearch]=React.useState(''),[manualVoice,setManualVoice]=React.useState(false)
    const [favoritesOnly,setFavoritesOnly]=React.useState(false),[expressiveOnly,setExpressiveOnly]=React.useState(false)
    const [showIdentifiers,setShowIdentifiers]=React.useState(false),[closePrompt,setClosePrompt]=React.useState(false)
    const [draftBase,setDraftBase]=React.useState({}),[draftPatches,setDraftPatches]=React.useState([]),[draftCredentials,setDraftCredentials]=React.useState(null)
    const [connectionError,setConnectionError]=React.useState(false)
    const [checksExpanded,setChecksExpanded]=React.useState(null)
    const preview=Boolean(state?.capabilities?.preview)
    const conversationMissing=assistantSetupGaps(state).some(item=>item.section==='conversation')
    const serviceRows=assistantServiceRows(state)
    const testJob=state?.diagnostics?.job,testRunning=testJob?.status==='running'
    const checksPassed=serviceRows.length>0&&serviceRows.every(item=>item.status==='passed')
    const showChecks=testRunning||(checksExpanded??!checksPassed)
    const live=assistantLiveState(state,connectionError)
    const voicePreference=state?.settings?.voiceEnabled
    const voiceDisabled=voicePreference===false
    const voiceSwitch=typeof voicePreference==='boolean'&&h(Button,{className:'va-voice-switch',role:'switch','aria-checked':voicePreference,
      disabled:preview||busy||testRunning||connectionError,onClick:()=>invoke({action:'settings',patch:{voiceEnabled:!voicePreference}})},
    '语音助手',h('span',{'aria-hidden':true}))
    const participants=assistantParticipants(state)
    const chat=React.useRef(null),composer=React.useRef(null),follow=React.useRef(true),onboardingOpened=React.useRef(false)
    const motionMessages=React.useRef(new Set()),motionSession=React.useRef(null)
    const [unseen,setUnseen]=React.useState(false)
    const [detailId,setDetailId]=React.useState(null),[detailData,setDetailData]=React.useState(null),[detailError,setDetailError]=React.useState(''),[detailLoading,setDetailLoading]=React.useState(false)
    const [clearPrompt,setClearPrompt]=React.useState(false),[historyBusy,setHistoryBusy]=React.useState(false),[moreHistory,setMoreHistory]=React.useState(null)
    const historyLoaded=React.useRef(false),historyRestore=React.useRef(null),conversationScope=React.useRef(null)
    conversationScope.current=state?.sessionId
    const detailSelected=React.useRef(null),detailVersion=React.useRef(0),detailReturn=React.useRef(null)
    detailSelected.current=detailId
    const pages=React.useRef(null)
    const mounted = React.useRef(false)
    const report = error => { if (mounted.current) setMessage(errors[error.message] || '操作未确认：' + error.message) }
    const refresh = async () => { try{const next = await adapter.read(); if(mounted.current){setState(next);setConnectionError(false);setMessage(current=>current===errors['Failed to fetch']||(current===errors.ASSISTANT_CONTEXT_STORAGE_FULL&&!next.context?.error)?'':current)}return next}catch(error){if(mounted.current)setConnectionError(true);throw error} }
    const readDetails=async(id,quiet=false)=>{
      const version=++detailVersion.current,valid=()=>mounted.current&&detailSelected.current===id&&detailVersion.current===version
      if(!quiet)setDetailLoading(true)
      try{const value=await adapter.command({action:'message-details',messageId:id});if(valid()){setDetailData(value);setDetailError('')}}
      catch(failure){if(valid())setDetailError(failure.message)}finally{if(valid())setDetailLoading(false)}
    }
    const openDetails=item=>{detailReturn.current={top:chat.current?.scrollTop||0,follow:follow.current};setDetailData(null);setDetailError('');setDetailId(item.id)}
    const detailActivity=state?.activity?.responseId===detailId?state.activity:null
    const detailSpeech=state?.speechProgress?.find(item=>item.responseId===detailId)
    React.useEffect(()=>{if(detailId)void readDetails(detailId,Boolean(detailData))},[adapter,detailId,detailActivity?.status,detailActivity?.tool?.callId,detailSpeech?.playbackId,detailSpeech?.speechStatus])
    React.useLayoutEffect(()=>{if(!detailId&&detailReturn.current&&chat.current){chat.current.scrollTop=detailReturn.current.top;follow.current=detailReturn.current.follow;detailReturn.current=null}},[detailId])
    React.useEffect(() => {
      mounted.current=true; let timer, cancelled=false
      const poll=async()=>{let delay=700;try{const next=await refresh();if(next.voice?.capture==='listening')delay=120}catch(error){report(error)}finally{if(!cancelled)timer=setTimeout(poll,delay)}}
      void adapter.command({action:'prepare'}).then(poll, error=>{report(error);void poll()})
      return ()=>{mounted.current=false;cancelled=true;clearTimeout(timer)}
    },[adapter])
    React.useEffect(()=>{
      if(!state?.sessionId)return
      historyLoaded.current=false;setMoreHistory(null);setClearPrompt(false);setMessages([])
      const scope=state.sessionId
      return adapter.subscribeConversation(scope,value=>{if(mounted.current&&conversationScope.current===scope)setMessages(current=>{if(!historyLoaded.current)return value;const ids=new Set(value.map(item=>item.id));return [...current.filter(item=>!ids.has(item.id)),...value]})},report)
    },[adapter,state?.sessionId])
    const command=async(request,feedback)=>{
      setBusy(true)
      try{const result=await adapter.command(request);const next=await refresh();if(mounted.current&&result?.settingsScopeChanged){setDraft(next.settings);setDraftBase(next.settings);setDraftPatches([]);setDraftCredentials(null);setCatalogs({});setKeys({asr:'',tts:'',llm:'',search:''})}if(mounted.current&&feedback)setMessage(typeof feedback==='function'?feedback(result):feedback);return result}
      catch(error){report(error);throw error}finally{if(mounted.current)setBusy(false)}
    }
    const invoke=(request,feedback)=>{void command(request,feedback).catch(()=>{})}
    const send=async()=>{
      if(preview||testRunning||conversationMissing||busy||!state||connectionError||!text.trim()&&!pending)return
      const request=pending||{action:'text',text,requestId:crypto.randomUUID(),sessionId:state.sessionId}
      setMessage('')
      setPending(request)
      try{await command(request);if(mounted.current){setPending(null);setText('')}}catch{}
    }
    React.useEffect(()=>{if(state?.settings?.onboardingComplete===false&&!onboardingOpened.current){onboardingOpened.current=true;openSettings('setup')}},[state?.settings?.onboardingComplete])
    const messageRevision=messages.map(item=>item.id+':'+(item.text?.length||0)).join('|')
    React.useLayoutEffect(()=>{
      const node=chat.current,elements=node?[...node.querySelectorAll('[data-message-id]')]:[],ids=new Set(elements.map(item=>item.dataset.messageId)),prior=motionMessages.current
      const sameSession=motionSession.current===state?.sessionId
      if(node&&sameSession&&prior.size&&typeof matchMedia==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
        for(const item of elements)if(!prior.has(item.dataset.messageId))item.animate?.([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,.75,.25,1)'})
      }
      motionMessages.current=ids;motionSession.current=state?.sessionId
    },[messageRevision,state?.sessionId,state?.activity?.responseId,state?.activity?.status])
    React.useLayoutEffect(()=>{const node=chat.current;if(!node)return;if(historyRestore.current){const previous=historyRestore.current;historyRestore.current=null;node.scrollTop=previous.top+node.scrollHeight-previous.height;return}if(follow.current){node.scrollTop=node.scrollHeight;setUnseen(false)}else setUnseen(true)},[messageRevision,state?.inputPreview?.text])
    React.useEffect(()=>{
      const node=chat.current;if(!node||typeof ResizeObserver==='undefined')return
      const observer=new ResizeObserver(()=>{if(follow.current)node.scrollTop=node.scrollHeight})
      observer.observe(node);return()=>observer.disconnect()
    },[editing,detailId])
    const loadHistory=async()=>{
      if(historyBusy||!messages.length)return;setHistoryBusy(true);const scope=state.sessionId;
      try{const page=await adapter.command({action:'message-history',before:messages[0].id});if(!mounted.current||conversationScope.current!==scope||page.sessionId!==scope)return;
        historyLoaded.current=true;follow.current=false;historyRestore.current={top:chat.current.scrollTop,height:chat.current.scrollHeight};setMoreHistory(page.hasMore);setMessages(current=>{const ids=new Set(current.map(item=>item.id));return[...page.messages.filter(item=>!ids.has(item.id)),...current]})
      }catch(error){report(error)}finally{if(mounted.current)setHistoryBusy(false)}
    }
    const clearContext=async()=>{try{await command({action:'clear-context',sessionId:state.sessionId,confirm:true});setMessages([]);setPending(null);setClearPrompt(false);follow.current=true;setMessage('已开始新对话。')}catch{}}
    const dirty=draftPatches.length>0||Object.keys(settingsDelta(draft,draftBase)).length>0||Object.values(keys).some(Boolean)
    const pendingPatches=()=>{const delta=settingsDelta(draft,draftBase);return [...draftPatches,...(Object.keys(delta).length?[delta]:[])]}
    const closeSettings=()=>{if(state?.settings?.onboardingComplete===false)invoke({action:'settings',patch:{onboardingComplete:true}});setEditing(false);setClosePrompt(false);setKeys({asr:'',tts:'',llm:'',search:''})}
    const requestClose=()=>{if(busy)return;if(dirty)setClosePrompt(true);else closeSettings()}
    const openSettings=(section)=>{setDraft({...state.settings});setDraftBase({...state.settings});setDraftPatches([]);setDraftCredentials(null);setKeys({asr:'',tts:'',llm:'',search:''});setHostProvider('');setMessage('');setClosePrompt(false);if(typeof section==='string')navigateSettings(section);setEditing(true)}
    const navigateSettings=id=>{setSettingsTab(id==='asr'||id==='tts'?'speech':id);if(id==='asr'||id==='tts')setSpeechKind(id);setParameterSearch('');if(pages.current)pages.current.scrollTop=0}
    const previewSelection=async patch=>{
      validateSpeechDraft()
      const patches=[...pendingPatches(),patch]
      if(patches.length>64){setMessage('本轮修改较多，请先保存设置。');return}
      const result=await command({action:'preview-settings',patches})
      setDraft(result.settings);setDraftBase(result.settings);setDraftPatches(patches);setDraftCredentials(result.credentials)
    }
    const commitDraft=async()=>{
      validateSpeechDraft()
      const result=await command(state.settingsDraft?{action:'settings',patches:pendingPatches()}:{action:'settings',patch:settingsDelta(draft,state.settings)})
      setDraft(result.settings);setDraftBase(result.settings);setDraftPatches([]);setDraftCredentials(null)
      if(keys.search){await command({action:'web-search-credential',key:keys.search});setKeys(current=>({...current,search:''}))}
      for(const kind of ['llm','asr','tts'])if(keys[kind]){
        const config=result.settings,provider=kind==='asr'?config.asrMode:kind==='tts'?config.ttsProvider||'compatible':config.llmProvider||'compatible'
        await command({action:'credential',kind,key:keys[kind],provider,endpoint:config[kind+'Endpoint']});setKeys(current=>({...current,[kind]:''}))
      }
      return result.settings
    }
    const edit=(key,value)=>{setMessage('');setDraft(current=>({...current,[key]:value}))}
    const field=(title,key,type='text')=>h('label',{style:label,key},title,h(Input,{type,value:draft[key]??'',onChange:event=>edit(key,type==='number'?Number(event.target.value):event.target.value),'aria-label':title}))
    const check=(title,key,disabled=false)=>h('label',{style:row,key},h('input',{type:'checkbox',checked:Boolean(draft[key]),disabled,onChange:event=>edit(key,event.target.checked)}),title)
    const select=(title,key,options)=>h('label',{style:label,key},title,h('select',{value:draft[key]??'',onChange:event=>edit(key,typeof draft[key]==='number'?Number(event.target.value):event.target.value)},options.map(([value,title])=>h('option',{key:value,value},title))))
    const providerId=kind=>kind==='asr'?draft.asrMode:kind==='tts'?(draft.ttsProvider||'compatible'):(draft.llmProvider||'compatible')
    const dirtyKind=kind=>Object.fromEntries(Object.entries(draft).filter(([key,value])=>key.startsWith(kind)&&!key.endsWith('Profiles')&&value!==state.settings[key]))
    const validateSpeechDraft=kind=>{
      for(const currentKind of kind?[kind]:['asr','tts'])for(const spec of speechCatalog(currentKind)?.parameters||[]){
        if(!enabledParameter(spec))continue
        const error=speechFieldError(spec,draft[spec.key]??spec.default)
        if(error){setSettingsTab('speech');setSpeechKind(currentKind);setParameterSearch(spec.label);setMessage(spec.label+'：'+error);throw Error('SPEECH_FORM_INVALID')}
      }
    }
    const saveConnection=async kind=>dirty?commitDraft():state.settings
    const credentialState=kind=>kind==='search'?state?.credentials?.search:draft[kind+'Endpoint']!==draftBase[kind+'Endpoint']?{configured:false}:(draftCredentials||state?.credentials)?.[kind]
    const credential=kind=>h('details',{className:'va-credential',open:!credentialState(kind)?.configured||Boolean(keys[kind])},h('summary',null,credentialState(kind)?.configured?'密钥已保存 · 更换':'设置连接密钥'),h('label',{style:label},providerId(kind)==='workbuddy-cn'?'网关密钥':'API Key',h(Input,{type:'password',disabled:preview,autoComplete:'new-password',value:keys[kind]||'',placeholder:credentialState(kind)?.configured?'留空保留已保存密钥':'填写当前提供商的密钥','aria-label':kind+' API Key',onChange:event=>setKeys(current=>({...current,[kind]:event.target.value}))})),h('small',null,keys[kind]?'点击底部“保存设置”后生效；切换提供商会清空未保存密钥。':preview?'预览不接收真实密钥，请在实际助手中配置。':'密钥不会显示在页面上。'))
    const loadModels=async kind=>{try{const config=await saveConnection(kind);const value=await command({action:'models',kind,provider:providerId(kind),endpoint:config[kind+'Endpoint']});setCatalogs(current=>({...current,[kind]:value}));setMessage(preview?'以下为界面示例，未连接提供商，不能用于对话。':value.length?'已读取 '+value.length+' 个模型；请选择后保存，再发送一条消息验证。':'没有返回模型，可手动填写。')}catch{}}
    const modelSelect=kind=>{const values=catalogs[kind]?.length?catalogs[kind]:(kind==='llm'&&draft.llmProvider===state?.settings?.llmProvider&&state?.capabilities?.modelCatalogs?.[kind])||[],current=draft[kind+'Model']||'';return h('div',{style:label},h('label',{style:label},'模型',manual[kind]?h(Input,{value:current,'aria-label':kind+' 模型',onChange:event=>edit(kind+'Model',event.target.value)}):h('select',{value:current,disabled:busy||!current&&!values.length,'aria-label':kind+' 模型',onChange:event=>edit(kind+'Model',event.target.value)},h('option',{value:''},values.length?'选择模型':'先刷新模型列表'),current&&!values.some(item=>item.id===current)&&h('option',{value:current},current),distinctModelLabels(values).map(item=>h('option',{key:item.id,value:item.id},item.label+(preview?' · 示例，不可调用':''))))),h('div',{style:row},h(Button,{disabled:busy,onClick:()=>void loadModels(kind)},preview?'查看示例模型':dirty?'保存并刷新模型':'刷新模型'),h(Button,{onClick:()=>setManual(current=>({...current,[kind]:!current[kind]}))},manual[kind]?'从列表选择':'手动填写')))}
    const chooseProvider=async(kind,id)=>{
      setMessage('')
      setKeys(current=>({...current,[kind]:''}))
      setCatalogs(current=>({...current,[kind]:[]}))
      const selection=kind==='asr'?'asrMode':kind==='tts'?'ttsProvider':'llmProvider'
      const dirty=dirtyKind(kind)
      try{
        if(state.settingsDraft){await previewSelection({[selection]:id});return}
        validateSpeechDraft(kind)
        if(Object.keys(dirty).length)await command({action:'settings',patch:dirty})
        const result=await command({action:'settings',patch:{[selection]:id}})
        const settings=result.settings
        setDraft(current=>({...current,...Object.fromEntries(Object.entries(settings).filter(([key])=>key.startsWith(kind))),speechProfiles:settings.speechProfiles}));setDraftBase(settings)
      }catch{}
    }
    const providerSelect=kind=>{
      const choices=kind==='llm'?(state?.capabilities?.modelProviders||[{id:'compatible',label:'OpenAI / 兼容服务'}]):state?.capabilities?.speechProviders?.[kind]||(kind==='asr'?[{id:'native',label:'DSH 已配置的识别服务'},{id:'compatible',label:'OpenAI / 兼容服务'}]:[{id:'compatible',label:'OpenAI / 兼容服务'}])
      return h('label',{style:label,className:'va-provider'},'提供商',h('select',{disabled:busy,value:providerId(kind),onChange:event=>void chooseProvider(kind,event.target.value),'aria-label':kind+' 提供商'},choices.map(item=>h('option',{key:item.id,value:item.id},item.label))))
    }
    const hostModels=state?.capabilities?.hostModels||[],hostGroups=[...new Map(hostModels.map(item=>[item.provider,item.providerLabel||item.provider])).entries()]
    const selectedHost=hostProvider||state?.selectedModel?.provider||hostGroups[0]?.[0]||''
    const speechCatalog=kind=>{const catalog=state?.speechCatalogs?.[providerId(kind)]?.[kind];if(!catalog?.origins)return catalog;try{return catalog.origins.includes(new URL(draft[kind+'Endpoint']).origin)?catalog:undefined}catch{return undefined}}
    const enabledParameter=spec=>(!spec.models||spec.models.includes(draft[spec.kind==='asr'?'asrModel':'ttsModel']))
      &&(!spec.requiresExpressive||draft.ttsModel!=='seed-icl-2.0'||draft.ttsVariant==='seed-tts-2.0-expressive')
      &&(!spec.enabledWhen||(spec.enabledWhen.oneOf?spec.enabledWhen.oneOf.includes(draft[spec.enabledWhen.key]):spec.enabledWhen.notEmpty?Boolean(draft[spec.enabledWhen.key]):draft[spec.enabledWhen.key]===spec.enabledWhen.equals))
      &&!spec.disabledWhenAny?.some(key=>draft[key])&&!spec.disabledModes?.includes(draft.asrRecognitionMode)
    const disabledReason=spec=>{
      const fields=[...(speechCatalog('asr')?.parameters||[]),...(speechCatalog('tts')?.parameters||[])],name=key=>fields.find(item=>item.key===key)?.label||key
      if(spec.models&&!spec.models.includes(draft[spec.kind==='asr'?'asrModel':'ttsModel']))return '当前模型不支持'
      if(spec.requiresExpressive&&draft.ttsModel==='seed-icl-2.0'&&draft.ttsVariant!=='seed-tts-2.0-expressive')return '需将合成版本切换为“表现力增强版”'
      if(spec.enabledWhen){const rule=spec.enabledWhen;if(rule.equals===true&&!draft[rule.key])return '先开启“'+name(rule.key)+'”';if(rule.notEmpty&&!draft[rule.key])return '先填写“'+name(rule.key)+'”';return '需要调整“'+name(rule.key)+'”'}
      const blocking=spec.disabledWhenAny?.filter(key=>draft[key]);if(blocking?.length)return '与“'+blocking.map(name).join('、')+'”不能同时使用'
      return '当前识别模式不支持'
    }
    const parameterControl=spec=>{
      const enabled=enabledParameter(spec),disabled=busy||!enabled,value=draft[spec.key]??spec.default
      const error=enabled?speechFieldError(spec,value):'',errorId='speech-error-'+spec.key
      const props={'aria-label':spec.label,'aria-invalid':Boolean(error),'aria-describedby':error?errorId:undefined,disabled,value,onChange:event=>edit(spec.key,typeof spec.default==='number'&&event.target.value!==''?Number(event.target.value):event.target.value)}
      let control
      if(spec.type==='boolean')control=h('label',{style:row},h('input',{type:'checkbox',checked:Boolean(value),disabled,onChange:event=>edit(spec.key,event.target.checked)}),spec.label)
      else if(spec.key==='ttsEmotion'&&speechCatalog('tts')?.voices.find(item=>item.id===draft.ttsVoice)){
        const choices=speechCatalog('tts').voices.find(item=>item.id===draft.ttsVoice).emotions
        control=h('label',{style:label},spec.label,h('select',{...props,disabled:disabled||!choices.length},h('option',{value:''},choices.length?'不指定情绪':'此音色未提供情绪标签，请使用风格提示词'),choices.map(item=>h('option',{key:item.id,value:item.id},item.label))))
      }
      else if(spec.type==='select')control=h('label',{style:label},spec.label,h('select',props,spec.options.map(item=>h('option',{key:item.id,value:item.id,disabled:item.supported===false},item.label))))
      else if(spec.type==='vector')control=h('fieldset',null,h('legend',null,spec.label),spec.dimensions.map((dimension,index)=>h('label',{key:dimension.id,style:label},dimension.label,h(Input,{type:'number',min:dimension.min,max:dimension.max,step:dimension.step??.01,disabled,'aria-label':spec.label+' · '+dimension.label,value:value?.[index]??dimension.default??0,onChange:event=>{const next=spec.dimensions.map((item,i)=>value?.[i]??item.default??0);next[index]=Number(event.target.value);edit(spec.key,next)}}))))
      else control=h('label',{style:label},spec.label,h(spec.type==='textarea'?'textarea':Input,{...props,type:spec.type==='number'?'number':'text',min:spec.min,max:spec.max,step:spec.integer?1:'any',maxLength:spec.maxLength,rows:spec.type==='textarea'?3:undefined}))
      return h('div',{key:spec.key,className:'va-parameter'+(['textarea','vector'].includes(spec.type)?' va-parameter-wide':''),'data-enabled':enabled},control,
        error&&h('small',{id:errorId,role:'alert',className:'va-error'},error),
        spec.note&&h('small',{className:'va-note'},spec.note),
        !enabled&&h('small',{className:'va-disabled'},disabledReason(spec)),
        h('small',{className:'va-default'},'默认：'+(spec.default===''?'不指定':typeof spec.default==='boolean'?(spec.default?'开启':'关闭'):String(spec.default))+(spec.min!==undefined?' · 最小 '+spec.min:'')+(spec.max!==undefined?' · 最大 '+spec.max:'')),
        showIdentifiers&&h('code',null,spec.parameter||spec.key))
    }
    const rawProviderParameters=kind=>{
      const catalog=speechCatalog(kind);if(!catalog)return h('p',null,'此服务尚未提供模型参数目录，当前仅支持基本连接配置。')
      const needle=parameterSearch.trim().toLowerCase(),fields=(catalog.parameters||[]).filter(spec=>spec.owner!=='agent'&&spec.owner!=='system'&&!spec.feature&&(kind!=='tts'||!['ttsVariant','ttsSpeed','ttsSpeechRate','ttsLoudnessRate'].includes(spec.key))).filter(spec=>!needle||[spec.label,spec.key,spec.parameter,spec.group].some(value=>String(value||'').toLowerCase().includes(needle)))
      const groups=[...new Set(fields.map(spec=>spec.group||'其他参数'))]
      return h('div',null,h('div',{className:'va-parameter-toolbar'},h('label',{style:label},kind==='asr'?'识别偏好':'模型参数',h(Input,{value:parameterSearch,placeholder:'搜索功能，如情绪、语速、分句…','aria-label':'搜索模型参数',onChange:event=>setParameterSearch(event.target.value)})),h('label',{className:'va-identifiers'},h('input',{type:'checkbox',checked:showIdentifiers,onChange:event=>setShowIdentifiers(event.target.checked)}),'显示参数名')),
        h('div',{className:'va-parameter-groups'},groups.map(group=>h('details',{key:group,className:'va-group',open:needle?true:undefined},h('summary',null,h('span',null,group),h('span',{className:'va-count'},fields.filter(spec=>(spec.group||'其他参数')===group).length+' 项')),kind==='asr'&&group==='识别信息'&&catalog.detectionInfo&&h('p',{className:'va-help'},catalog.detectionInfo,' ',h('a',{href:catalog.billingDocs,target:'_blank',rel:'noreferrer'},'官方计费说明')),h('div',{className:'va-parameter-grid'},fields.filter(spec=>(spec.group||'其他参数')===group).map(parameterControl))))),
        !fields.length&&h('p',null,'没有匹配的参数。'),h('p',null,h('a',{href:catalog.docs,target:'_blank',rel:'noreferrer'},'官方参数文档'),' · '+catalog.verifiedAt))
    }
    const asrCapabilities=()=>{
      const catalog=speechCatalog('asr');if(!catalog)return rawProviderParameters('asr')
      const fields=catalog.parameters||[],features=fields.filter(spec=>spec.feature),system=fields.filter(spec=>spec.owner==='system'),selection=(catalog.models.find(item=>item.id===draft.asrModel)?.label||draft.asrModel)
      const feature=spec=>{const available=enabledParameter(spec),on=available&&Boolean(draft[spec.key]??spec.default),status=on?'available':available?'metadata':'unavailable'
        return h('div',{key:spec.key,className:'va-asr-feature','data-asr-capability':spec.key},h('input',{type:'checkbox','aria-label':'启用'+spec.label,checked:Boolean(draft[spec.key]??spec.default),disabled:busy||!available,onChange:event=>edit(spec.key,event.target.checked)}),h(CapabilityChip,{help:speechCapabilityHelp(providerId('asr'),spec,catalog),status,statusLabel:on?'已开启':available?'已关闭':'当前模式不支持',reason:available?'':disabledReason(spec),selection}))}
      return h('div',{className:'va-asr-capabilities'},
        h('div',{className:'va-asr-heading'},h('h3',null,'识别能力'),h(Button,{disabled:busy,onClick:()=>{for(const spec of features)if(enabledParameter(spec))edit(spec.key,true)}},'全部启用')),
        h('h4',null,'返回识别信息'),h('div',{className:'va-cap-grid'},features.filter(spec=>['识别信息','返回信息'].includes(spec.group)).map(feature)),
        catalog.detectionInfo&&h('p',{className:'va-note'},catalog.detectionInfo),
        h('h4',null,'输入辅助'),h('div',{className:'va-cap-grid'},features.filter(spec=>!['识别信息','返回信息'].includes(spec.group)).map(feature)),
        h('details',{className:'va-asr-preferences'},h('summary',null,'识别偏好 · 语言、分句与词典'),rawProviderParameters('asr')),
        system.length>0&&h('details',{className:'va-asr-system'},h('summary',null,'程序自动处理'),h('div',{className:'va-cap-grid'},system.map(spec=>h(CapabilityChip,{key:spec.key,help:speechCapabilityHelp(providerId('asr'),spec,catalog),status:enabledParameter(spec)?'available':'unavailable',statusLabel:enabledParameter(spec)?spec.integration==='dialog-context'?(draft.asrUseContext?'自动附带对话':'对话辅助已关闭'):'共享语音循环管理':'当前模型不支持',selection})))))
    }
    const ttsCapabilities=(summaryOnly=false)=>{
      const catalog=speechCatalog('tts');if(!catalog)return summaryOnly?h('section',{className:'va-expression-card','aria-label':'所选模型的 Agent 能力'},h('h3',null,'模型扩展能力未核验'),h('p',{className:'va-note'},'当前仅提供基础文本播报，不向 Agent 声明未经核验的表达能力。')):null
      const model=catalog.models.find(item=>item.id===draft.ttsModel),voice=catalog.voices?.find(item=>item.id===draft.ttsVoice&&item.model===draft.ttsModel)
      const hostReady=Boolean(state?.speechExpression?.available),selection=[state?.capabilities?.speechProviders?.tts?.find(item=>item.id===providerId('tts'))?.label||providerId('tts'),model?.label||draft.ttsModel||'未选择模型',voice?.label||(draft.ttsVoice?'专属音色':'未选择音色')].join(' · ')
      const agentFields=(catalog.parameters||[]).filter(spec=>spec.owner==='agent'||spec.expressionField)
      const supported=spec=>Boolean(model?.supported)&&enabledParameter({...spec,enabledWhen:undefined})&&(spec.key!=='ttsEmotion'&&spec.key!=='ttsEmotionScale'||Boolean(voice?.emotions?.length))
      const reason=spec=>!model?(draft.ttsModel?'该模型的扩展能力尚未核验':'请先选择模型'):!model.supported?'当前模型尚未接入':!enabledParameter({...spec,enabledWhen:undefined})?disabledReason(spec):!draft.ttsVoice?'选择音色后确定':!voice?'专属音色的情绪能力尚未核验':'当前音色未提供情绪标签'
      const inputTags=(catalog.inputCapabilities||['文本输入']).map(value=>typeof value==='string'?{label:value}:value)
      const outputTags=catalog.outputCapabilities||[{label:'音频输出',status:'available'}]
      const canDynamic=Boolean(hostReady&&model?.supported&&draft.ttsVoice&&voice?.bidirectional!==false)
      const waitingReason=!hostReady?'宿主未接通':!draft.ttsVoice?'待选音色':voice?.bidirectional===false?'音色未接入':''
      const primary=(catalog.parameters||[]).filter(spec=>spec.owner==='user'&&['ttsVariant','ttsSpeed','ttsSpeechRate','ttsLoudnessRate'].includes(spec.key)&&(!spec.models||spec.models.includes(draft.ttsModel)))
      const expressionControls=()=>h('section',{className:'va-expression-control','aria-label':'助手语音表达'},
        h('div',{className:'va-expression-toolbar'},check('让助手自动控制语气','ttsDynamicExpression',busy||!canDynamic),h(Button,{onClick:()=>navigateSettings('conversation')},'编辑人设')),
        h('p',{className:'va-note'},canDynamic?'根据人设和当前对话调整每次播报；不会改变默认语速与音量。':!state?.speechExpression?.available?'当前宿主尚未接入动态表达。':!draft.ttsModel||!draft.ttsVoice?'请先选择模型和音色。':'当前模型尚无已核验的动态表达参数。'),
        !draft.ttsDynamicExpression&&(draft.ttsContextText||draft.ttsEmotion)&&h('div',{className:'va-help'},h('p',null,'已保留之前的固定语气：'+[draft.ttsContextText,draft.ttsEmotion].filter(Boolean).join(' · ')),h(Button,{onClick:()=>{edit('ttsContextText','');edit('ttsEmotion','')}},'恢复模型默认语气')))
      const chip=(spec,isVector=false)=>{
        const available=!isVector&&supported(spec),status=available?(canDynamic&&draft.ttsDynamicExpression?'available':'metadata'):'unavailable'
        const statusLabel=isVector?'接口未声明':available?(waitingReason|| (draft.ttsDynamicExpression?'可自动调用':'自动调用关闭')):'当前不可用'
        const help=speechCapabilityHelp(providerId('tts'),spec,catalog)
        return h('div',{key:spec.key,className:'va-cap-item',...(!isVector?{'data-agent-capability':spec.expressionField||spec.key}:{}),'data-status':status},
          h(CapabilityChip,{help,status,statusLabel,reason:isVector?'':available?waitingReason:reason(spec),selection,emotions:['emotion','intensity'].includes(spec.expressionField)?voice?.emotions:[]}))
      }
      if(summaryOnly)return h('section',{className:'va-expression-card va-tts-capabilities','aria-label':'所选模型的 Agent 能力'},
        h('div',{className:'va-tts-card-heading'},h('h3',null,'语气与能力'),h('span',{className:'va-expression-state'},canDynamic&&draft.ttsDynamicExpression?'自动表达已开启':'使用默认表达')),
        expressionControls(),
        h('div',{className:'va-cap-heading'},h('h3',null,'支持 Agent 使用的能力'),h('small',null,'点选查看说明')),
        !model?.supported&&h('p',{className:'va-help'},draft.ttsModel?'尚未核验该模型，不向 Agent 开放扩展表达参数。':'选择模型后显示它可供 Agent 使用的能力。'),
        h('div',{className:'va-cap-grid'},agentFields.toSorted((a,b)=>Number(supported(b))-Number(supported(a))).map(spec=>chip(spec)),!agentFields.some(spec=>spec.type==='vector')&&chip({key:'vector',label:'情绪向量'},true)),
        model?.supported&&h('details',{className:'va-cap-io'},h('summary',null,'输入与输出能力'),
          h('div',{className:'va-cap-columns'},
            h('div',{className:'va-cap-group'},h('h4',null,'支持输入'),h('div',{className:'va-cap-tags'},inputTags.map(item=>h('span',{key:item.label,className:'va-cap-badge','data-status':!item.models||item.models.includes(draft.ttsModel)?'available':'unavailable'},item.label+(!item.models||item.models.includes(draft.ttsModel)?'':' · 当前模型不支持'))))),
            h('div',{className:'va-cap-group'},h('h4',null,'支持输出'),h('div',{className:'va-cap-tags'},outputTags.map(item=>h('span',{key:item.label,className:'va-cap-badge','data-status':item.status},item.label+(item.status==='metadata'?' · 尚未用于字幕':item.status==='unavailable'?' · 尚未接入':'')))))))
      )
      return h(React.Fragment,null,
        primary.length>0&&h('details',{className:'va-preferences'},h('summary',null,'播放偏好 · 语速与音量'),h('div',{className:'va-basic-grid'},primary.map(parameterControl))),
        h('details',{className:'va-cap-inventory'},h('summary',null,'查看全部能力与参数归属 · '+(catalog.parameters||[]).length+' 项'),h('p',{className:'va-note'},'供应商能力与实际可用范围随模型、版本和音色变化。'),h('div',{className:'va-cap-table'},h('table',null,h('thead',null,h('tr',null,h('th',null,'功能'),h('th',null,'由谁决定'),h('th',null,'当前状态'))),h('tbody',null,(catalog.parameters||[]).map(spec=>h('tr',{key:spec.key},h('td',null,spec.label,spec.note&&h('small',null,spec.note)),h('td',null,spec.owner==='agent'?'Agent 本次播报':spec.owner==='system'?'工具集成':spec.expressionField?'用户基准 / Agent 临时调整':'用户设置'),h('td',null,spec.owner==='agent'?(supported(spec)?waitingReason?'接口支持 · '+waitingReason:'支持 Agent 使用':reason(spec)):spec.owner==='system'?(enabledParameter({...spec,enabledWhen:undefined})?spec.integration==='timed-captions'?'工具自动请求 · 跟随实际播放':'API 支持 · 尚未用于自动控制或字幕':disabledReason(spec)):enabledParameter(spec)?'支持':disabledReason(spec))))))),h('a',{href:catalog.docs,target:'_blank',rel:'noreferrer'},'官方能力文档')),
        (catalog.parameters||[]).some(spec=>spec.owner==='user'&&!['ttsVariant','ttsSpeed','ttsSpeechRate','ttsLoudnessRate'].includes(spec.key))&&h('details',{className:'va-advanced-preferences'},h('summary',null,'更多播放设置'),rawProviderParameters('tts')))
    }
    const providerParameters=kind=>kind==='tts'?ttsCapabilities():rawProviderParameters(kind)
    const chooseSpeechSelection=async(kind,patch)=>{
      setMessage('')
      try{if(state.settingsDraft){await previewSelection(patch);return}validateSpeechDraft(kind);const dirty=dirtyKind(kind);if(Object.keys(dirty).length)await command({action:'settings',patch:dirty})
        const result=await command({action:'settings',patch})
        setDraft(current=>({...current,...Object.fromEntries(Object.entries(result.settings).filter(([key])=>key.startsWith(kind)))}));setDraftBase(result.settings)
      }catch{}
    }
    const speechModel=kind=>{
      const catalog=speechCatalog(kind);if(!catalog||manual[kind])return modelSelect(kind)
      const model=catalog.models.find(item=>item.id===draft[kind+'Model'])
      return h('div',{className:'va-model-grid'},h('label',{style:label},'模型',h('select',{value:draft[kind+'Model'],disabled:busy,'aria-label':kind+' 模型',onChange:event=>void chooseSpeechSelection(kind,{[kind+'Model']:event.target.value,...(kind==='tts'?{ttsBilling:'characters'}:{})})},h('option',{value:''},'选择模型'),catalog.models.map(item=>h('option',{key:item.id,value:item.id,disabled:!item.supported},item.label+(item.supported?'':' · 尚未接入'))))),
        kind==='asr'&&catalog.modes?.length>1&&h('label',{style:label},'识别模式',h('select',{value:draft.asrRecognitionMode||'realtime',disabled:busy,'aria-label':'识别模式',onChange:event=>void chooseSpeechSelection(kind,{asrRecognitionMode:event.target.value})},catalog.modes.map(item=>h('option',{key:item.id,value:item.id},item.label)))),
        kind==='asr'&&(catalog.billing&&(kind==='tts'&&catalog.billing.length===1?h('span',{className:'va-fixed-resource'},'计费：'+catalog.billing[0].label):h('label',{style:label},'计费资源',h('select',{value:draft[kind+'Billing']||(kind==='asr'?'duration':'characters'),disabled:busy,'aria-label':kind+' 计费资源',onChange:event=>void chooseSpeechSelection(kind,{[kind+'Billing']:event.target.value})},catalog.billing.map(item=>h('option',{key:item.id,value:item.id,disabled:!model?.resources?.[item.id]},item.label)))))),
        kind==='asr'&&h(Button,{onClick:()=>setManual(current=>({...current,[kind]:true}))},'填写其他模型 ID'),kind==='asr'&&h('p',null,catalog.modes.find(item=>item.id===(draft.asrRecognitionMode||'realtime'))?.note),
        h('details',null,h('summary',null,kind==='tts'?'其他模型与接口能力':'能力与接入状态'),kind==='tts'&&(catalog.billing&&(kind==='tts'&&catalog.billing.length===1?h('span',{className:'va-fixed-resource'},'计费：'+catalog.billing[0].label):h('label',{style:label},'计费资源',h('select',{value:draft[kind+'Billing']||(kind==='asr'?'duration':'characters'),disabled:busy,'aria-label':kind+' 计费资源',onChange:event=>void chooseSpeechSelection(kind,{[kind+'Billing']:event.target.value})},catalog.billing.map(item=>h('option',{key:item.id,value:item.id,disabled:!model?.resources?.[item.id]},item.label)))))),kind==='tts'&&h(Button,{onClick:()=>setManual(current=>({...current,[kind]:true}))},'填写其他模型 ID'),model?.note&&h('p',null,model.note),h('p',null,catalog.capabilities.join(' · ')),catalog.models.filter(item=>!item.supported).map(item=>h('p',{key:item.id},item.label+'：'+item.note)),kind==='tts'&&catalog.modes.filter(item=>!item.supported).map(item=>h('p',{key:item.id},item.label+'：'+item.note))))
    }
    const voicePicker=()=>{
      const catalog=speechCatalog('tts');if(!catalog||manualVoice||draft.ttsModel?.startsWith('seed-icl'))return h('div',null,field('音色 ID','ttsVoice'),catalog&&!draft.ttsModel?.startsWith('seed-icl')&&h(Button,{onClick:()=>setManualVoice(false)},'从音色列表选择'))
      const favorites=JSON.parse(draft.voiceFavorites||'[]'),voiceKey=id=>providerId('tts')+':'+draft.ttsModel+':'+id
      const voices=catalog.voices.filter(item=>item.model===draft.ttsModel),needle=voiceSearch.toLowerCase(),filtered=voices.filter(item=>(!favoritesOnly||favorites.includes(voiceKey(item.id)))&&(!expressiveOnly||item.instruction||item.emotions.length)&&[item.id,item.label,item.languages].some(value=>value.toLowerCase().includes(needle))),selected=voices.find(item=>item.id===draft.ttsVoice)
      return h('div',{className:'va-voice-picker'},h('label',{style:label},'音色',h('select',{value:draft.ttsVoice||'','aria-label':'音色',onChange:event=>{edit('ttsVoice',event.target.value);edit('ttsEmotion','')}},h('option',{value:''},'选择音色'),draft.ttsVoice&&!filtered.some(item=>item.id===draft.ttsVoice)&&h('option',{value:draft.ttsVoice},selected?.label||draft.ttsVoice),filtered.map(item=>h('option',{key:item.id,value:item.id,disabled:!item.bidirectional},item.label+(item.bidirectional?'':' · 仅单向流'))))),h('small',null,selected?.languages||'选择音色后可以试听'),h('details',{className:'va-voice-filters'},h('summary',null,'搜索、收藏与专属音色'),h('div',{style:row},h('label',null,h('input',{type:'checkbox',checked:favoritesOnly,onChange:event=>setFavoritesOnly(event.target.checked)}),' 只看收藏'),h('label',null,h('input',{type:'checkbox',checked:expressiveOnly,onChange:event=>setExpressiveOnly(event.target.checked)}),' 支持风格或情绪')),h('label',{style:label},'搜索音色',h(Input,{value:voiceSearch,'aria-label':'搜索音色',placeholder:'名称、语言或音色 ID',onChange:event=>setVoiceSearch(event.target.value)})),h('small',null,'匹配 '+filtered.length+' / '+voices.length+' 个音色'),selected&&h(Button,{onClick:()=>{const id=voiceKey(selected.id);edit('voiceFavorites',JSON.stringify(favorites.includes(id)?favorites.filter(value=>value!==id):[...favorites.slice(-99),id]))}},favorites.includes(voiceKey(selected.id))?'取消收藏':'收藏当前音色'),h(Button,{onClick:()=>setManualVoice(true)},'填写专属音色 ID')))
    }
    const connectionDetails=kind=>h('details',{className:'va-advanced'},h('summary',null,'高级连接设置'),h('div',{style:{marginTop:16}},field('接口地址',kind+'Endpoint'),providerId(kind)==='volcengine'&&field('资源 ID',kind+'ResourceId')))
    const saveSettings=async(close=false)=>{try{await commitDraft();setMessage(preview?'示例设置已保存，仅用于预览。':'设置已保存。');if(close)closeSettings()}catch{setClosePrompt(false)}}
    const sourceLinks=values=>{
      const safe=(values||[]).filter(item=>{try{const url=new URL(item.url);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password}catch{return false}});
      return safe.length>0&&h('section',{'aria-label':'搜索来源',style:{marginTop:12,whiteSpace:'normal'}},h('strong',null,'来源'),h('ol',{style:{paddingLeft:24,margin:'6px 0'}},safe.map(item=>h('li',{key:item.url},h('a',{href:item.url,target:'_blank',rel:'noreferrer',style:{color:'var(--va-accent,#65cdb8)'}},item.title||new URL(item.url).hostname+' ↗')))))
    }
    const searchLabels={disabled:'联网搜索已关闭',unsupported:'当前接口未声明搜索能力，请选择独立搜索服务',untested:'尚未测试',searching:'正在搜索…',completed:'已返回真实搜索结果',failed:'搜索失败'}
    const searchSettings=state?.capabilities?.webSearch&&h('div',{hidden:settingsTab!=='search',style:{display:settingsTab==='search'?'grid':'none',gap:20,alignItems:'start',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,340px),1fr))'}},
      h('fieldset',null,h('legend',null,'联网搜索'),check('允许助手联网搜索','webSearchEnabled'),h('label',{style:label},'搜索服务',h('select',{'aria-label':'搜索服务',value:draft.webSearchProvider,onChange:event=>{edit('webSearchProvider',event.target.value);setKeys(current=>({...current,search:''}))}},(state.webSearch?.providers||[]).map(item=>h('option',{key:item.id,value:item.id},item.label)))),
        h('p',{className:'va-help'},state.webSearch?.providers?.find(item=>item.id===draft.webSearchProvider)?.hint),
        draft.webSearchProvider==='tavily'&&credential('search'),select('每次最多返回来源数','webSearchMaxResults',Array.from({length:10},(_,index)=>[index+1,(index+1)+' 条'])),
        h('p',{className:'va-note'},'只在需要查资料时搜索。搜索问题会发送给所选服务。')),
      h('section',{className:'va-check-card','aria-label':'搜索测试'},h('h3',null,'已保存的搜索连接'),h('p',null,state.webSearch?.label+(state.webSearch?.model?' · '+state.webSearch.model:'')),
        h('p',{role:'status'},searchLabels[state.webSearch?.status]||'尚未测试'),state.webSearch?.error&&h('p',{role:'alert'},errors[state.webSearch.error]||state.webSearch.error),
        state.webSearch?.completedAt&&h('p',null,'最近搜索 '+new Date(state.webSearch.completedAt).toLocaleString()),
        h(Button,{disabled:preview||busy||state.webSearch?.status==='searching'||state.activity?.pending>0||!draft.webSearchEnabled,onClick:()=>void commitDraft().then(()=>command({action:'web-search-test'},'搜索已完成，可查看来源。')).catch(()=>{})},busy||state.webSearch?.status==='searching'?'正在搜索…':dirty?'保存并测试搜索':'测试搜索'),
        h('p',{className:'va-note'},'搜索“Rokid AIUI 官方开发文档”，会使用当前服务的额度。'),sourceLinks(state.webSearch?.sources)))
    const messageBody=item=>{
      const progress=item.role==='assistant'&&!item.notice?state?.speechProgress?.find(value=>value.responseId===item.id):null
      if(!progress?.timingMode)return h('p',null,item.notice?(errors[item.text]||item.text):item.text)
      const end=Math.min(item.text.length,Math.max(0,progress.spokenEnd||0))
      return h('div',{className:'va-timed-message'},h('p',null,h('span',{className:'va-sr-only'},item.text),h('span',{className:'va-spoken','aria-hidden':true},item.text.slice(0,end)),h('span',{className:'va-unspoken','aria-hidden':true},item.text.slice(end))))
    }
    const avatar=(person,kind)=>h(MessageAvatar,{...person,kind,resolveUrl:adapter.resolveAvatarUrl})
    const renderMessage=(item,index)=>{
      const generating=state?.activity?.responseId===item.id&&live.working
      if(item.role==='assistant'&&!item.notice&&!item.text?.trim()&&!generating&&!item.canvas?.document)return null
      const kind=item.notice?'system':item.role==='user'?'user':'assistant',person=participants[kind]
      const time=messageTimeLabel(item,messages[index-1])
      return h(React.Fragment,{key:item.id},time&&h('div',{className:'va-message-time'},h('time',{dateTime:item.createdAt},time)),
        h('article',{className:'va-message','data-message-id':item.id,'data-role':item.role,'data-notice':item.notice||undefined,role:item.notice?'alert':undefined},
          avatar(person,kind),h('div',{className:'va-message-main'},
            h('div',{className:'va-message-heading'},h('div',{className:'va-message-author'},h('strong',{title:person.name},person.name),item.source==='speech'&&h('span',{className:'va-message-source'},'语音')),
              item.hasDetails&&h(Button,{className:'va-message-details',title:'查看消息详情','aria-label':item.role==='user'?'查看语音识别详情':'查看执行与语音详情',onClick:()=>openDetails(item)},'⋯')),
            h('div',{className:'va-message-bubble'},!item.text?.trim()&&generating?h('span',{className:'va-typing',role:'status','aria-label':'正在回复'},h('i'),h('i'),h('i')):messageBody(item),
              state?.activity?.responseId===item.id&&state.activity.tool&&h('div',{className:'va-current-tool',role:'status','aria-busy':true},h('span',{className:'va-tool-spinner','aria-hidden':true}),h('span',null,'正在调用 · '+(state.activity.tool.operation||({web_search:'联网搜索',rabi_search:'查找接口',rabi_describe:'读取接口说明'}[state.activity.tool.name]||state.activity.tool.name)))),
              item.canvas?.document&&!(state?.canvas?.visible&&state.canvas.persistent&&state.canvas.responseId===item.id)&&h(VisualCanvas,{value:item.canvas}),
              sourceLinks(item.sources),item.status==='interrupted'&&h('small',{className:'va-note'},'上次未完成 · 没有自动重发')))))
    }
    const setupGaps=assistantSetupGaps(state)
    const serviceTests=state?.capabilities?.serviceTests&&h('section',{className:'va-checks','aria-label':'连接与测试状态'},
      h('div',{className:'va-check-heading'},h('div',null,h('h2',null,'连接与测试'),
        h('p',null,testRunning?'正在测试'+(serviceRows.find(item=>item.id===testJob.current)?.title||'当前服务')+'，已完成 '+testJob.completed+' / '+testJob.total+' 项':checksPassed?'上次示例流程已通过。实际听感请单独确认。':'查看实际测试结果，确认每一项是否可用。')),
        h(Button,{disabled:busy||testRunning||connectionError||setupGaps.length>0||state.voice.phase==='running',onClick:()=>invoke({action:'run-checks',id:'all'})},testRunning?'正在测试…':'运行完整测试')),
      testRunning&&h('progress',{value:testJob.completed,max:testJob.total,'aria-label':'测试进度'}),
      !showChecks&&h('div',{className:'va-check-summary'},serviceRows.map(item=>h('span',{key:item.id,'data-status':item.status},item.title+' · '+item.label))),
      h(Button,{className:'va-check-toggle','aria-expanded':showChecks,disabled:testRunning,onClick:()=>setChecksExpanded(!showChecks)},showChecks?'收起测试详情':'查看测试详情'),
      showChecks&&h('div',{className:'va-check-grid'},serviceRows.map(item=>h('article',{key:item.id,className:'va-check-card','data-status':item.status},
        h('div',{className:'va-check-title'},h('h3',null,item.title),h('span',{className:'va-check-badge',role:item.status==='running'?'status':undefined},item.label)),
        h('p',{className:'va-check-selection'},item.selection),
        h('p',{className:'va-check-detail',role:item.status==='failed'?'alert':undefined},errors[item.detail]||item.detail),
        item.id==='tts'&&['passed','warning'].includes(item.status)&&h('div',{className:'va-check-actions'},h(Button,{disabled:testRunning||busy,onClick:()=>invoke({action:'confirm-playback',heard:true})},'我听到了'),h(Button,{disabled:testRunning||busy,onClick:()=>invoke({action:'confirm-playback',heard:false})},'没有声音')),
        item.checkedAt&&item.status!=='running'&&h('time',{dateTime:item.checkedAt},'最近测试 '+new Date(item.checkedAt).toLocaleString()),
        h('div',{className:'va-check-actions'},item.id!=='voice'&&h(Button,{disabled:busy||testRunning||connectionError||item.status==='missing'||state.voice.phase==='running',onClick:()=>invoke({action:'run-checks',id:item.id})},item.status==='running'?'测试中…':item.action),item.section&&h(Button,{'aria-label':'配置'+item.title,disabled:busy||testRunning,onClick:()=>openSettings(item.section)},'配置'))))),
      state.voice.phase==='running'&&h('p',{className:'va-check-note'},'请先在首页结束语音，再运行连接测试。'),
      h('p',{className:'va-check-note'},setupGaps.length?'请先'+setupGaps.map(item=>item.label).join('、')+'。':'完整测试会发送固定测试文字、识别示例音频并播放回复，同时在本机录音 3 秒检测输入。'))
    const settingsBody=h('div',{className:'va-settings'},
      preview&&h('div',{className:'va-preview va-preview-settings',role:'status'},h('strong',null,'仅预览设置 · 不能实际对话'),h('span',null,'模型是示例数据，不会连接 WorkBuddy 或其他服务。请勿填写真实密钥。')),
      h('nav',{className:'va-nav','aria-label':'设置分类'},[['conversation','对话'],...(state?.capabilities?.webSearch?[["search","联网搜索"]]:[]),['asr','语音识别'],['tts','语音播报'],['devices','设备'],['appearance','外观'],['setup','连接与测试']].map(([id,name])=>h(Button,{key:id,'aria-pressed':settingsTab==='speech'?speechKind===id:settingsTab===id,onClick:()=>navigateSettings(id)},name))),
      h('fieldset',{className:'va-pages',disabled:busy,ref:pages},HostSettings&&h(HostSettings,{state,settingsTab,speechKind,command:invoke,dirty}),
      h('div',{hidden:settingsTab!=='setup'},state?.settings?.onboardingComplete===false&&h('h3',null,'开始使用语音助手'),state?.settings?.onboardingComplete===false&&h('p',null,'选择对话模型，配置识别和音色后，即可开始。'),h('div',{className:'va-setup-links'},[['conversation','对话模型'],['asr','语音识别'],['tts','语音播报'],['devices','音频设备']].map(([id,name])=>h(Button,{key:id,onClick:()=>navigateSettings(id)},name))),serviceTests||h('p',null,'在语音播报和设备设置中可以试听、测试麦克风。')),
      h('div',{hidden:settingsTab!=='conversation',className:'va-conversation-settings',style:{display:settingsTab==='conversation'?'grid':'none',gap:20}},
      h('div',{className:'va-model-settings'},(state?.capabilities?.modelConfiguration||state?.capabilities?.host==='standalone')
        ?h('fieldset',null,h('legend',null,'对话模型'),providerSelect('llm'),h('p',{className:'va-help'},state.capabilities?.modelProviders?.find(item=>item.id===providerId('llm'))?.hint||'填写连接信息，刷新模型列表，选择模型后保存。'),providerId('llm')!=='workbuddy-cli'&&credential('llm'),modelSelect('llm'),providerId('llm')!=='workbuddy-cli'&&connectionDetails('llm'))
        :h('fieldset',null,h('legend',null,'DSH 对话模型'),!hostModels.length&&h('p',{role:'status',className:'va-help'},state?.capabilities?.hostModelsError?'未能读取 DSH 模型目录，请点击“刷新模型”重试。':'尚未读到可用模型。请先在 DSH 的模型提供商中完成登录或连接，再回这里刷新。'),h('label',{style:label},'提供商',h('select',{'aria-label':'宿主提供商',value:selectedHost,disabled:busy||!hostGroups.length,onChange:event=>setHostProvider(event.target.value)},hostGroups.map(([id,name])=>h('option',{key:id,value:id},name)))),h('label',{style:label},'模型',h('select',{'aria-label':'宿主模型',value:state?.selectedModel?.provider===selectedHost?state.selectedModel.model:'',disabled:busy||!hostModels.length,onChange:event=>invoke({action:'select-model',provider:selectedHost,model:event.target.value},'模型已切换。')},h('option',{value:'',disabled:true},'选择模型'),hostModels.filter(item=>item.provider===selectedHost).map(item=>h('option',{key:item.model,value:item.model},item.label)))),h(Button,{disabled:busy,onClick:()=>invoke({action:'refresh-models'})},'刷新模型'),h('p',null,'这里自动读取 DSH 已配置的提供商和模型，无需重复填写密钥。选择模型立即生效。'),state?.capabilities?.presets&&select('助手预设','agentPreset',[['','使用默认预设'],...state.capabilities.presets.map(item=>[item.id,item.label])])),
      state?.capabilities?.contextManagement&&h('section',{className:'va-context-settings','aria-label':'上下文与记录'},h('h3',null,'上下文与记录'),h('p',null,state.context?.storage==='native'?'由宿主原生会话保存；刷新和重启后继续使用同一段对话。':'聊天记录和模型上下文加密保存在本机，刷新和重启后继续使用。'),h('div',{className:'va-context-stats'},h('span',null,'聊天记录：'+(state.context?.messageCount||0)+' 条'),h('span',null,'模型上下文：'+(state.context?.contextMessageCount??'由宿主管理')+(state.context?.contextMessageCount===undefined?'':' 条'))),state.context?.maxContextMessages&&h('p',{className:'va-note'},'模型使用最近 '+state.context.maxContextMessages+' 条、最多 '+state.context.maxContextCharacters.toLocaleString()+' 字符；较早聊天记录仍可查看。')),
      ),h('section',{className:'va-identity-settings'},h('h3',null,'助手身份'),field('助手名称','assistantName'),h('label',{style:label},'人设',h('textarea',{rows:4,readOnly:Boolean(state?.hostSettings?.personaId),value:draft.persona??'',onChange:event=>edit('persona',event.target.value),'aria-label':'人设'})),state?.capabilities?.host==='dsh'&&check('管理全部工作区的对话','manageAllWorkspaces'))),
      searchSettings,
      h('div',{hidden:settingsTab!=='speech',style:{display:settingsTab==='speech'?'grid':'none',gap:20}},
      h('fieldset',{hidden:speechKind!=='asr'||state?.hostSettings?.asrSource==='host',className:'va-service'},h('legend',null,'语音识别'),
        h('div',{className:'va-speech-layout va-asr-layout'},h('section',{className:'va-connection-settings','aria-label':'识别连接'},h('h3',null,'识别连接'),
          h('div',{className:'va-basic-grid'},providerSelect('asr'),draft.asrMode==='local-whisper'?h('label',{style:label},'模型',h(Input,{readOnly:true,value:'Whisper base · CPU / int8'})):draft.asrMode!=='native'&&speechModel('asr')),
          !['native','local-whisper'].includes(draft.asrMode)&&h(React.Fragment,null,credential('asr'),connectionDetails('asr'))),
          !['native','local-whisper'].includes(draft.asrMode)&&h('section',{className:'va-recognition-settings','aria-label':'识别能力与偏好'},asrCapabilities()))),
      h('fieldset',{hidden:speechKind!=='tts'||state?.hostSettings?.ttsSource==='host',className:'va-service'},h('legend',null,'语音播报'),
        h('div',{className:'va-speech-layout va-tts-layout'},
          h('section',{className:'va-connection-settings va-tts-selection','aria-label':'播报连接'},h('div',{className:'va-tts-card-heading'},h('h3',null,'选择声音')),
            h('div',{className:'va-basic-grid'},providerSelect('tts'),speechModel('tts')),
            h('section',{className:'va-voice-settings','aria-label':'声音选择'},voicePicker(),
              h('div',{className:'va-voice-actions'},h(Button,{className:'va-primary',disabled:preview||busy||!draft.ttsVoice,onClick:()=>void saveConnection('tts').then(()=>command({action:'test-playback'},value=>value.message)).catch(()=>{})},dirty?'保存并试听音色':'试听音色'),speechCatalog('tts')&&h('a',{href:speechCatalog('tts').voiceDocs,target:'_blank',rel:'noreferrer'},'官方音色目录 ↗'))),
            h('div',{className:'va-connection-tools'},credential('tts'),connectionDetails('tts'))),
          ttsCapabilities(true),
          h('div',{className:'va-expression-settings va-tts-preferences'},providerParameters('tts'))))),
      h('div',{hidden:settingsTab!=='devices'},h('fieldset',null,h('legend',null,'音频设备'),
        h(Button,{disabled:busy,onClick:()=>{void command({action:'devices'}).then(value=>setDevices(value)).catch(()=>{})}},'刷新设备'),
        select('麦克风','inputDeviceId',[['','系统默认'],...devices.filter(d=>d.kind==='audioinput').map(d=>[d.id,d.label||'未命名输入设备'])]),
        select('扬声器','outputDeviceId',[['','系统默认'],...devices.filter(d=>d.kind==='audiooutput').map(d=>[d.id,d.label||'未命名输出设备'])]),
        h('div',{style:row},h(Button,{disabled:preview||busy,onClick:()=>void saveConnection().then(()=>command({action:'test-microphone'},result=>result.message)).catch(()=>{})},dirty?'保存并测试麦克风 · 3 秒':'测试麦克风 · 3 秒'))),h('details',null,h('summary',null,'高级设备设置'),field('Electron 可执行文件（留空自动发现）','electronExecutable'),field('识别灵敏度','silenceThreshold','number'),field('句尾等待（毫秒）','silenceDurationMs','number'))),
      h('div',{hidden:settingsTab!=='appearance',style:{display:settingsTab==='appearance'?'grid':'none',gap:20}},
      h('fieldset',null,h('legend',null,'桌面字幕'),check('显示独立字幕','captionsEnabled'),
        h('p',{className:'va-note'},'在桌面置顶显示助手回复，无需先开启麦克风。勾选后保存设置即可显示。'),
        h('p',{role:'status'},state?.caption?.status==='opening'?'正在打开桌面字幕…':state?.caption?.status==='visible'?'桌面字幕窗口已打开':state?.caption?.status==='failed'?'桌面字幕打开失败，请重试测试或检查设备设置。':'桌面字幕未开启'),
        h(Button,{disabled:preview||busy||!draft.captionsEnabled||!state?.caption,onClick:()=>void commitDraft().then(()=>command({action:'test-captions'},'测试字幕已发送到桌面，3 秒后恢复。')).catch(()=>{})},dirty?'保存并测试桌面字幕':'测试桌面字幕'),
        h('small',{className:'va-note'},'显示 3 秒测试文字，不调用模型或麦克风。'),check('锁定位置并隐藏外框','captionLocked'),h('p',{className:'va-note'},'未锁定时，文字和空白处均可拖动，按钮保留点击。锁定后只显示字幕，可在这里或托盘菜单解锁。'),
        select('皮肤','captionSkin',[['dark','深色'],['light','浅色']]),field('字号（16–48）','captionFontSize','number'),field('背景透明度（0.15–1）','captionOpacity','number'),
        select('默认位置','captionPosition',[['bottom','底部'],['top','顶部']]),h(Button,{onClick:()=>setDraft(current=>({...current,captionHasBounds:false,captionPosition:'bottom',captionFontSize:24,captionOpacity:.85,captionLocked:false}))},'恢复字幕样式与位置')),
      h('fieldset',null,h('legend',null,'桌宠'),check('联动桌宠','petEnabled',!state?.pet.available),check('显示气泡','petBubbles',!state?.pet.available),check('播放动画','petAnimation',!state?.pet.available),
        state?.pet.available&&select('桌宠','petId',[['','选择桌宠'],...(state.pet.pets||[]).map(pet=>[pet.id,pet.name])]),
        state?.pet.version&&h('p',null,'已加载版本：'+state.pet.version),
        state?.pet.error&&h('p',{role:'alert'},state.pet.error==='PET_SELECT_REQUIRED'?'请选择要联动的桌宠。':'桌宠展示暂不可用，语音和任务仍可继续。'),
        !state?.pet.available&&h('p',null,'当前宿主未连接桌宠。')))),
      h('div',{className:'va-settings-footer'},state?.settings?.onboardingComplete===false&&h(Button,{disabled:busy,onClick:requestClose},'完成引导'),h('p',{role:'status'},closePrompt?'还有未保存的更改。':message||(dirty?'有未保存的更改':'设置已同步')),
        closePrompt?h('div',{style:row},h(Button,{disabled:busy,onClick:()=>setClosePrompt(false)},'继续编辑'),h(Button,{disabled:busy,onClick:closeSettings},'放弃更改'),h(Button,{className:'va-primary',disabled:busy,onClick:()=>void saveSettings(true)},'保存并关闭')):h(Button,{className:'va-primary',disabled:busy||!dirty,onClick:()=>void saveSettings()},busy?'处理中…':'保存设置')))
    if(detailId)return h('section',{style:layout,className:'va-panel va-full-page'},h('style',null,assistantPanelStyles),h(MessageDetails,{key:detailId,data:detailData,loading:detailLoading,error:detailError,catalogs:state?.speechCatalogs,onBack:()=>setDetailId(null),onRetry:()=>void readDetails(detailId)}))
    if(editing&&settingsPresentation==='page'&&Modal)return h('section',{style:layout,className:'va-panel va-full-page'},h('style',null,assistantPanelStyles),h(Modal,{open:true,title:({conversation:'对话设置',speech:speechKind==='asr'?'语音识别设置':'语音播报设置',devices:'音频设备',appearance:'字幕与外观',search:'联网搜索设置',setup:'连接与测试'})[settingsTab]||'助手设置',onClose:requestClose},settingsBody))
    return h('section',{style:layout,className:'va-panel'+(state?.canvas?.visible&&state.canvas.persistent?' va-has-canvas':''),'aria-label':'语音助手'},h('style',null,assistantPanelStyles),
      preview&&h('div',{className:'va-preview'},h('strong',null,'这是设置预览，不能实际对话'),h('p',null,'这里可以查看设置操作。模型列表是示例，不会连接服务、录音或播放声音。'),state?.capabilities?.assistantUrl&&/^http:\/\/127\.0\.0\.1:\d+\/\?voice-assistant=1$/.test(state.capabilities.assistantUrl)&&h('a',{href:state.capabilities.assistantUrl},'打开 DSH 语音助手 →')),
      h('div',{className:'va-live-header'},h('div',null,state?.settings?.assistantName&&state.settings.assistantName!=='语音助手'&&h('strong',null,state.settings.assistantName),h('span',{className:'va-status','data-running':!connectionError&&live.listening,role:'status'},live.title)),h('div',{style:row},voiceSwitch,state?.capabilities?.contextManagement&&h(Button,{disabled:busy||connectionError||state.context?.busy||testRunning,onClick:()=>setClearPrompt(true)},'清除上下文'),h(Button,{disabled:!state||connectionError,onClick:openSettings},'设置'))),
      connectionError&&h(Button,{disabled:busy,onClick:()=>void refresh().catch(report)},'重新连接'),
      state&&h('div',{className:'va-duplex-status','aria-label':'并行语音状态',role:'status'},h('span',{'data-active':live.listening},live.captureLabel),h('span',{'data-active':live.working},live.generationLabel),h('span',{'data-active':live.playing},live.playbackLabel)),
      h('p',{className:'va-live-hint'},testRunning?'连接测试正在运行，可在设置中查看进度。':!connectionError&&!voiceDisabled&&live.action==='start'&&setupGaps.length?'先在设置中完成语音配置。':live.detail),
      message&&!editing&&h('p',{role:'status'},message),[...new Set([state?.voice?.error,state?.error].filter(Boolean))].map(code=>h('p',{key:code,role:'alert'},errors[code]||code)),
      clearPrompt&&h('section',{className:'va-context-confirm',role:'alertdialog','aria-label':'清除上下文确认'},h('h3',null,'清除这段对话？'),h('p',null,state.context?.storage==='native'?'将开启新的宿主会话并结束语音。原记录由宿主管理，密钥和人设保持不变。':'将清空当前聊天记录和模型上下文，并结束语音。密钥和人设保持不变。'),h('div',{style:row},h(Button,{disabled:busy,onClick:()=>setClearPrompt(false)},'保留对话'),h(Button,{disabled:busy||state.context?.busy,onClick:()=>void clearContext()},'确认清除'))),
      state?.context?.error&&h('section',{className:'va-context-error',role:'alert'},h('strong',null,'对话尚未保存到本机'),h('p',null,state.context.error==='ASSISTANT_CONTEXT_STORAGE_FULL'?'请释放对话所在磁盘的空间，再重试保存。成功前请保持助手运行。':'请重试保存；成功前不要退出助手。'),h(Button,{disabled:busy,onClick:()=>invoke({action:'retry-context-save'},'对话已保存。')},'重试保存')),
      state?.context?.interruptedCount>0&&h('p',{className:'va-note'},'上次有 '+state.context.interruptedCount+' 条消息未完成，已保留记录，没有自动重发。'),
      h('div',{'aria-label':'对话',className:'va-conversation',role:'log','aria-live':'polite','aria-relevant':'additions text',ref:chat,onScroll:()=>{const node=chat.current;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;if(follow.current)setUnseen(false)}},state?.capabilities?.messageHistory&&messages.length>0&&moreHistory!==false&&(moreHistory===true||state.context?.messageCount>messages.length)&&h(Button,{className:'va-history-more',disabled:historyBusy,onClick:()=>void loadHistory()},historyBusy?'正在加载…':'加载更早消息'),!voiceDisabled&&!messages.length&&!live.listening&&!live.working&&h('div',{className:'va-empty'},h('strong',null,preview?'请在实际助手中开始对话':conversationMissing?'先选择一个对话模型':'开始实时语音，直接说话'),h('p',null,preview?'本页只展示设置，语音功能不可用。':conversationMissing?'完成“对话”设置并保存后，即可开启语音。':'可以请助手查资料、处理任务，或画一张图。')),messages.map((item,index)=>renderMessage(item,index)),live.listening&&state?.inputPreview&&!state.inputPreview.final&&h('div',{className:'va-message va-message-live','data-role':'user',role:'status'},avatar(participants.user,'user'),h('div',{className:'va-message-main'},h('div',{className:'va-message-heading'},h('div',{className:'va-message-author'},h('strong',null,participants.user.name),h('span',{className:'va-message-source'},'正在说话'))),h('div',{className:'va-live-input'},h('p',null,state.inputPreview.text||'正在聆听…'))))),
      h('style',null,visualCanvasStyles),state?.canvas?.visible&&state.canvas.persistent&&h(VisualCanvas,{value:state.canvas,pinned:true,onClose:()=>invoke({action:'canvas-close'})}),
      unseen&&h(Button,{className:'va-latest',onClick:()=>{follow.current=true;chat.current.scrollTop=chat.current.scrollHeight;setUnseen(false)}},'回到最新回复'),
      state?.voice.phase==='running'&&state?.asrFeedback==='utterance'&&h('div',{className:'va-waveform','data-active':live.listening},h('span',null,live.listening?(Date.now()-(state.waveform?.updatedAt||0)<1500?'正在收音 · 说完后转写':'等待麦克风数据'):'麦克风已暂停'),h('svg',{viewBox:'0 0 288 56',role:'img','aria-label':live.listening?'真实麦克风音量波形':'麦克风已暂停，波形停止'},Array.from({length:48},(_,i)=>{const fresh=live.listening&&Date.now()-(state.waveform?.updatedAt||0)<1500,value=fresh?(state.waveform?.samples?.[i]||0):0,height=Math.max(1,Math.min(52,Math.sqrt(value)*170));return h('rect',{key:i,x:i*6,y:(56-height)/2,width:3,height,rx:1})}))),
      h('div',{className:'va-actions'},
        h(Button,{className:'va-primary',disabled:preview||busy||testRunning||!state||connectionError||voiceDisabled||state?.voice.phase==='starting',onClick:()=>live.action==='start'&&setupGaps.length?openSettings(setupGaps[0].section):invoke({action:live.action})},preview?'预览不支持语音':live.actionLabel),
        state?.interaction?.outputActive&&h(Button,{disabled:busy,onClick:()=>invoke({action:'interrupt-speech'})},'停止本次播报'),
        h(Button,{disabled:preview||!state||busy||testRunning||connectionError,onClick:()=>invoke({action:'mute',enabled:!state.voice.outputEnabled})},state?.voice.outputEnabled?'播报静音':'恢复播报'),
        state?.voice.phase==='running'&&h(Button,{disabled:busy||testRunning,onClick:()=>invoke({action:'stop'})},'结束语音')),
      pending&&h('p',{role:'status'},'这条消息的受理结果尚未确认。重试会沿用同一请求编号。'),
      state?.capabilities?.textInput===true&&h('div',{className:'va-compose'},h(Input,{ref:composer,value:text,disabled:preview||testRunning||conversationMissing||Boolean(pending),'aria-label':'消息',placeholder:preview?'预览不能发送消息':conversationMissing?'请先配置对话模型':'输入消息，按 Enter 发送',onChange:event=>setText(event.target.value),onKeyDown:event=>{if(event.key==='Enter'&&!event.nativeEvent?.isComposing){event.preventDefault();void send()}}}),
        h(Button,{className:'va-primary',disabled:preview||testRunning||conversationMissing||busy||!state||connectionError||!pending&&!text.trim(),onClick:()=>void send()},pending?'核对并重试':'发送')),
      Modal?h(Modal,{open:editing,title:'助手设置',closeLabel:'关闭',onClose:requestClose},settingsBody):editing&&h('div',null,h(Button,{onClick:requestClose},'关闭设置'),settingsBody))
  }
}
import {createMessageDetailsView} from './message-details.js';
