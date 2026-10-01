import assert from "node:assert/strict";
import test from "node:test";
import { personaPeerRequestAllowed } from "./personaPeerService.js";

test("persona transport permits documented owner reads and only the bound language-style check", () => {
  for (const path of ["/meta", "/api/personas", "/api/agent/help", "/api/roles/Example/persona-reference?file=persona.md",
    "/api/roles/%E4%BE%8B%E5%AD%90/knowledge/search?query=plan", "/api/roles/Example/plans", "/api/roles/Example/plans/plan-one",
    "/api/roles/Example/memory", "/api/roles/Example/memory/recent/memory-one", "/api/roles/Example/memory/consolidated/memory-one",
    "/api/roles/Example/skills", "/api/roles/Example/skills/skill-one"]) {
    assert.equal(personaPeerRequestAllowed({ method: "GET", path }), true, path);
  }
  const path = "/api/roles/Example/persona-reference/language-style";
  assert.equal(personaPeerRequestAllowed({ method: "POST", path }), true);
  assert.equal(personaPeerRequestAllowed({ method: "GET", path }), false);
});

test("persona transport rejects administration, writes, files, recursive proxying, upgrades and redirects", () => {
  for (const path of ["/gateways", "/api/settings", "/api/agent/threads", "/api/language-style/validate", "/api/roles/Example/persona-document",
    "/api/roles/Example/plans/plan-one/attachments/file-one", "/api/roles/Example/skills/skill-one/files/private",
    "/api/rabilink/peer/http/other/manager/meta", "/api/roles/Example/../../meta", "/api/roles/%2e%2e/../meta",
    "/api/roles/Example%2fOther/persona-reference", "/api/roles/Example%5cOther/persona-reference", "//other/meta", "/meta#fragment", "/meta%00", "/meta%invalid"]) {
    assert.equal(personaPeerRequestAllowed({ method: "GET", path }), false, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "CONNECT", "TRACE", "get"]) {
    assert.equal(personaPeerRequestAllowed({ method, path: "/meta" }), false, method);
  }
  assert.equal(personaPeerRequestAllowed({ method: "GET", path: "/meta", upgrade: true }), false);
  assert.equal(personaPeerRequestAllowed({ method: "GET", path: "/meta", redirect: true }), false);
});
