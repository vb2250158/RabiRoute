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
  document.getElementById('text').textContent=String(presentation.text||'').slice(-600)
})
for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>window.audioDevice.send({action:button.dataset.action}))
