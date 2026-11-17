import {safeSpeechDetails} from '@rabilink/desktop-voice-service/speech-details';

const redactText=text=>text.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [已隐藏]')
  .replace(/\bsk-[A-Za-z0-9_-]{20,}/g,'[已隐藏]')
  .replace(/([?&](?:[^=&#\s]*(?:token|secret|password|api[_-]?key)[^=&#\s]*)=)[^&#\s"']*/gi,'$1[已隐藏]');
const snapshot=value=>{
  const clean=safeSpeechDetails(value);
  const visit=item=>typeof item==='string'?redactText(item):Array.isArray(item)?item.map(visit):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([key,value])=>[key,visit(value)])):item;
  return visit(clean);
};

/** Presentation receipts, attached to the same encrypted message as speech details. */
export function recordExecution(details, event, now = new Date().toISOString()) {
  const execution = details.execution ||= {steps:[]};
  if (['thinking','finishing'].includes(event.state)) {
    const id='model-'+event.steps;
    if(!execution.steps.some(step=>step.id===id))execution.steps.push({id,kind:'model',status:'running',startedAt:now});
  }
  if(event.tool){
    const tool=event.tool;
    for(const step of execution.steps)if(step.kind==='model'&&step.status==='running'){step.status='completed';step.endedAt=now;}
    let step=execution.steps.find(step=>step.id===tool.callId);
    if(!step){step={id:tool.callId,kind:'tool',name:tool.name,arguments:snapshot(tool.arguments),status:'running',startedAt:now};execution.steps.push(step)}
    if(event.state==='tool-completed')Object.assign(step,{status:tool.outcomeStatus?.uncertain?'unconfirmed':tool.outcomeStatus?.failed?'failed':'completed',outcome:snapshot(tool.outcome),endedAt:now});
  }
  if(['completed','uncertain','failed','cancelled'].includes(event.state)){
    execution.status=event.state;execution.endedAt=now;
    for(const step of execution.steps)if(step.status==='running'){step.status=event.state==='completed'?'completed':event.state==='uncertain'?'unconfirmed':event.state;step.endedAt=now;}
  }
  return execution;
}
