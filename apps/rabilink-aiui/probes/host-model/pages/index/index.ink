<script def>
{"navigationBarTitleText":"Rabi 对话","description":"独立宿主流式语音对话，无参数。","schema":{"data":{"type":"object","properties":{},"required":[],"additionalProperties":false}}}
</script>
<script setup>
export default {
 data:{phase:'准备听取',heard:'',reply:'',control:'暂停',clock:'--:--',battery:'—',batteryReason:'尚未读取',lines:['说说你现在想到的事','',''],pageLabel:'1/1',following:true,focus:0,expanded:false,dialogHeight:66},
 onLoad(){this.visible=true;this.disposed=false;this.paused=false;this.startStatus();this.scheduleListen();},
 onShow(){this.visible=true;this.startStatus();this.scheduleListen();},
 onReady(){this.layoutReady=true;this.renderDialog();this.scheduleListen();},
 onHide(){this.visible=false;this.stopStatus();this.cleanup();},
 onUnload(){this.disposed=true;this.visible=false;this.stopStatus();this.cleanup();},
 onVoiceWakeup(){if(!this.visible||this.disposed)return;this.paused=false;this.setData({control:'暂停'});this.scheduleListen();},
 onKeyUp(event){const key=String(event?.key||event?.code||event?.keyCode||event?.detail?.key||'').toLowerCase();let handled=true;if(['arrowup','19','38'].includes(key))this.browse(-1);else if(['arrowdown','20','40'].includes(key))this.browse(1);else if(['arrowleft','arrowright','21','22','37','39'].includes(key))this.setData({focus:(this.data.focus+(['arrowleft','21','37'].includes(key)?2:1))%3});else if(['enter','globalhook','13','23'].includes(key)){if(this.data.focus===2)this.toggleView();else if(this.data.focus===1)this.latest();else this.toggle();}else handled=false;if(handled&&event?.preventDefault)event.preventDefault();},
 startStatus(){this.stopStatus();const refresh=()=>{if(!this.visible||this.disposed)return;const now=new Date();this.setData({clock:String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')});this.clockTimer=setTimeout(refresh,15000);};refresh();this.refreshBattery();},
 stopStatus(){if(this.clockTimer!=null)clearTimeout(this.clockTimer);this.clockTimer=null;this.stopBattery();},
 stopBattery(){const run=this.batteryRun;this.batteryRun=null;if(!run)return;run.cancelled=true;if(run.timer!=null)clearTimeout(run.timer);if(run.manager&&run.listener){run.manager.removeEventListener('levelchange',run.listener);run.manager.removeEventListener('chargingchange',run.listener);}},
 batteryActive(run){return this.batteryRun===run&&!run.cancelled&&this.visible&&!this.disposed;},
 refreshBattery(timeoutMs=5000){
  this.stopBattery();const run={cancelled:false,manager:null,listener:null,timer:null};this.batteryRun=run;
  this.setData({battery:'—',batteryReason:'正在读取宿主电量'});
  const fail=reason=>{if(!this.batteryActive(run))return;if(run.timer!=null)clearTimeout(run.timer);run.cancelled=true;this.setData({battery:'—',batteryReason:reason});console.warn('[Rabi battery] '+reason);};
  try{
   if(typeof navigator==='undefined'||typeof navigator.getDeviceSerialNumber!=='function'||!String(navigator.getDeviceSerialNumber()||'').trim()){fail('无AIUI设备身份，未读取浏览器电池');return;}
   if(typeof navigator.getBattery!=='function'){fail('宿主未提供 BatteryManager');return;}
   run.timer=setTimeout(()=>fail('宿主电量读取超时'),timeoutMs);
   Promise.resolve(navigator.getBattery()).then(manager=>{
    if(!this.batteryActive(run))return;if(run.timer!=null)clearTimeout(run.timer);run.timer=null;
    if(!manager||typeof manager.addEventListener!=='function'||typeof manager.removeEventListener!=='function'){fail('宿主电池对象无效');return;}
    run.manager=manager;run.listener=()=>{if(!this.batteryActive(run))return;const level=manager.level;
     if(typeof level!=='number'||!Number.isFinite(level)||level<0||level>1){this.setData({battery:'—',batteryReason:'宿主电量数值无效'});return;}
     this.setData({battery:Math.round(level*100)+'%'+(manager.charging===true?'充电':''),batteryReason:'AIUI设备宿主 BatteryManager'});
    };
    manager.addEventListener('levelchange',run.listener);manager.addEventListener('chargingchange',run.listener);run.listener();
   }).catch(error=>fail('宿主电量不可用：'+String(error?.message||error)));
  }catch(error){fail('宿主电量不可用：'+String(error?.message||error));}
 },
 wrap(text){const lines=[];let line='',width=0;for(const char of text){const size=char.charCodeAt(0)>255?2:1;if(char==='\n'||width+size>42){lines.push(line);line='';width=0;if(char==='\n')continue;}line+=char;width+=size;}if(line)lines.push(line);return lines;},
 pageRows(){let height=typeof window!=='undefined'&&Number.isFinite(window.innerHeight)?window.innerHeight:0;if(height<=0&&this.layoutReady&&typeof this.querySelector==='function'){try{height=this.querySelector('#surface')?.clientHeight||0;}catch{}}if(height<=0)height=this.data.expanded?352:150;return this.data.expanded?Math.max(3,Math.min(12,Math.floor((height-84)/22))):3;},
 toggleView(){this.setDisplayMode(this.data.expanded?'bubble':'fullscreen');},
 setDisplayMode(mode){this.layoutReady=true;if(mode!=='fullscreen'&&mode!=='bubble')return false;const expanded=mode==='fullscreen';if(this.data.expanded===expanded)return true;const anchor=(this.pageIndex||0)*this.pageRows();this.setData({expanded,focus:2});this.pageIndex=Math.floor(anchor/this.pageRows());this.renderDialog();return true;},
 renderDialog(){const rows=this.pageRows();const lines=[];for(const turn of this.turns||[]){lines.push(...this.wrap('你 · '+turn.user));if(turn.reply)lines.push(...this.wrap('Rabi · '+turn.reply));}if(this.draft)lines.push(...this.wrap('你 · '+this.draft));if(!lines.length)lines.push('说说你现在想到的事');const count=Math.max(1,Math.ceil(lines.length/rows));this.pageCount=count;this.pageIndex=this.data.following?count-1:Math.min(this.pageIndex||0,count-1);const visible=lines.slice(this.pageIndex*rows,this.pageIndex*rows+rows);while(visible.length<rows)visible.push('');this.setData({lines:visible,dialogHeight:rows*22,pageLabel:(this.pageIndex+1)+'/'+count});},
 browse(direction){this.pageIndex=Math.max(0,Math.min((this.pageCount||1)-1,(this.pageIndex||0)+direction));this.setData({following:this.pageIndex===(this.pageCount||1)-1});this.renderDialog();},
 latest(){this.setData({following:true,focus:1});this.renderDialog();},
 toggle(){this.paused=!this.paused;this.setData({control:this.paused?'继续':'暂停'});if(this.paused){this.cleanup();this.setData({phase:'已暂停'});}else this.scheduleListen();},
 scheduleListen(delay=50){if(!this.visible||this.disposed||this.paused||this.run||this.recognition||this.openTimer)return;const remaining=(this.speechUntil||0)-Date.now();this.openTimer=setTimeout(()=>{this.openTimer=null;this.startListening();},Math.max(delay,remaining));},
 cleanup(){if(this.openTimer!=null)clearTimeout(this.openTimer);this.openTimer=null;this.stopListening();const run=this.run;if(run){run.cancelled=true;if(run.cancelWait)run.cancelWait();if(run.stream){try{run.stream.cancel();}catch{}}this.run=null;}if(this.session){try{this.session.destroy();}catch{}this.session=null;}},
 stopListening(){if(this.listenTimer!=null)clearTimeout(this.listenTimer);const recognition=this.recognition;this.recognition=null;if(recognition){recognition.onresult=null;recognition.onerror=null;recognition.onend=null;try{recognition.abort();}catch{}}},
 fail(message){this.paused=true;this.setData({phase:message,control:'重试'});},
 startListening(){
  if(!this.visible||this.disposed||this.paused||this.run||this.recognition)return;
  if((this.speechUntil||0)>Date.now()){this.scheduleListen();return;}
  try{
   if(typeof SpeechRecognition!=='function')throw Error('宿主未提供 SpeechRecognition');
   const recognition=new SpeechRecognition();this.recognition=recognition;recognition.continuous=false;recognition.interimResults=true;
   const segments=[];
   recognition.onresult=event=>{
    if(this.recognition!==recognition||!this.visible)return;
    const results=event.results;if(!results)return;segments.length=results.length;
    for(let i=event.resultIndex||0;i<results.length;i++)segments[i]={text:results[i][0]?.transcript||'',final:results[i].isFinal===true};
    const text=segments.map(segment=>segment?.text||'').join('');
    this.draft=text;this.setData({heard:text,phase:'正在识别'});this.renderDialog();
    if(!text.trim()||!segments.length||!segments.every(segment=>segment?.final))return;
    this.stopListening();this.setData({reply:''});void this.ask(text);
   };
   recognition.onerror=event=>{if(this.recognition!==recognition)return;this.stopListening();this.fail('识别失败：'+String(event.message||event.error||'未知错误'));};
   recognition.onend=()=>{if(this.recognition!==recognition)return;this.stopListening();this.setData({phase:'未收到最终识别，继续听取'});this.scheduleListen(500);};
   this.setData({phase:'正在听，请说话',heard:''});recognition.start();
   this.listenTimer=setTimeout(()=>{if(this.recognition===recognition){this.stopListening();this.scheduleListen(500);}},30000);
  }catch(error){this.stopListening();this.fail('无法识别：'+String(error.message||error));}
 },
 active(run){return this.run===run&&!run.cancelled&&this.visible&&!this.disposed&&!this.paused;},
 modelOptions(){return {initialPrompts:[{role:'system',content:'用简短中文连续对话，每次尽量不超过两句话。用户要求切换全屏阅读或气泡显示时调用 set_display_mode。仅当用户明确要求退出当前应用时调用 close_app；不要把讨论、引用或否定当作退出命令。'}],tools:[{type:'function',function:{name:'close_app',description:'用户明确要求退出时结束当前Rabi页面任务；不关闭其他应用。',parameters:{type:'object',properties:{},additionalProperties:false}}},{type:'function',function:{name:'set_display_mode',description:'切换当前对话的全屏阅读或下方气泡布局。',parameters:{type:'object',properties:{mode:{type:'string',enum:['fullscreen','bubble']}},required:['mode'],additionalProperties:false}}}]};},
 handleTool(run,event){
  if(!this.active(run)||this.closing)return;
  if(event.isComplete!==true)return;
  if(event.functionName==='set_display_mode'){
   const args=event.arguments;if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||!this.setDisplayMode(args.mode)){this.setData({phase:'未执行无效显示模式'});return;}
   run.toolHandled=true;this.setData({phase:args.mode==='fullscreen'?'已切换全屏':'已切换气泡'});return;
  }
  if(event.functionName!=='close_app'){this.setData({phase:'未执行未授权工具'});return;}
  const text=run.turn.user.replace(/[\s，,。.!！?？]/g,'');
  if(!/^(请|请帮我|帮我|麻烦)?(退出|关闭|结束)(当前|这个|本)?(应用|对话|页面|Rabi|rabi|Rabi对话|rabi对话)(吧)?$/.test(text)){this.setData({phase:'退出需要明确指令：退出应用'});return;}
  const args=event.arguments;if(args===null||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length){this.setData({phase:'未执行无效工具参数'});return;}
  this.closing=true;this.paused=true;this.visible=false;this.disposed=true;this.stopStatus();this.cleanup();
  try{this.finish();}catch(error){this.disposed=false;this.visible=true;this.closing=false;this.fail('关闭页面失败：'+String(error.message||error));}
 },
 async waitStage(operation,run,label,timeoutMs){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{run.cancelWait=()=>reject(Error('页面已暂停'));timer=setTimeout(()=>reject(Error(label+'超时')),timeoutMs);})]);}finally{if(timer!=null)clearTimeout(timer);run.cancelWait=null;}},
 speechDelay(text){const han=(text.match(/[\u3400-\u9fff]/g)||[]).length;const words=(text.replace(/[\u3400-\u9fff]/g,' ').match(/[0-9A-Za-z]+/g)||[]).length;const punctuation=(text.match(/[，。！？；：,.!?;:]/g)||[]).length;return Math.max(1800,Math.min(90000,1200+han*280+words*420+punctuation*180));},
 enqueueSentence(run,text){
  if(!this.active(run)||!text.trim())return;
  if(typeof speechSynthesis==='undefined'||typeof SpeechSynthesisUtterance!=='function')throw Error('宿主未提供 TTS');
  speechSynthesis.speak(new SpeechSynthesisUtterance(text.trim()),'enqueue');
  this.speechUntil=Math.max(this.speechUntil||0,Date.now())+this.speechDelay(text);
 },
 flushSentences(run,final=false){
  const boundary=/[。！？!?；;\n]|\.(?=\s|$)/g;let match;
  while((match=boundary.exec(run.pending))!==null){
   const end=match.index+match[0].length;
   const sentence=run.pending.slice(0,end);run.pending=run.pending.slice(end);
   this.enqueueSentence(run,sentence);boundary.lastIndex=0;
  }
  if(final&&run.pending){const tail=run.pending;run.pending='';this.enqueueSentence(run,tail);}
 },
 async ask(text){
  if(this.run||!this.visible||this.disposed||this.paused)return;
  const run={cancelled:false,finished:false,pending:'',reply:'',turn:{user:text,reply:''}};this.run=run;this.draft='';this.turns=this.turns||[];this.turns.push(run.turn);if(this.turns.length>12)this.turns.shift();this.setData({phase:'正在思考'});this.renderDialog();
  try{
   if(!this.session){
    if(typeof LanguageModel==='undefined')throw Error('宿主未提供 LanguageModel');
    const available=await this.waitStage(LanguageModel.availability(),run,'模型检查',15000);
    if(!this.active(run))return;if(available!=='available')throw Error('宿主模型 unavailable');
    const creation=LanguageModel.create(this.modelOptions()).then(session=>{if(!this.active(run)||run.finished){session.destroy();return null;}this.session=session;return session;});
    await this.waitStage(creation,run,'创建会话',15000);
   }
   if(!this.active(run)||!this.session)return;
   const session=this.session;run.toolSession=session;run.toolListener=event=>this.handleTool(run,event);session.addEventListener('toolcall',run.toolListener);
   const stream=session.promptStreaming(text);run.stream=stream;
   const deadline=Date.now()+90000;
   while(this.active(run)){
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('模型流式回答超时');
    const chunk=await this.waitStage(stream.read(),run,'模型流式读取',Math.min(45000,remaining));
    if(!this.active(run))return;
    if(typeof chunk.value==='string'&&chunk.value){
     run.reply+=chunk.value;run.pending+=chunk.value;
     run.turn.reply=run.reply;this.setData({reply:run.reply,phase:'正在生成并播报'});this.renderDialog();this.flushSentences(run);
    }
    if(chunk.done)break;
    if(!chunk.value)await this.waitStage(new Promise(resolve=>setTimeout(resolve,40)),run,'等待流片段',1000);
   }
   if(!this.active(run))return;if(!run.reply.trim()){if(run.toolHandled)return;throw Error('宿主未返回文本');}
   this.flushSentences(run,true);this.setData({phase:'等待播报队列（估时）'});
  }catch(error){if(this.active(run)){if(run.stream){try{run.stream.cancel();}catch{}}if(this.session){try{this.session.destroy();}catch{}this.session=null;}this.fail(String(error.message||error));}}
  finally{run.finished=true;if(run.toolSession&&run.toolListener){try{run.toolSession.removeEventListener('toolcall',run.toolListener);}catch{}}if(this.run===run)this.run=null;this.scheduleListen();}
 }
};
</script>
<page><view id="surface" class="probe"><view class="header"><text class="title">Rabi 对话</text><text class="meta">v0.5 · {{clock}} · 电量 {{battery}}</text></view><view class="status"><text class="phase">{{phase}}</text><text class="meta">{{pageLabel}}</text></view><scroll-view class="dialog {{expanded ? 'dialogExpanded' : ''}}" scroll-y="{{expanded}}"><text ink:for="{{lines}}" class="body">{{item}}</text></scroll-view><view class="actions"><button class="action {{focus === 0 ? 'selected' : ''}}" bindtap="toggle">{{focus === 0 ? '› ' : ''}}{{control}}</button><button class="action {{focus === 1 ? 'selected' : ''}}" bindtap="latest">{{focus === 1 ? '› ' : ''}}{{following ? '最新' : '回到最新'}}</button><button class="action {{focus === 2 ? 'selected' : ''}}" bindtap="toggleView">{{focus === 2 ? '› ' : ''}}{{expanded ? '气泡' : '全屏'}}</button></view></view></page>
<style>
.probe{width:100%;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:3px;padding:6px 14px;box-sizing:border-box;color:#40ff5e;background-color:#000000;}.header,.status,.actions{display:flex;flex-direction:row;justify-content:space-between;align-items:center;}.header{height:20px;flex-shrink:0;}.title{font-size:17px;}.meta{font-size:12px;color:rgba(64,255,94,0.72);}.status{height:18px;flex-shrink:0;}.phase{font-size:13px;}.dialog{height:66px;flex-shrink:0;display:flex;flex-direction:column;}.dialogExpanded{height:100%;flex-shrink:1;}.body{height:22px;flex-shrink:0;font-size:18px;}.actions{height:24px;flex-shrink:0;justify-content:center;gap:12px;}.action{height:24px;padding:0px 12px;font-size:14px;color:rgba(64,255,94,0.72);background-color:#000000;}.selected{color:#40ff5e;border-bottom:1px solid #40ff5e;}
</style>
