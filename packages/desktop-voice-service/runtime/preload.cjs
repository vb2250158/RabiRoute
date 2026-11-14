const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('audioDevice',{
  onCommand(callback){ipcRenderer.on('device-command',(_event,value)=>callback(value))},
  send(value){ipcRenderer.send('device-message',value)},
})
