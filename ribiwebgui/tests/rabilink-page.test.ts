import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { rabiLinkDraftFromMeta, rabiLinkIdentityPatch, rabiLinkManagementUrl, rabiLinkTab } from "../src/rabiLinkPresentation";
import type { MetaPayload } from "../src/types";
import { createRabiLinkRefreshFence } from "../src/rabiLinkRefreshFence";

const source = (file: string) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
test("deferred pre-save read cannot replace the successful identity snapshot", async () => {
  const fence = createRabiLinkRefreshFence();
  let snapshot = "initial";
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  const oldRevision = fence.begin()!;
  const oldRead = oldResponse.then(() => { if (fence.accepts(oldRevision)) snapshot = "old"; });
  fence.setSaving(true);
  assert.equal(fence.begin(), undefined);
  snapshot = "saved";
  fence.setSaving(false);
  const current = fence.begin()!;
  if (fence.accepts(current)) snapshot = "saved-readback";
  releaseOld();
  await oldRead;
  assert.equal(snapshot, "saved-readback");
  const stale = fence.begin()!;
  const latest = fence.begin()!;
  assert.equal(fence.accepts(stale), false);
  assert.equal(fence.accepts(latest), true);
});
test("RabiLink tabs normalize query values without a second route", () => {
  assert.equal(rabiLinkTab("agents"), "agents");
  assert.equal(rabiLinkTab("config"), "config");
  for (const value of [undefined, ["config"], "invalid", "home"]) assert.equal(rabiLinkTab(value), "home");
});
test("management URL only accepts credential-free HTTP(S) server roots", () => {
  assert.equal(rabiLinkManagementUrl(" https://relay.example.com/ "), "https://relay.example.com/manage");
  assert.equal(rabiLinkManagementUrl("http://localhost:8080"), "http://localhost:8080/manage");
  for (const value of ["", "//relay.example.com", "javascript:alert(1)", "data:text/html,test", "https://user:password@relay.example.com", "https://relay.example.com?token=fake", "https://relay.example.com/#token", "https://relay.example.com/prefix/", "https://relay.example.com/manage", "invalid"]) {
    assert.equal(rabiLinkManagementUrl(value), "", value);
  }
});
test("identity draft never echoes stored tokens; blank token preserves server credential", () => {
  const meta: MetaPayload = { version: "test", githubUrl: "", managerPort: 0, rabiName: "Example PC", agentUploads: { maxFileMiB: 128 }, rabiLinkRelay: { token: "fake-stored-secret", tokenConfigured: true, enabled: true, claimWaitMs: 0, speechServiceUrl: "http://localhost:8081" } };
  const draft = rabiLinkDraftFromMeta(meta);
  assert.equal(draft.token, "");
  assert.equal(draft.claimWaitMs, 0);
  const patch = rabiLinkIdentityPatch(draft);
  assert.equal("token" in patch.rabiLinkRelay, false);
  assert.equal(patch.agentUploads.maxFileMiB, 128);
  assert.equal(patch.rabiLinkRelay.speechServiceUrl, "http://localhost:8081");
  draft.token = " fake-new-secret ";
  assert.equal(rabiLinkIdentityPatch(draft).rabiLinkRelay.token, "fake-new-secret");
});
test("Settings retires identity editing; RabiLink has one persistent draft and legacy redirect", () => {
  assert.doesNotMatch(source("pages/SettingsPage.vue"), /api\/rabi\/identity|saveRabiIdentity|rabiLinkRelayAppToken|RabiRoute GUID/);
  const page = source("pages/RabiLinkPage.vue");
  assert.equal((page.match(/<RabiLinkSettings\b/g) || []).length, 1);
  assert.match(page, /<RabiLinkSettings v-show=/);
  assert.match(page, /<LanAgentsPage v-if="tab === 'agents'"/);
  assert.match(source("components/RabiLinkSettings.vue"), /registerPageSaveAction/);
  assert.match(source("components/RabiLinkSettings.vue"), /onBeforeRouteLeave/);
  assert.doesNotMatch(source("components/RabiLinkSettings.vue"), /store\.load|replaceDirtyConfig/);
  assert.match(source("router.ts"), /path: "\/lan-agents", redirect:.*path: "\/rabilink".*tab: "agents"/);
  assert.match(source("bundles/builtinWebContributions.ts"), /pages\/RabiLinkPage\.vue/);
});
test("native home replaces frames and keeps administration an independent login", () => {
  const page = source("pages/RabiLinkPage.vue");
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /需要使用服务器账号独立登录/);
  assert.match(page, /home\.phase === 'error'/);
  assert.match(page, /homeLoader\.dispose\(\)/);
  assert.match(page, /homeLoader\.invalidate\(\)/);
  assert.doesNotMatch(page, /iframe|frameAllowed|frameLoaded|setInterval|token=|authenticated\s*=/i);
  assert.doesNotMatch(source("rabiLinkPresentation.ts"), /rabiLinkFrameAllowed/);
});
