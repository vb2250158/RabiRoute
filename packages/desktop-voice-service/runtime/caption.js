let lastTextKey=''
window.audioDevice.onCommand(message=>{
  if(message.method!=='caption')return
  const {settings={},presentation={}}=message.params
  document.body.dataset.skin=settings.skin==='light'?'light':'dark'
  document.body.dataset.locked=String(Boolean(settings.locked))
  document.querySelector('[data-action="toggle-caption-lock"]').textContent=settings.locked?'解锁':'锁定'
  const alpha=Math.min(1,Math.max(.15,Number(settings.opacity)||.85))
  document.getElementById('caption').style.background=settings.skin==='light'?'rgba(245,248,255,'+alpha+')':'rgba(15,23,42,'+alpha+')'
  document.getElementById('text').style.fontSize=Math.min(48,Math.max(16,Number(settings.fontSize)||24))+'px'
  document.getElementById('state').textContent=presentation.statusText||'语音助手'
  const text=String(presentation.text||'字幕已开启，等待助手回复…'),timed=['word','sentence'].includes(presentation.timingMode),end=timed?Math.min(text.length,Math.max(0,presentation.spokenEnd||0)):0
  const start=timed?Math.max(0,Math.min(end-180,text.length-600)):Math.max(0,text.length-600),visible=text.slice(start,start+600),cursor=Math.max(0,end-start)
  const node=document.getElementById('text'),key=JSON.stringify([visible,cursor,timed])
  const box=document.getElementById('caption'),boxStyle=getComputedStyle(box),textStyle=getComputedStyle(node),lineHeight=parseFloat(textStyle.lineHeight)
  const available=box.clientHeight-parseFloat(boxStyle.paddingTop)-parseFloat(boxStyle.paddingBottom)-document.querySelector('header').getBoundingClientRect().height-parseFloat(textStyle.marginTop)
  const rows=Math.max(1,Math.floor(available/lineHeight));node.style.flex='none';node.style.height=(rows*lineHeight)+'px'
  if(key!==lastTextKey){lastTextKey=key
    if(timed){const spoken=document.createElement('span'),remaining=document.createElement('span'),marker=document.createElement('span');spoken.className='spoken';remaining.className='remaining';spoken.textContent=visible.slice(0,cursor);remaining.textContent=visible.slice(cursor);marker.textContent='\u200b';node.replaceChildren(spoken,marker,remaining);const currentLine=Math.floor((marker.offsetTop-node.offsetTop)/lineHeight);node.scrollTop=Math.max(0,(currentLine-rows+1)*lineHeight)}
    else node.textContent=visible
  }
})
for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>window.audioDevice.send({action:button.dataset.action}))
