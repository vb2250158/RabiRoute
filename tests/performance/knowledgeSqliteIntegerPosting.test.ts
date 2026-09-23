import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeSqlitePrototype, type SqliteKnowledgeRow } from "./knowledgeSqlitePrototype.js";

const row=(id:string,text:string):SqliteKnowledgeRow=>({id,text,kind:"plan",status:"open",archived:false,updatedAt:"2026-01-01",tags:["tag"]});

test("integer postings retain business identity on update and never reuse a deleted incarnation",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sqlite-integer-"));
  const index=new KnowledgeSqlitePrototype(path.join(root,"index.sqlite"));
  try {
    index.upsert(row("stable-business-id","中文 oldphrase"));
    const first=Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get("stable-business-id")!.docid);
    index.upsert(row("stable-business-id","新词 newphrase"));
    assert.equal(Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get("stable-business-id")!.docid),first);
    for(const text of ["中","中文","oldphrase"]) assert.equal(index.search({text}).total,0);
    for(const text of ["新","新词","newphrase"]) assert.equal(index.search({text}).items[0]!.id,"stable-business-id");
    index.remove("stable-business-id");
    assert.equal(index.search({text:"新"}).total,0);
    assert.equal(Number(index.db.prepare("SELECT count(*) AS n FROM short_terms WHERE docid=?").get(first)!.n),0);
    index.upsert(row("stable-business-id","回归 %_"));
    const second=Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get("stable-business-id")!.docid);
    assert.ok(second>first);
    index.db.exec("VACUUM");
    assert.equal(Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get("stable-business-id")!.docid),second);
    assert.equal(index.search({text:"%_"}).items[0]!.id,"stable-business-id");
    assert.deepEqual(index.db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.equal(Number(index.db.prepare("SELECT count(*) AS n FROM short_terms WHERE typeof(docid)!='integer'").get()!.n),0);
  } finally {index.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("failed standalone upsert and caller rollback restore every posting and mapping",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sqlite-integer-"));
  const index=new KnowledgeSqlitePrototype(path.join(root,"index.sqlite"));
  try {
    index.upsert(row("one","中文 kept"));
    const original=index.db.prepare("SELECT * FROM documents WHERE id='one'").get();
    assert.throws(()=>index.upsert({...row("one","新词 rejected"),tags:null as unknown as string[]}));
    assert.deepEqual(index.db.prepare("SELECT * FROM documents WHERE id='one'").get(),original);
    assert.equal(index.search({text:"中文"}).total,1);
    assert.equal(index.search({text:"新"}).total,0);
    assert.throws(()=>index.transaction(()=>{index.remove("one");index.upsert(row("one","不同"));throw new Error("rollback batch");}),/rollback batch/);
    assert.deepEqual(index.db.prepare("SELECT * FROM documents WHERE id='one'").get(),original);
    assert.equal(index.search({text:"中文"}).total,1);
    assert.deepEqual(index.db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally {index.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("old text-posting schema is rejected without silently modifying its data",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sqlite-integer-"));
  const file=path.join(root,"old.sqlite");
  const old=new DatabaseSync(file);
  old.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,text TEXT);INSERT INTO documents VALUES('one','untouched')");old.close();
  try {
    assert.throws(()=>new KnowledgeSqlitePrototype(file),/explicit rebuild/);
    const verify=new DatabaseSync(file,{readOnly:true});
    try {assert.equal(verify.prepare("SELECT text FROM documents").get()!.text,"untouched");assert.equal(Number(verify.prepare("PRAGMA user_version").get()!.user_version),0);} finally {verify.close();}
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
