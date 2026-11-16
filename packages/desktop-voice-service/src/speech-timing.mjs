/** Maps provider words to the actual submitted text. Never invents word times. */
export function createTextTimingMapper(textOf){
 let cursor=0,lastStart=-1;
 return payload=>{
  const source=textOf(),cues=[];
  if(typeof source!=='string'||!Array.isArray(payload?.words))return cues;
  for(const item of payload.words.slice(0,16000)){
   const word=item.word,startTime=item.startTime,endTime=item.endTime;
   if(typeof word!=='string'||!word||word.length>512||!Number.isFinite(startTime)||!Number.isFinite(endTime)||startTime<0||endTime<startTime||endTime>3600||startTime<lastStart)continue;
   const index=source.indexOf(word,cursor);if(index<0)continue;
   cursor=index+word.length;lastStart=startTime;
   cues.push({charIndex:index,charLength:word.length,startTime,endTime,mode:'word'});
  }
  return cues;
 };
}
