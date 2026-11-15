import {createAgentProtocol} from '@rabilink/assistant-runtime/protocol';
const marker='<｜｜DSML｜｜';
const invalid=()=>{throw Object.assign(Error('TURN_DECISION_INVALID'),{code:'TURN_DECISION_INVALID'});};
function firstObject(raw){
  const start=raw.indexOf('{');if(start<0)return;
  let depth=0,quoted=false,escaped=false;
  for(let n=start;n<raw.length;n++){
    const c=raw[n];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return raw.slice(start,n+1);
  }
}

/** Transport compatibility for the current explicitly declared WorkBuddy application tools.
 * Binding, declared tool checks and actual execution remain in the shared loop. */
export function createSearchAgentProtocol(){
  const base=createAgentProtocol();let nativeSearch=false,workbuddy=false;let declared=new Set();
  const protocol={...base,
    modelOptions(options,tools){workbuddy=options.provider==='workbuddy-cli';declared=new Set(tools.map(item=>item.function?.name));nativeSearch=workbuddy&&declared.size>0;return base.modelOptions(options,tools);},
    parseDecision(raw,requestId){
      if(!nativeSearch){if(workbuddy&&raw.includes('<｜'))invalid();return base.parseDecision(raw,requestId);}
      if(raw.includes(marker)||raw.includes('<｜')){
        const match=raw.match(/^([\s\S]*?)<｜｜DSML｜｜ calls>\s*<｜｜DSML｜｜ invoke name="([A-Za-z][A-Za-z0-9_-]*)">([\s\S]*?)<\/｜｜DSML｜｜ invoke>\s*<\/｜｜DSML｜｜ calls>\s*$/);
        if(!match||/[{]|```|<｜/.test(match[1])||!declared.has(match[2]))invalid();
        const args={},body=match[3],pattern=/<｜｜DSML｜｜ parameter name="([A-Za-z][A-Za-z0-9_]*)" string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜ parameter>/g;
        const decode=value=>value.replace(/&(amp|lt|gt|quot|apos);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key]);
        let consumed='',parameter;while((parameter=pattern.exec(body))){consumed+=parameter[0];if(Object.hasOwn(args,parameter[1])||parameter[1]==='__proto__'||parameter[3].length>65536||/[<>]/.test(parameter[3]))invalid();try{Object.defineProperty(args,parameter[1],{value:parameter[2]==='true'?decode(parameter[3]):JSON.parse(decode(parameter[3])),enumerable:true})}catch{invalid()}}
        if(body.replace(pattern,'').trim())invalid();
        return base.parseDecision(JSON.stringify({protocol:base.id,requestId,kind:'tool',name:match[2],arguments:args}),requestId);
      }
      // Some CLI models narrate before the application's JSON action. The
      // prefix was already streamed; validate the exact remaining action.
      const brace=raw.indexOf('{');
      if(brace>=0&&!raw.slice(0,brace).includes('```')){
        try{const value=base.parseDecision(firstObject(raw),requestId);if(value.kind==='tool'&&declared.has(value.name))return value;}catch{}
      }
      return base.parseDecision(raw,requestId);
    },
    canonicalAssistantOutput(raw,requestId){
      const value=protocol.parseDecision(raw,requestId);
      // Retain the validated action only. Model-invented trailing user/tool
      // observations never become conversation facts or search receipts.
      return value.kind==='tool'?JSON.stringify(value):raw;
    },
  };
  return protocol;
}

/** Hold only possible native markup; ordinary final prose keeps streaming. */
export function createSearchTextFilter(enabled){
  let text='',sent=0,blocked=false;
  return {
    push(delta){
      if(!enabled)return delta;
      text+=delta;if(blocked)return '';
      let end=text.indexOf(marker);
      if(end>=0)blocked=true;
      else{
        end=text.length;
        for(let n=1;n<marker.length;n++)if(text.endsWith(marker.slice(0,n)))end=Math.min(end,text.length-n);
      }
      const value=text.slice(sent,end);sent=end;return value;
    },
    finish(){if(!enabled||blocked)return '';const rest=text.slice(sent);sent=text.length;return rest;},
  };
}
