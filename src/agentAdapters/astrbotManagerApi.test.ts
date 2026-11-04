import assert from "node:assert/strict";
import test from "node:test";
import { scanAstrbotViaDashboardApi } from "./astrbotManagerApi.js";

test("AstrBot isolates malformed project and session rows while retaining native IDs and project relations", async t => {
  const projects = [{ project_id: "pa", title: "Workspace A" }, null, { project_id: "pb", title: "Workspace B" }, { project_id: "private-bad", title: { secret: "must-not-echo" } }];
  const sessions = [{ session_id: "sa", display_name: "A" }, null, { session_id: "sb", display_name: "B" }];
  const original = JSON.stringify({ projects, sessions });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    const data = url.includes("private-bad") ? [] : url.includes("get_sessions") ? [{ session_id: url.includes("pa") ? "sa" : "sb" }, null, { session_id: url.includes("pa") ? "extra-a" : "extra-b", display_name: "Extra" }]
      : url.includes("chatui_project/list") ? projects : sessions;
    return new Response(JSON.stringify({ status: "ok", data }), { status: 200 });
  });
  const result = await scanAstrbotViaDashboardApi("http://fixture.invalid", "user", "fixture-token");
  assert.deepEqual(result.projects.map(row => row.id), ["pa", "pb", "private-bad"]);
  assert.deepEqual(result.sessions.map(row => [row.id, row.projectId]), [["sa", "pa"], ["sb", "pb"], ["extra-a", "pa"], ["extra-b", "pb"]]);
  assert.equal(result.source, "api");
  assert.equal(result.authVerified, true);
  assert.ok(result.warnings?.length);
  assert.doesNotMatch(JSON.stringify(result), /must-not-echo|fixture-token/);
  assert.equal(urls.length, 5, "valid native project IDs remain queryable when a display field is invalid");
  assert.equal(JSON.stringify({ projects, sessions }), original);
});

for (const response of ["unauthorized", "invalid-catalog"] as const) {
  test(`AstrBot reports ${response} as an actual owner failure`, async t => {
    t.mock.method(globalThis, "fetch", async () => response === "unauthorized"
      ? new Response("private-response-must-not-echo", { status: 401 })
      : new Response(JSON.stringify({ status: "ok", data: { secret: "private-response-must-not-echo" } }), { status: 200 }));
    await assert.rejects(scanAstrbotViaDashboardApi("http://fixture.invalid", "user", "token"), error => {
      assert.doesNotMatch(String(error), /private-response-must-not-echo|token/);
      return response === "unauthorized" ? /401/.test(String(error)) : /invalid/i.test(String(error));
    });
  });
}

for (const failure of ["server", "invalid-json", "invalid-array"] as const) {
  test(`AstrBot retains the top-level directory and another project after one association ${failure} failure`, async t => {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("get_sessions?project_id=pa")) return failure === "server" ? new Response("private", { status: 500 })
        : failure === "invalid-json" ? new Response("private broken JSON", { status: 200 })
        : new Response(JSON.stringify({ status: "ok", data: { private: true } }), { status: 200 });
      const data = url.includes("chatui_project/list") ? [{ project_id: "pa", title: "A" }, { project_id: "pb", title: "B" }]
        : url.includes("get_sessions") ? [{ session_id: "sb" }] : [{ session_id: "sa" }, { session_id: "sb" }];
      return new Response(JSON.stringify({ status: "ok", data }), { status: 200 });
    });
    const result = await scanAstrbotViaDashboardApi("http://fixture.invalid", "user", "token");
    assert.deepEqual(result.sessions.map(row => [row.id, row.projectId]), [["sa", undefined], ["sb", "pb"]]);
    assert.ok(result.warnings?.some(warning => /associations/.test(warning)));
  });
}

test("AstrBot project association authentication failure remains a real owner failure", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input).includes("get_sessions")
    ? new Response("private", { status: 403 })
    : new Response(JSON.stringify({ status: "ok", data: String(input).includes("chatui_project/list") ? [{ project_id: "pa" }] : [{ session_id: "sa" }] }), { status: 200 }));
  await assert.rejects(scanAstrbotViaDashboardApi("http://fixture.invalid", "user", "token"), /403/);
});
