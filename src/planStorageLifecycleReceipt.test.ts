import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  commitPlanLifecycleTransitionUnderLease,
  recoverPlanLifecycleTransitions,
  recoverPlanStorageLegacyResolutions,
  recoverPlanStoragePackageTransactions,
  recoverPlanStorageTransactions,
  withPlanStorageLease,
  type PlanStoragePackageFile
} from './planStorageRepository.js';

function fixture(t: TestContext): string {
  const role = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lifecycle-terminal-'));
  t.after(() => fs.rmSync(role, { recursive:true, force:true }));
  return role;
}
function files(id: string): PlanStoragePackageFile[] {
  const content = Buffer.from(JSON.stringify({id,title:'Receipt history',focus:'Retain completed transactions',status:'执行中',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'})+'\n');
  const history=Buffer.from(JSON.stringify({id:`${id}-created`,planId:id,kind:'created',recordedAt:'2026-09-01T00:00:00.000Z'})+'\n');
  return ([['plan.json',content],['history.jsonl',history]] as const).map(([file,bytes])=>({path:file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes}));
}
function commit(role: string,id: string) {
  return withPlanStorageLease(role,id,lease => commitPlanLifecycleTransitionUnderLease(lease,{
    transactionId:'create',kind:'plan-create',fromBucket:null,toBucket:'active',files:files(id)
  }));
}
const empty = {results:[],abandoned:[],failures:[]};

test('completed lifecycle history is skipped before manifest stats without modifying evidence', {concurrency:false,timeout:30000}, t => {
  const role=fixture(t), id='history-plan', count=256;
  const receipts:string[]=[];
  withPlanStorageLease(role,id,lease => {
    let previous: string | undefined;
    for(let i=0;i<count;i++) {
      const result=commitPlanLifecycleTransitionUnderLease(lease,{
        transactionId:`revision_${i}`,kind:i===0?'plan-create':'plan-update',fromBucket:i===0?null:'active',toBucket:'active',
        ...(previous?{expectedSourceInventoryHash:previous}:{}),files:files(id)
      });
      assert.equal(result.status,'committed');
      receipts.push(result.receiptPath);
      previous=result.inventoryHash;
    }
  });
  const evidence=receipts.flatMap(file=>[file,path.join(path.dirname(file),'manifest.json')]);
  const before=evidence.map(file=>fs.readFileSync(file));
  const original=fs.lstatSync;
  let manifestStats=0;
  const lstatMock=t.mock.method(fs,'lstatSync',((file:fs.PathLike,...args:unknown[]) => {
    if(String(file).endsWith(`${path.sep}manifest.json`) && String(file).includes('plan-storage-lifecycle-transactions')) manifestStats++;
    return Reflect.apply(original,fs,[file,...args]);
  }) as typeof fs.lstatSync);
  let recovered;
  const start=performance.now();
  try { recovered=recoverPlanLifecycleTransitions(role); }
  finally { lstatMock.mock.restore(); }
  const elapsedMs=performance.now()-start;
  assert.deepEqual(recovered,empty);
  evidence.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
  t.diagnostic(JSON.stringify({completedTransactions:count,manifestStats,elapsedMs,scope:'collector/recovery only; fixture creation excluded'}));
  assert.equal(manifestStats,0,'terminal receipts must avoid historical manifest stats');
});

test('terminal nonplain manifest is ignored while unfinished lifecycle transaction still recovers', t => {
  const role=fixture(t);
  const terminal=commit(role,'terminal-plan');
  const receipt=fs.readFileSync(terminal.receiptPath);
  const manifest=path.join(path.dirname(terminal.receiptPath),'manifest.json');
  const manifestBytes=fs.readFileSync(manifest);
  fs.renameSync(manifest,`${manifest}.saved`);
  fs.mkdirSync(manifest);
  const unfinished=commit(role,'unfinished-plan');
  fs.unlinkSync(unfinished.receiptPath);
  const result=recoverPlanLifecycleTransitions(role);
  assert.equal(result.results.length,1);
  assert.deepEqual(result.failures,[]);
  assert.equal(result.results[0].status,'committed');
  assert.deepEqual(fs.readFileSync(terminal.receiptPath),receipt);
  assert.equal(fs.statSync(manifest).isDirectory(),true);
  assert.deepEqual(fs.readFileSync(`${manifest}.saved`),manifestBytes);
  assert.equal(fs.existsSync(unfinished.receiptPath),true);
});

test('nonplain lifecycle manifest without receipt remains rejected', t => {
  const role=fixture(t);
  const tx=path.join(role,'plans','quarantine','plan-storage-lifecycle-transactions','uncommitted-plan','pending');
  fs.mkdirSync(path.join(tx,'manifest.json'),{recursive:true});
  assert.throws(()=>recoverPlanLifecycleTransitions(role),/manifest is not one plain file/);
  assert.equal(fs.existsSync(path.join(tx,'receipt.json')),false);
  assert.equal(fs.statSync(path.join(tx,'manifest.json')).isDirectory(),true);
});

test('lifecycle directory links remain rejected despite a terminal receipt below them', t => {
  const role=fixture(t);
  const tx=commit(role,'linked-plan');
  const parent=path.dirname(path.dirname(tx.receiptPath));
  const renamed=`${parent}-retained`;
  fs.renameSync(parent,renamed);
  fs.symlinkSync(renamed,parent,'junction');
  assert.throws(()=>recoverPlanLifecycleTransitions(role),/transaction root contains a link/);
  assert.equal(fs.existsSync(path.join(renamed,'create','receipt.json')),true);
});

for(const [kind,depth,recover] of [
  ['plan-storage-legacy-resolutions',2,recoverPlanStorageLegacyResolutions],
  ['plan-storage-package-transactions',2,recoverPlanStoragePackageTransactions],
  ['plan-storage-transactions',3,recoverPlanStorageTransactions]
] as const) {
  test(`shared collector keeps terminal nonplain manifest guard for ${kind}`, t => {
    const role=fixture(t);
    const tx=path.join(role,'plans','quarantine',kind,'fixture-plan',...(depth===3?['feedback']:[]),'terminal');
    fs.mkdirSync(path.join(tx,'manifest.json'),{recursive:true});
    fs.writeFileSync(path.join(tx,'receipt.json'),'{}\n');
    assert.throws(()=>recover(role),/manifest is not one plain file/);
    assert.equal(fs.readFileSync(path.join(tx,'receipt.json'),'utf8'),'{}\n');
  });
}
