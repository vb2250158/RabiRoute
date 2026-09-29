// One MCP reference draft; this editor never installs services or grants permissions.
export function createProfileMcpEditor({document,container,validate}) {
  let draft=[],advanced=false,frozen=true;
  function node(tag,text,parent=container){const n=document.createElement(tag);if(text)n.textContent=text;parent.appendChild(n);return n;}
  node('h4','MCP 服务引用');node('p','仅支持 rabi-knowledge 引用，不安装第三方服务。不填写 URL、Token 或命令。授权请打开此设备的“知识授权”；保存引用不代表已授权、PC 就绪或连接成功。');
  const visual=node('div');node('p','服务 ID：rabi-knowledge',visual);
  const enabledLabel=node('label','启用知识服务引用',visual);const enabled=node('input','',enabledLabel);enabled.type='checkbox';
  Object.assign(enabledLabel.style,{display:'flex',alignItems:'center',minHeight:'44px'});Object.assign(enabled.style,{width:'20px',height:'20px'});
  const labelWrap=node('label','显示名称',visual);const label=node('input','',labelWrap);label.maxLength=128;
  const state=node('p','',visual),unknown=node('div','',visual);
  const toggle=node('button','JSON 高级编辑');toggle.type='button';const raw=node('textarea');raw.rows=6;raw.setAttribute('aria-label','MCP JSON 高级编辑');
  const error=node('p');error.setAttribute('role','status');
  for(const n of [label,toggle,raw])Object.assign(n.style,{minHeight:'44px',maxWidth:'100%',boxSizing:'border-box'});label.style.width=raw.style.width='100%';
  const known=()=>draft.find(item=>item.id==='rabi-knowledge');
  function lock(value){frozen=value;enabled.disabled=value||advanced||(!known()&&draft.length>=16);label.disabled=value||advanced||!known();toggle.disabled=raw.disabled=value;}
  function render(){const item=known();visual.hidden=advanced;raw.hidden=!advanced;toggle.textContent=advanced?'返回可视化编辑':'JSON 高级编辑';enabled.checked=!!item?.enabled;label.value=item?.label||'';state.textContent=item?'引用草稿：'+(item.enabled?'启用':'禁用'):'尚未添加引用；明确开启才添加。'+(draft.length>=16?'已达 16 项，不能新增。':'');unknown.replaceChildren();for(const ref of draft.filter(item=>item.id!=='rabi-knowledge')){const p=node('p',ref.id+' / '+ref.label+' / '+(ref.enabled?'启用':'禁用')+'：此应用不支持该引用，配置仍保留。修改或删除请使用高级 JSON。',unknown);p.style.overflowWrap='anywhere';}lock(frozen);}
  function commitRaw(){try{draft=validate(JSON.parse(raw.value));error.textContent='';return true;}catch{error.textContent='MCP JSON 无效；原文本保留，未发送。';return false;}}
  enabled.addEventListener('change',()=>{if(enabled.disabled)return;const item=known();if(item)item.enabled=enabled.checked;else if(enabled.checked)draft.push({id:'rabi-knowledge',label:'Rabi 知识服务',enabled:true});render();});
  label.addEventListener('input',()=>{if(!label.disabled)known().label=label.value;});
  toggle.addEventListener('click',()=>{if(frozen)return;if(advanced){if(!commitRaw())return;advanced=false;}else{raw.value=JSON.stringify(draft,null,2);advanced=true;}render();});
  function get(){if(advanced&&!commitRaw())throw new Error('INVALID_MCP');return validate(draft);}
  function set(value){const next=validate(value);draft=next;advanced=false;raw.value='';error.textContent='';render();}
  render();return {get,set,lock,nodes:{enabled,label,toggle,raw,unknown,state,error}};
}
