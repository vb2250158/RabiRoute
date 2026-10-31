import assert from "node:assert/strict";
import test from "node:test";
import { personaPeerRequestAllowed } from "./personaPeerService.js";

test("authenticated persona alias accepts Manager operations without a hidden feature policy", () => {
  for (const path of ["/meta", "/gateways", "/api/settings", "/api/roles/Example/plans", "/api/agent/threads", "/api/roles/Example/skills/skill/files/doc"])
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
      assert.equal(personaPeerRequestAllowed({ method, path }), true);
  assert.equal(personaPeerRequestAllowed({ method: "GET", path: "/events", upgrade: true }), true);
  assert.equal(personaPeerRequestAllowed({ method: "GET", path: "/gateways", redirect: true }), true);
});

test("persona alias retains transport path parsing", () => {
  for (const path of ["/api/roles/Example/../../meta", "/api/roles/Example%2fOther/persona-reference", "//other/meta", "/meta#fragment", "/meta%00", "/meta%invalid"])
    assert.equal(personaPeerRequestAllowed({ method: "GET", path }), false, path);
});
