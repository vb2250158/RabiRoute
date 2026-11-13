import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopNativeSlot } from '../lib/desktop-native-slot.mjs';

const pin={id:'io.test.qt',version:'1',revision:'a'.repeat(64)};
class Native extends EventEmitter {
  constructor(release){super();this.release=release;this.child={};this.qt={child:{}};this.stopping=false;}
  async request(){return {protocolVersion:2,trackingAvailable:false};}
  async preparePresentation(){this.presentationPrepared=true;}
  async close(){this.stopping=true;this.child=null;this.qt.child=null;}
}
test('a prepared Qt process that exited cannot retire a healthy original worker',async t=>{
 const clients=[];let retired=0;
 const slot=new DesktopNativeSlot({initial:{version:'old',qtPackageRef:pin},create:release=>{const n=new Native(release);clients.push(n);return n;},resolve:async()=>({version:'new',qtPackageRef:pin}),retire:async native=>{retired++;await native.close();}});t.after(()=>slot.close());
 const prepared=await slot.prepare('opaque-reference');prepared.candidate.native.qt.child=null;
 await assert.rejects(slot.activate(prepared,0),{code:'COMPUTER_DESKTOP_CANDIDATE_EXITED'});assert.equal(retired,0);assert.equal(clients[0].stopping,false);assert.equal(slot.status().release.version,'old');
});
test('Qt exit during original retirement closes the candidate before creating a fresh original owner',async t=>{
 const clients=[];let prepared;
 const slot=new DesktopNativeSlot({initial:{version:'old',qtPackageRef:pin},create:release=>{const n=new Native(release);clients.push(n);return n;},resolve:async()=>({version:'new',qtPackageRef:pin}),retire:async native=>{await native.close();prepared.candidate.native.qt.child=null;}});t.after(()=>slot.close());
 prepared=await slot.prepare('opaque-reference');await assert.rejects(slot.activate(prepared,0),{code:'COMPUTER_DESKTOP_CANDIDATE_EXITED'});
 assert.equal(clients.length,3);assert.equal(clients[0].stopping,true);assert.equal(clients[1].stopping,true);assert.equal(clients[2].release.version,'old');assert.equal(clients[2].presentationPrepared,true);assert.equal(slot.status().state,'ready');
});
