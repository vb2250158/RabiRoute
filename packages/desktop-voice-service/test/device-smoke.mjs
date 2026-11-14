import {openDesktopDevice} from '../src/node-device.mjs';
const device=await openDesktopDevice({electronExecutable:process.env.VOICE_ELECTRON,signal:new AbortController().signal,onEvent:event=>console.log({event:event.type||event.event})});
try{
  const devices=await device.enumerateDevices();
  console.log(JSON.stringify({started:true,pid:device.pid,inputs:devices.filter(d=>d.kind==='audioinput').length,outputs:devices.filter(d=>d.kind==='audiooutput').length}));
  await device.configurePresenter({enabled:false});
}finally{await device.close();console.log('Confirmed device process tree exit')}
