import helpCatalog from './speech-capability-help.json' with {type:'json'};

/** Descriptions only. Availability stays with the host's provider schema and policy. */
export function speechCapabilityHelp(provider, spec, catalog) {
  if(provider==='compatible'&&catalog?.docs?.startsWith('https://developers.openai.com/'))provider='openai';
  const entry=helpCatalog[provider]?.fields[spec.expressionField||spec.key];
  const source=entry?helpCatalog[provider].source:catalog?.docs?{title:'当前提供商参数说明',url:catalog.docs,checkedAt:catalog.verifiedAt}:null;
  return {label:entry?.label||spec.label,description:entry?.description||spec.note||'当前目录未提供详细说明。',
    limitation:entry?.limitation||'',integration:entry?.integration||'',parameter:entry?.parameter||spec.parameter||'',source};
}

export function createSpeechCapabilityChip(React) {
  const h=React.createElement;
  return function SpeechCapabilityChip({help,status,statusLabel,reason,selection,emotions=[]}) {
    const dialog=React.useRef(null),trigger=React.useRef(null),titleId=React.useId();
    const close=()=>dialog.current?.close();
    return h(React.Fragment,null,
      h('button',{type:'button',className:'va-cap-trigger','data-status':status,ref:trigger,'aria-label':help.label+'：'+statusLabel+'，查看详情','aria-haspopup':'dialog',onClick:()=>dialog.current?.showModal()},
        h('span',null,h('strong',null,help.label),h('small',null,statusLabel)),h('span',{className:'va-cap-question','aria-hidden':true},'?')),
      h('dialog',{className:'va-cap-dialog',ref:dialog,'aria-labelledby':titleId,onClose:()=>trigger.current?.focus(),onClick:event=>{if(event.target===event.currentTarget)close()}},
        h('div',{className:'va-cap-dialog-content'},h('header',null,h('div',null,h('p',null,'能力说明'),h('h3',{id:titleId},help.label)),h('button',{type:'button',onClick:close,autoFocus:true,'aria-label':'关闭能力说明'},'关闭')),
          h('p',{className:'va-cap-current','data-status':status},statusLabel,reason&&' · '+reason),
          h('p',{className:'va-cap-selection'},selection),
          h('section',null,h('h4',null,'有什么用'),h('p',null,help.description)),
          help.limitation&&h('section',null,h('h4',null,'使用条件'),h('p',null,help.limitation)),
          help.integration&&h('section',null,h('h4',null,'助手如何使用'),h('p',null,help.integration)),
          emotions.length>0&&h('section',null,h('h4',null,'当前音色的情绪'),h('p',null,emotions.map(item=>item.label).join('、'))),
          help.parameter&&h('details',null,h('summary',null,'接口参数'),h('code',null,help.parameter)),
          h('footer',null,help.source?h(React.Fragment,null,h('a',{href:help.source.url,target:'_blank',rel:'noreferrer'},help.source.title+' ↗'),help.source.checkedAt&&h('small',null,'核对于 '+help.source.checkedAt)):h('small',null,'未提供官方来源，不声明额外能力。')))));
  };
}
