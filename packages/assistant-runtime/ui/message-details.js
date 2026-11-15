const providers={volcengine:'火山豆包',compatible:'OpenAI / 兼容服务','local-whisper':'本机 Whisper',native:'宿主识别服务'};
const emotions={angry:'生气',happy:'开心',neutral:'平静',sad:'悲伤',surprise:'惊讶'};
const degrees={weak:'轻微',moderate:'中等',strong:'明显'};
const stages={sent:'请求已发送',accepted:'服务已接受',completed:'合成已完成',cancelled:'请求已取消',failed:'请求失败','input-finished':'文字发送完毕'};
const playback={ended:'播放完成',cancelled:'本次播放已打断',error:'播放失败','play-requested':'播放器已启动',synthesizing:'正在合成'};
const labels={speaker:'音色',voice:'音色',model:'模型',format:'音频编码',response_format:'音频编码',sample_rate:'采样率',speech_rate:'实际语速',speed:'实际语速',loudness_rate:'音量调整',emotion:'情绪',emotion_scale:'情绪强度',pitch:'音调',context_texts:'语音风格提示',instructions:'语音风格提示',input:'投递的播报文字',text:'投递的播报文字',disable_markdown_filter:'禁用 Markdown 过滤',disable_emoji_filter:'禁用 Emoji 过滤',max_length_to_filter_parenthesis:'括号内容过滤长度上限'};
const present=value=>value===undefined||value===null||value===''?'未返回':typeof value==='boolean'?(value?'开启':'关闭'):Array.isArray(value)?value.map(present).join('、'):typeof value==='object'?JSON.stringify(value):String(value);
export function speechParameterRows(parameters={},catalog){
 const names={...Object.fromEntries((catalog?.parameters||[]).filter(p=>p.parameter).map(p=>[p.parameter.split('.').at(-1),p.label])),...labels},rows=[];
 const walk=(value,path)=>{
  const key=path.split('.').at(-1);
  if(key==='additions'&&typeof value==='string'){try{walk(JSON.parse(value),path);return}catch{}}
  if(value&&typeof value==='object'&&!Array.isArray(value)){for(const [name,item] of Object.entries(value))walk(item,path?path+'.'+name:name);return}
  let shown=present(value);
  if(key==='speech_rate'&&Number.isFinite(Number(value)))shown=(1+Number(value)/100).toFixed(2)+' 倍（接口值 '+value+'）';
  if(key==='speed')shown=shown+' 倍';
  if(key==='sample_rate')shown=shown+' Hz';
  if(key==='emotion')shown=emotions[value]||shown;
  if(key==='speaker'||key==='voice')shown=catalog?.voices?.find(v=>v.id===value)?.label||shown;
  rows.push({key:path,label:names[key]||key,value:shown});
 };walk(parameters,'');return rows;
}
export function recognitionRows(details){
 const result=details.result||{},extra={...(result.additions||{}),lang:result.additions?.lang??result.additions?.language??result.additions?.lang_code,speaker:result.additions?.speaker??result.additions?.speaker_id},enabled=new Set((details.features||[]).map(f=>f.key));
 const fields=[
  ['asrEnableEmotionDetection','emotion','情绪',v=>emotions[v]||present(v)],
  ['asrEnableEmotionDetection','emotion_degree','情绪程度',v=>degrees[v]||present(v)],
  ['asrEnableEmotionDetection','emotion_score','情绪评分',present],
  ['asrEnableEmotionDetection','emotion_degree_score','程度评分',present],
  ['asrEnableGenderDetection','gender','性别估计',v=>({male:'男性声线',female:'女性声线'}[v]||present(v))],
  ['asrEnableGenderDetection','gender_score','性别评分',present],
  ['asrEnableAgeDetection','age','年龄估计',v=>v!==null&&v!==''&&Number.isFinite(Number(v))?'约 '+Math.round(Number(v))+' 岁':present(v)],
  ['asrEnableSpeakerInfo','speaker','说话人',present],['asrEnableLid','lang','语言/场景',present],
  ['asrShowSpeechRate','speech_rate','语速',v=>present(v)+' token/s'],['asrShowVolume','volume','音量',v=>present(v)+' dB'],
 ];
 const returned=key=>extra[key]!==undefined&&extra[key]!==null&&extra[key]!=='';
 return fields.filter(([flag,key])=>returned(key)||enabled.has(flag)&&!key.endsWith('_score')&&key!=='emotion_degree').map(([flag,key,label,format])=>({key,label,value:!returned(key)?'已请求，接口未返回':key.endsWith('_score')&&Number.isFinite(Number(extra[key]))?Number(extra[key]).toFixed(4):format(extra[key]),returned:returned(key)}));
}

