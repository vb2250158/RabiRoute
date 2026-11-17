const {join}=require('node:path')

/** Window placement only. The host owns the document and its lifetime. */
exports.createCanvasPresenter=({BrowserWindow,screen,session,preload,send,safeWindow})=>{
 let window,document=null,revision=-1,docked=true,captionBounds=null,closing=false
 const clamp=b=>{const display=screen.getDisplayMatching(b),a=display.workArea,width=Math.min(a.width,Math.max(320,b.width)),height=Math.min(a.height,Math.max(220,b.height));return{x:Math.round(Math.max(a.x,Math.min(b.x,a.x+a.width-width))),y:Math.round(Math.max(a.y,Math.min(b.y,a.y+a.height-height))),width:Math.round(width),height:Math.round(height)}}
 const position=()=>{if(!window||!docked)return;const a=screen.getPrimaryDisplay().workArea,b=captionBounds||{x:a.x+(a.width-720)/2,y:a.y+a.height-180,width:720,height:150},width=Math.min(720,b.width),height=Math.round(width*9/16)+40;window.setBounds(clamp({x:b.x+(b.width-width)/2,y:b.y-height-12,width,height}))}
 const draw=()=>window?.webContents.send('device-command',{method:'canvas',params:{document,docked}})
 return {
  async update(value,bounds){captionBounds=bounds||captionBounds;if(!value?.visible||!value.document){document=null;if(window)window.hide();return{visible:false,docked}}
   if(!window){
    window=new BrowserWindow({show:false,title:'助手图表',width:720,height:445,frame:false,alwaysOnTop:true,skipTaskbar:true,webPreferences:{session,preload,contextIsolation:true,sandbox:true,nodeIntegration:false}})
    safeWindow(window);window.setMovable(!docked);window.on('close',event=>{if(closing)return;event.preventDefault();window.hide();send({event:'presenter.action',action:'canvas-close'})})
    await window.loadFile(join(__dirname,'canvas.html'))
   }
   if(revision!==value.revision||!document){document=value.document;revision=value.revision;draw()}
   position();window.showInactive();return{visible:window.isVisible(),docked,bounds:window.getBounds()}
  },
  follow(bounds){captionBounds=bounds;if(window?.isVisible())position()},
  action(sender,action){if(sender!==window?.webContents)return false;if(action==='canvas-close'){window.hide();send({event:'presenter.action',action:'canvas-close'});return true}if(action==='canvas-dock'){docked=!docked;window.setMovable(!docked);position();draw();return true}return false},
  close(){closing=true;window?.close();window=null},
 }
}
