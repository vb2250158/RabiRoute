import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { syntheticKnowledgeRow } from "./knowledgeSqliteSyntheticFixture.js";

const directory=process.env.KNOWLEDGE_INTEGER_ARTIFACT_DIR;
assert.ok(directory,"explicit retained artifact directory required");
const file=path.join(directory,"index.sqlite");
const before=fs.statSync(file);const start=performance.now();
const db=new DatabaseSync(file,{readOnly:true});
try {
  const schemaVersion=Number(db.prepare("PRAGMA user_version").get()!.user_version);
  assert.equal(schemaVersion,2);
  const integrity=db.prepare("PRAGMA quick_check").all();
  assert.deepEqual(integrity.map(item=>item.quick_check),["ok"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  const hash=createHash("sha256");let count=0,textBytes=0;
  for(const item of db.prepare("SELECT d.*, (SELECT json_group_array(tag) FROM tags t WHERE t.id=d.id) AS tags FROM documents d ORDER BY docid").iterate()) {
    const expected=syntheticKnowledgeRow(count);
    assert.equal(Number(item.docid),count+1);
    const actual={id:item.id,text:item.text,kind:item.kind,status:item.status,archived:Boolean(item.archived),tags:JSON.parse(String(item.tags)),updatedAt:item.updatedAt};
    assert.deepEqual(actual,expected);
    hash.update(JSON.stringify(expected)+"\n");textBytes+=Buffer.byteLength(expected.text);count++;
  }
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM fulltext").get()!.n),count);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM fulltext f JOIN documents d ON d.docid=f.rowid WHERE f.id!=d.id OR f.text!=d.text").get()!.n),0);
  const report={schemaVersion,integrity:"quick_check ok; foreign_key_check empty",persistedRows:count,contiguousGeneratorRange:[0,count-1],sourcePrefixSha256:hash.digest("hex"),textBytes,
    databaseBytes:before.size,walBytes:fs.existsSync(`${file}-wal`)?fs.statSync(`${file}-wal`).size:0,shmBytes:fs.existsSync(`${file}-shm`)?fs.statSync(`${file}-shm`).size:0,
    verifiedAt:new Date().toISOString(),verificationMs:performance.now()-start,readOnly:true,previousWriterExited:true,
    meaning:"Rows are visible from an independent read-only connection after the budget-failed writer exited. The final complete batch is committed; no claim of a complete 100k build."};
  fs.writeFileSync(path.join(directory,"verification.json"),JSON.stringify(report,null,2),{flag:"wx"});
  console.log(JSON.stringify(report));
} finally {db.close();}
