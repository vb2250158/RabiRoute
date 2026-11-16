/** Host identity is presentation data; it never changes the selected conversation or persona. */
export function assistantParticipants(state) {
  const personaId=state?.hostSettings?.personaId;
  const persona=personaId?state.hostSettings.personas?.find(item=>item.id===personaId):undefined;
  const assistant=state?.participants?.assistant,user=state?.participants?.user;
  return {
    assistant:{name:assistant?.name||state?.hostSettings?.personaLabel||state?.settings?.assistantName||'助手',
      avatarUrl:assistant?.avatarUrl||(persona?.avatarConfigured?persona.avatarUrl:'')||''},
    user:{name:user?.name||'我',avatarUrl:user?.avatarUrl||''},
    system:{name:'系统',avatarUrl:''},
  };
}

export function messageTimeLabel(message,previous) {
  if(!message.createdAt)return '';
  const date=new Date(message.createdAt),before=previous?.createdAt?new Date(previous.createdAt):null;
  if(!Number.isFinite(date.getTime()))return '';
  if(before&&Number.isFinite(before.getTime())&&date.toDateString()===before.toDateString()
    &&date.getTime()-before.getTime()<5*60*1000)return '';
  return date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
}

export function createMessageAvatar(React) {
  const h=React.createElement;
  return function MessageAvatar({name,avatarUrl,kind,resolveUrl}) {
    const [failed,setFailed]=React.useState(null);
    const safe=typeof avatarUrl==='string'&&(/^(?:https?:\/\/|\/(?!\/))/.test(avatarUrl)||/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(avatarUrl));
    const image=safe&&failed!==avatarUrl;
    const icon=kind==='user'
      ? h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6},h('circle',{cx:12,cy:8,r:3.3}),h('path',{d:'M5 21v-2a7 7 0 0 1 14 0v2'}))
      :kind==='system'?h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6},h('circle',{cx:12,cy:12,r:8}),h('path',{d:'M12 7v6m0 3v1'}))
      :h('span',null,Array.from(name||'助手')[0]);
    return h('span',{className:'va-avatar','data-kind':kind,'aria-hidden':true},image
      ?h('img',{src:resolveUrl?resolveUrl(avatarUrl):avatarUrl,alt:'',loading:'lazy',decoding:'async',referrerPolicy:'no-referrer',onError:()=>setFailed(avatarUrl)})
      :icon);
  };
}
