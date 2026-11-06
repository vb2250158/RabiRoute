import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonaDocumentOwner } from "./personaDocumentRoutes.js";

function temporary(t:test.TestContext) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rabiroute-persona-document-"));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith("rabiroute-persona-document-"));fs.rmSync(directory,{recursive:true,force:true});});return directory;
}
const request=()=>new http.IncomingMessage(new Socket());
test("reads one bounded Markdown file from the selected original role",t=>{
  const directory=temporary(t);fs.writeFileSync(path.join(directory,"persona.md"),"# Example\n\n正文","utf8");
  const owner=createPersonaDocumentOwner({roleDirectory:()=>directory});
  assert.equal(owner.prepare(request(),"Example").read("persona.md").toString("utf8"),"# Example\n\n正文");
});
test("rejects paths and non-Markdown files without reading another resource",t=>{
  const directory=temporary(t),owner=createPersonaDocumentOwner({roleDirectory:()=>directory});
  assert.throws(()=>owner.prepare(request(),"Example").read("../secret.md"),{statusCode:400});
  assert.throws(()=>owner.prepare(request(),"Example").read("secret.txt"),{statusCode:400});
});

test("local persona documents above the former 2 MiB limit remain complete",t=>{
  const directory=temporary(t);const content="x".repeat(3*1024*1024);fs.writeFileSync(path.join(directory,"persona.md"),content);
  const owner=createPersonaDocumentOwner({roleDirectory:()=>directory});
  assert.equal(owner.prepare(request(),"Example").read("persona.md").toString("utf8"),content);
});
