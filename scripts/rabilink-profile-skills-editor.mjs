// Browser factory: mutually exclusive views over one validated Skill draft.
export function createProfileSkillsEditor({document,container,validate}) {
  let draft=[],advanced=false,frozen=true;
  const controls=[];
  function node(tag,text,parent=container){const n=document.createElement(tag);if(text)n.textContent=text;parent.appendChild(n);return n;}
  const heading=node('h4','Skill 指引');node('p','最多 16 项；ID 和标题最多 128 字符，每项内容最多 8000 字符，总内容最多 24000 字符。仅内联指引，不安装包或增加权限。');
  const cards=node('div');const add=node('button','添加 Skill');add.type='button';
  const toggle=node('button','JSON 高级编辑');toggle.type='button';
  const raw=node('textarea');raw.rows=8;raw.hidden=true;raw.setAttribute('aria-label','Skill JSON 高级编辑');
  const error=node('p');error.setAttribute('role','status');
  for(const n of [add,toggle,raw]){n.style.minHeight='44px';n.style.maxWidth='100%';n.style.boxSizing='border-box';}
  raw.style.width='100%';
  function check(value){return validate(value);}
  function commitRaw(){try{const next=check(JSON.parse(raw.value));draft=next;error.textContent='';return true;}catch{error.textContent='Skill JSON 无效：请检查字段、重复 ID 和长度；原文本已保留。';return false;}}
  function lock(value){frozen=value;for(const n of [...controls,add,toggle,raw])n.disabled=value;add.disabled=value||advanced||draft.length>=16;}
  function render(){cards.replaceChildren();controls.length=0;cards.hidden=advanced;raw.hidden=!advanced;toggle.textContent=advanced?'返回可视化编辑':'JSON 高级编辑';
    draft.forEach((skill,index)=>{const card=node('fieldset','',cards);card.style.minWidth='0';card.style.margin='8px 0';node('legend','Skill '+(index+1),card);
      for(const [key,title] of [['id','ID'],['title','标题'],['content','指引内容']]){const label=node('label',title,card);label.style.display='block';const input=node(key==='content'?'textarea':'input','',label);input.value=skill[key];input.maxLength=key==='content'?8000:128;if(key==='content')input.rows=5;Object.assign(input.style,{width:'100%',minHeight:'44px',boxSizing:'border-box'});input.addEventListener('input',()=>{if(!frozen)draft[index][key]=input.value;});controls.push(input);}
      const label=node('label','启用此 Skill',card);Object.assign(label.style,{display:'flex',alignItems:'center',minHeight:'44px'});const enabled=node('input','',label);enabled.type='checkbox';enabled.checked=skill.enabled;enabled.style.width='20px';enabled.style.height='20px';enabled.addEventListener('change',()=>{if(!frozen)draft[index].enabled=enabled.checked;});controls.push(enabled);
      const remove=node('button','删除此 Skill',card);remove.type='button';remove.style.minHeight='44px';remove.addEventListener('click',()=>{if(frozen)return;draft.splice(index,1);render();});controls.push(remove);
    });lock(frozen);
  }
  add.addEventListener('click',()=>{if(frozen||advanced||draft.length>=16)return;let n=1;while(draft.some(s=>s.id==='skill-'+n))n++;draft.push({id:'skill-'+n,title:'新 Skill',content:'',enabled:true});render();});
  toggle.addEventListener('click',()=>{if(frozen)return;if(advanced){if(!commitRaw())return;advanced=false;}else{raw.value=JSON.stringify(draft,null,2);advanced=true;}render();});
  function get(){if(advanced&&!commitRaw())throw new Error('INVALID_SKILLS');try{return check(draft);}catch{error.textContent='Skill 字段无效，未发送；请检查 ID、标题、重复项和长度。';throw new Error('INVALID_SKILLS');}}
  function set(value){draft=check(value);advanced=false;raw.value='';error.textContent='';render();}
  render();return {get,set,lock,nodes:{cards,add,toggle,raw,error,heading}};
}
