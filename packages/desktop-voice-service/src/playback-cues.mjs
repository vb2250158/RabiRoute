/** Provider timing is metadata; only consumed PCM positions admit visible cues. */
export function createPlaybackCueTracker(onCue){
 let closed=false,position=-1,end=0,pending=[];
 const advance=seconds=>{
  if(closed||!Number.isFinite(seconds)||seconds<position)return;
  position=seconds;let consumed=0;
  for(const cue of pending){
   if(cue.startTime>position)break;
   consumed++;const next=cue.charIndex+cue.charLength;
   if(next>end){end=next;onCue?.(cue)}
   if(closed)break;
  }
  if(consumed)pending=pending.slice(consumed);
 };
 return {
  add(cues){if(closed||!Array.isArray(cues))return;
   for(const cue of cues){if(pending.length>=16000)break;
    if(Number.isSafeInteger(cue?.charIndex)&&Number.isSafeInteger(cue.charLength)&&cue.charIndex>=0&&cue.charLength>0&&cue.charIndex+cue.charLength<=16000&&Number.isFinite(cue.startTime)&&cue.startTime>=0&&Number.isFinite(cue.endTime)&&cue.endTime>=cue.startTime&&['word','sentence'].includes(cue.mode))pending.push({...cue});
   }
   pending.sort((a,b)=>a.startTime-b.startTime||a.charIndex-b.charIndex);
   if(position>=0)advance(position);
  },advance,dispose(){closed=true;pending=[]},
 };
}