export function createMessageDetailsView(React){
 const h=React.createElement;
 const pairs=rows=>h('dl',{className:'va-detail-pairs'},rows.map(({key,label,value})=>h('div',{key},h('dt',null,label),h('dd',null,value))));
 const table=rows=>h('dl',{className:'va-detail-parameters','aria-label':'本次实际参数'},rows.map(row=>h('div',{key:row.key},h('dt',null,row.label),h('dd',null,row.value))));
 return function MessageDetails({data,loading,error,onBack,onRetry,catalogs}){
  const [selected,setSelected]=React.useState('');
  const isAsr=data?.kind==='asr',requests=data?.requests||[],request=requests.find(r=>r.requestId===selected)||requests.at(-1),catalog=catalogs?.[request?.provider]?.tts;
  const title=isAsr?'语音识别详情':'语音播报详情',status=isAsr?'识别已完成':playback[data?.playback?.status]||stages[request?.stage]||'尚未发送播报请求';
  const rows=isAsr?recognitionRows(data):[],expression=data?.expression||{};
  return h('section',{className:'va-detail-page','aria-label':'消息语音详情'},
   h('header',{className:'va-detail-heading'},h('div',null,h('h2',null,title),data&&h('span',{className:'va-cap-badge'},status)),h('div',null,h('button',{onClick:onRetry,disabled:loading},loading?'正在读取…':'刷新详情'),h('button',{onClick:onBack},'返回对话'))),
   h('div',{className:'va-detail-body'},
    error&&h('p',{role:'alert'},'暂时无法读取这条消息的详情。可重试，较早的消息可能已从本次运行中移除。'),
    !data&&loading&&h('p',{role:'status'},'正在读取本次语音信息…'),
    data&&h(React.Fragment,null,
     h('section',{className:'va-detail-text'},h('h3',null,isAsr?'识别出的文字':'助手回复'),h('p',null,data.message?.text||'文字仍在生成…')),
     h('div',{className:'va-detail-grid'+(isAsr?'':' va-detail-tts')},
      isAsr?h('section',{className:'va-detail-card'},h('h3',null,'本句识别结果'),rows.length?pairs(rows):h('p',null,'本句未返回情绪、性别等附加结果。'),h('p',{className:'va-note'},'这些标签是模型估计，供你核对；接口评分不代表实际准确率。'),
       Number.isFinite(data.result?.start_time)&&Number.isFinite(data.result?.end_time)&&h('p',{className:'va-note'},'分句时间：'+(data.result.start_time/1000).toFixed(2)+'–'+(data.result.end_time/1000).toFixed(2)+' 秒')):
       h('section',{className:'va-detail-card'},h('h3',null,'Agent 本次表达'),Object.keys(expression).length?pairs(Object.entries(expression).map(([key,value])=>({key,label:{style:'语气与风格',emotion:'情绪',intensity:'情绪强度',rate:'临时语速比例',pitch:'临时音调'}[key]||key,value:present(value)}))):h('p',null,'本次未单独指定语气，使用已保存的播放偏好。'),
        !requests.length&&h('p',{className:'va-note'},data.reason||'尚未产生实际播报请求。')),
      isAsr?h('section',{className:'va-detail-card'},h('h3',null,'本句识别配置'),pairs([{key:'provider',label:'提供商',value:providers[data.provider]||data.provider||'未记录'},{key:'model',label:'识别模型',value:data.model||'未记录'},{key:'mode',label:'识别方式',value:{realtime:'实时出字',twopass:'实时出字 · 句尾校正',utterance:'整句录音后识别'}[data.mode]||data.mode||'由服务决定'}]),h('h4',null,'本句启用的功能'),h('div',{className:'va-cap-tags'},(data.features||[]).map(f=>h('span',{key:f.key,className:'va-cap-badge'},f.label)))):
       h('section',{className:'va-detail-card'},h('h3',null,'实际播报请求'),request?h(React.Fragment,null,
        requests.length>1&&h('label',null,'播报片段',h('select',{'aria-label':'播报片段',value:request.requestId,onChange:e=>setSelected(e.target.value)},requests.map((r,i)=>h('option',{key:r.requestId,value:r.requestId},'第 '+((data.requestCount||requests.length)-requests.length+i+1)+' 段')))),
        pairs([{key:'provider',label:'提供商',value:providers[request.provider]||request.provider},{key:'model',label:'播报模型',value:request.model||'由接口决定'},{key:'stage',label:'请求状态',value:request.error?'请求失败':stages[request.stage]||request.stage}]),
        table(speechParameterRows(request.parameters,catalog)),
        request.textSent!==undefined&&h('details',null,h('summary',null,'实际已发送文字 · '+request.textCharacters+' 字符'),h('p',null,request.textSent),request.textTruncated&&h('small',null,'长文本仅保留前 4096 字符。')),
        data.requestCount>requests.length&&h('p',{className:'va-note'},'共 '+data.requestCount+' 段，仅保留最近 '+requests.length+' 段请求详情。')):h('p',null,'未向语音服务提交请求。'))),
     h('details',{className:'va-detail-raw'},h('summary',null,'查看本次接口数据'),h('p',{className:'va-note'},'仅展示本条消息的诊断数据；密钥、请求头和音频不包含在内，长数据会截断。'),h('pre',null,JSON.stringify(isAsr?{request:data.request,result:data.result}:request||{},null,2)))
    )));
 };
}
