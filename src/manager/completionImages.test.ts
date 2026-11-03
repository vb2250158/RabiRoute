import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexTurnImages } from "./completionImages.js";

test("native completion images retain output order for the exact turn and exclude screenshots and other turns", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"completion-native-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const image=(id:number)=>Buffer.from([137,80,78,71,13,10,26,10,id]).toString("base64");
  const row=(turn:string,kind:string,id:number,status="completed")=>({type:"event_msg",payload:{type:"item_completed",turn_id:turn,item:{type:"Extension",kind,status,result:image(id)}}});
  const file=path.join(root,"rollout.jsonl");fs.writeFileSync(file,[row("old","image_gen.generation",1),row("turn","screenshot",2),row("turn","image_gen.generation",3),row("turn","image_gen.generation",3),row("turn","image_gen.generation",4,"failed"),row("turn","image_gen.generation",5),{...row("turn","image_gen.generation",6),payload:{...row("turn","image_gen.generation",6).payload,item:{type:"Extension",kind:"image_gen.generation",status:"completed",result:"invalid"}}}].map(x=>JSON.stringify(x)).join("\n"));
  const errors:Error[]=[];
  assert.deepEqual(await readCodexTurnImages(file,"turn",error=>errors.push(error)),["base64://"+image(3),"base64://"+image(5)]);
  assert.equal(errors.length,1);
});
