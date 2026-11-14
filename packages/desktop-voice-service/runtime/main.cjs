const {app,BrowserWindow,ipcMain,session,screen,Tray,Menu,nativeImage,shell}=require('electron')
const {join}=require('node:path')
const {pathToFileURL}=require('node:url')
const {connect}=require('node:net')
const option=name=>process.argv.find(value=>value.startsWith('--voice-'+name+'='))?.split('=').slice(1).join('=')
const pipe=option('pipe'),nonce=option('nonce'),userData=option('user-data')
if(!pipe||!nonce||!userData)process.exit(2)
app.setName('语音助手');app.setPath('userData',userData)
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required')
const ROOT=pathToFileURL(__dirname+'/').href,PAGE=pathToFileURL(join(__dirname,'audio.html')).href
const METHODS=new Set(['devices.list','record.start','record.take','record.mark','record.dispose','player.create','player.play','player.stop','player.dispose','player.stream.create','player.stream.append','player.stream.finish'])
const MAX=24*1024*1024
let win,caption,tray,captionSettings={enabled:true,locked:false,skin:'dark',fontSize:24,opacity:0.85,position:'bottom'},lastPresentation={},moveTimer,captionQueue=Promise.resolve(),quitting=false
const socket=connect(pipe)
const send=value=>{const frame=JSON.stringify(value)+'\n';if(frame.length>MAX||socket.writableLength>MAX){app.quit();return}socket.write(frame)}
socket.on('connect',()=>send({auth:nonce}))
socket.on('close',()=>app.quit());socket.on('error',()=>app.quit())
app.on('window-all-closed',()=>app.quit())
app.on('before-quit',()=>{quitting=true;clearTimeout(moveTimer)})
const safeWindow=window=>{
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  window.webContents.on('will-navigate',event=>event.preventDefault())
}
function clampBounds(bounds){
  if(!bounds||!['x','y','width','height'].every(key=>Number.isFinite(bounds[key])))return defaultBounds('bottom')
  const displays=screen.getAllDisplays()
  const center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}
  const display=displays.find(d=>center.x>=d.workArea.x&&center.y>=d.workArea.y&&center.x<d.workArea.x+d.workArea.width&&center.y<d.workArea.y+d.workArea.height)||screen.getPrimaryDisplay()
  const area=display.workArea,width=Math.min(Math.max(320,bounds.width),area.width),height=Math.min(Math.max(100,bounds.height),area.height)
  return {x:Math.round(Math.max(area.x,Math.min(bounds.x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(bounds.y,area.y+area.height-height))),width:Math.round(width),height:Math.round(height)}
}
function defaultBounds(position){
  const a=screen.getPrimaryDisplay().workArea,width=Math.min(720,a.width),height=150
  return clampBounds({x:a.x+(a.width-width)/2,y:position==='top'?a.y+24:a.y+a.height-height-32,width,height})
}
async function configureCaption(settings){
  const previousPosition=captionSettings.position
  captionSettings={...captionSettings,...settings}
  if(!caption&&captionSettings.enabled){
    caption=new BrowserWindow({show:false,title:'语音助手字幕',frame:false,alwaysOnTop:true,skipTaskbar:true,transparent:true,
      ...defaultBounds(captionSettings.position),webPreferences:{session:win.webContents.session,preload:join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}})
    safeWindow(caption)
    caption.on('close',event=>{if(quitting)return;event.preventDefault();caption.hide();send({event:'presenter.action',action:'captions-hide'})})
    const rememberBounds=()=>{clearTimeout(moveTimer);moveTimer=setTimeout(()=>{if(caption&&!caption.isDestroyed())send({event:'presenter.bounds',bounds:caption.getBounds()})},300)}
    caption.on('move',rememberBounds);caption.on('resize',rememberBounds)
    await caption.loadFile(join(__dirname,'caption.html'))
  }
  if(caption){
    caption.setMovable(!captionSettings.locked);caption.setResizable(!captionSettings.locked)
    if(settings.bounds)caption.setBounds(clampBounds(settings.bounds))
    else if(settings.bounds===null)caption.setBounds(defaultBounds(captionSettings.position))
    else if(settings.position&&settings.position!==previousPosition)caption.setBounds(defaultBounds(settings.position))
    caption.webContents.send('device-command',{method:'caption',params:{settings:captionSettings,presentation:lastPresentation}})
    if(captionSettings.enabled)caption.showInactive();else caption.hide()
  }
}
function trayMenu(){
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'语音助手',enabled:false},{type:'separator'},
    {label:'打开设置',click:()=>send({event:'presenter.action',action:'open-settings'})},
    {label:lastPresentation.capturePaused?'继续收音':'暂停收音',click:()=>send({event:'presenter.action',action:'toggle-capture'})},
    {label:lastPresentation.outputEnabled===false?'恢复播报':'播报静音',click:()=>send({event:'presenter.action',action:'toggle-output'})},
    {label:captionSettings.enabled?'隐藏字幕':'显示字幕',click:()=>send({event:'presenter.action',action:'toggle-captions'})},
    {label:captionSettings.locked?'解锁字幕位置':'锁定字幕位置',click:()=>send({event:'presenter.action',action:'toggle-caption-lock'})},
    {type:'separator'},{label:'停止语音助手',click:()=>send({event:'presenter.action',action:'stop'})},
  ]))
}
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('desktop-voice-device',{cache:false})
  const permitted=(webContents,permission,details)=>webContents===win?.webContents&&webContents.getURL()===PAGE&&
    (permission==='speaker-selection'||permission==='media'&&(details?.mediaTypes??['audio']).every(type=>type==='audio'))
  isolated.setPermissionRequestHandler((webContents,permission,callback,details)=>callback(permitted(webContents,permission,details)))
  isolated.setPermissionCheckHandler((webContents,permission,_origin,details)=>permitted(webContents,permission,details))
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(ROOT)&&!details.url.startsWith('blob:')}))
  win=new BrowserWindow({show:false,title:'语音助手音频',webPreferences:{session:isolated,preload:join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  safeWindow(win);win.webContents.on('render-process-gone',()=>app.quit())
  tray=new Tray(nativeImage.createFromPath(join(__dirname,'voice.png')));tray.setToolTip('语音助手');tray.on('double-click',()=>send({event:'presenter.action',action:'open-settings'}));trayMenu()
  ipcMain.on('device-message',(event,value)=>{
    if(!value||typeof value!=='object')return
    if(event.sender===win.webContents){if(JSON.stringify(value).length>MAX){app.quit();return}send(value)}
    else if(event.sender===caption?.webContents&&['open-settings','toggle-capture','toggle-output','stop','captions-hide','toggle-caption-lock'].includes(value.action))send({event:'presenter.action',action:value.action})
  })
  for(const event of ['display-removed','display-metrics-changed'])screen.on(event,()=>{if(caption)caption.setBounds(clampBounds(caption.getBounds()))})
  let buffer=''
  socket.setEncoding('utf8')
  socket.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>MAX){app.quit();return}
    let at
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1)
      try{
        const message=JSON.parse(line)
        if(!Number.isSafeInteger(message.id)||!message.params||typeof message.params!=='object')throw Error('protocol')
        if(message.method==='presenter.open-settings'){
          const url=new URL(message.params.url)
          if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search!=='?voice-assistant=1'||url.hash)throw Error('settings-url')
          void shell.openExternal(url.href).then(()=>send({id:message.id,ok:true,value:true}),()=>send({id:message.id,ok:false,error:'SETTINGS_OPEN_FAILED'}))
        }else if(message.method==='presenter.configure'){
          captionQueue=captionQueue.then(()=>configureCaption(message.params)).then(()=>{trayMenu();send({id:message.id,ok:true,value:true})},()=>send({id:message.id,ok:false,error:'CAPTION_CONFIG_FAILED'}))
        }
        else if(message.method==='presenter.update'){
          lastPresentation=message.params;caption?.webContents.send('device-command',{method:'caption',params:{settings:captionSettings,presentation:lastPresentation}});trayMenu();send({id:message.id,ok:true,value:true})
        }else if(METHODS.has(message.method))win.webContents.send('device-command',message)
        else throw Error('method')
      }catch{app.quit();return}
    }
  })
  await win.loadURL(PAGE)
}).catch(()=>{process.exitCode=1;app.quit()})
