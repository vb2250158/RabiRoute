/** Ephemeral projection, scoped to the response whose audio is actually playing. */
export function projectCaptionText(previous,value){
 return {...previous,...value,...(previous.responseId!==value.responseId?{spokenEnd:0,timingMode:null,speechStatus:'waiting',playbackId:undefined}:{})};
}
export function projectCaptionPlayback(previous,event){
 if(!event.responseId||previous.responseId!==event.responseId)return previous;
 if(event.type==='synthesizing')return {...previous,playbackId:event.id,speechStatus:'waiting'};
 if(event.id!==undefined&&previous.playbackId!==undefined&&event.id!==previous.playbackId)return previous;
 if(event.type==='cue'){
  const cue=event.cue,end=cue?.charIndex+cue?.charLength;
  if(!Number.isSafeInteger(cue?.charIndex)||!Number.isSafeInteger(cue?.charLength)||cue.charIndex<0||cue.charLength<=0||!['word','sentence'].includes(cue.mode)||!Number.isSafeInteger(end)||end>(previous.text||'').length||end<=(previous.spokenEnd||0)||['cancelled','ended'].includes(previous.speechStatus))return previous;
  return {...previous,spokenEnd:end,timingMode:cue.mode,speechStatus:'playing',statusText:'正在播报'};
 }
 if(['cancelled','error','ended'].includes(event.type))return {...previous,speechStatus:event.type,statusText:event.type==='ended'?'播报完成':event.type==='cancelled'?'播报已打断':'播报出现故障'};
 if(event.type==='play-requested')return {...previous,speechStatus:'playing'};
 return previous;
}
