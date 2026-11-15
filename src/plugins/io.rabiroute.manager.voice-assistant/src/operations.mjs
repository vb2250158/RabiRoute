const object={type:'object'},response={mediaType:'application/json',schema:{type:'object',additionalProperties:true}};
export function createVoiceAssistantOperations(owner,run){
  return [['state','GET'],['messages','GET'],['command','POST'],['scan','GET']].map(([action,method])=>({
    discovery:{title:'语音助手 · '+action,category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.'+action,contractVersion:'1.0.0',method,pathTemplate:'/api/voice-assistant/'+action,exposure:'public',transport:'http',description:'Access the plugin-owned shared assistant session; stopping it never exits Rabi PC.',
      request:{path:object,query:object,headers:object,body:method==='POST'?{kind:'json',schema:{type:'object',required:['action'],properties:{action:{type:'string'}},additionalProperties:true},maxBytes:131072}:{kind:'none'}},responses:{200:response,400:response,409:response,503:response},
      effects:{mode:method==='GET'?'read':'native-assistant-command',description:'The assistant lifecycle, private settings and context retain their original owner. Tools keep their own receipts.'},recovery:{strategy:'original-session-readback',description:'Read state and messages using the original session and request ID. Never replay a tool after an unknown result.'},validators:[{id:'current-assistant-owner',description:'Current plugin activation and original Manager identity must remain current.'}]},
    async handler(input){try{return await run(async()=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await(action==='command'?owner.command(input.body):action==='scan'?owner.agent.operations.scan():owner[action]())}}))}catch(error){return {status:409,body:{code:-1,message:error.message}}}}
  }));
}
