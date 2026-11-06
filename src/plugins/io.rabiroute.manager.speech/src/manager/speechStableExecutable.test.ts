import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {prepareStableSpeechExecutable} from "./speechStableExecutable.js";

test("speech executable keeps its identity and unchanged bytes across release directories", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"rabi-speech-stable-")));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first = path.join(root,"first.exe"), second = path.join(root,"second.exe");
  await fs.writeFile(first,"trusted launcher"); await fs.writeFile(second,"trusted launcher");
  const target = await prepareStableSpeechExecutable(first,root);
  const time = (await fs.stat(target)).mtimeMs;
  assert.equal(await prepareStableSpeechExecutable(second,root),target);
  assert.equal((await fs.stat(target)).mtimeMs,time);
  await fs.writeFile(second,"updated trusted launcher");
  assert.equal(await prepareStableSpeechExecutable(second,root),target);
  assert.equal(await fs.readFile(target,"utf8"),"updated trusted launcher");
  await prepareStableSpeechExecutable(first,root);
  assert.equal(await fs.readFile(target,"utf8"),"trusted launcher");
});

test("invalid stable executable target fails without changing the source", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"rabi-speech-stable-")));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,"source.exe"); await fs.writeFile(source,"trusted");
  await fs.mkdir(path.join(root,"runtime","speech","RabiSpeech.exe"),{recursive:true});
  await assert.rejects(prepareStableSpeechExecutable(source,root),/Invalid speech/);
  assert.equal(await fs.readFile(source,"utf8"),"trusted");
});
