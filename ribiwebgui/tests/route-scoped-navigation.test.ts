import assert from "node:assert/strict";
import test from "node:test";
import {
  routeKeyFromWebguiHash,
  routeScopedKnowledgePath,
  routeScopedKnowledgeUrl,
  routeScopedOverviewPath,
  routeScopedOverviewUrl
} from "../src/routeScopedNavigation";
import { lanWebguiRedirectUrl } from "../src/webguiLanRedirect";

test("builds Route-scoped overview and knowledge paths from a config name", () => {
  assert.equal(routeScopedOverviewPath("main route"), "/routes/main%20route/overview");
  assert.equal(routeScopedKnowledgePath("main route"), "/routes/main%20route/knowledge");
  assert.equal(routeScopedOverviewPath(""), "/overview");
  assert.equal(routeScopedKnowledgePath(""), "/knowledge");
});

test("recognizes the selected Route on scoped overview, configuration, persona, and knowledge pages", () => {
  assert.equal(routeKeyFromWebguiHash("#/routes/main/overview?webgui_token=secret"), "main");
  assert.equal(routeKeyFromWebguiHash("#/routes/main/knowledge?webgui_token=secret"), "main");
  assert.equal(routeKeyFromWebguiHash("#/routes/main"), "main");
  assert.equal(routeKeyFromWebguiHash("#/persona/%E6%98%9F%E6%B5%B7"), "星海");
  assert.equal(routeKeyFromWebguiHash("#/knowledge"), "");
});

test("replaces the WebGUI page while preserving the access key", () => {
  assert.equal(
    routeScopedOverviewUrl(
      "http://192.168.0.57:8790/#/overview?webgui_token=secret",
      "main route"
    ),
    "http://192.168.0.57:8790/#/routes/main%20route/overview?webgui_token=secret"
  );
  assert.equal(
    routeScopedKnowledgeUrl(
      "http://192.168.0.57:8790/#/overview?webgui_token=secret&view=current",
      "main route"
    ),
    "http://192.168.0.57:8790/#/routes/main%20route/knowledge?webgui_token=secret&view=current"
  );
});

test("redirects loopback WebGUI URLs to the LAN origin while preserving Route and page", () => {
  assert.equal(
    lanWebguiRedirectUrl(
      "http://127.0.0.1:8790/#/routes/Rabi/knowledge?view=current",
      "http://192.168.0.57:8790/#/overview?webgui_token=old",
      "secret"
    ),
    "http://192.168.0.57:8790/#/routes/Rabi/knowledge?view=current&webgui_token=secret"
  );
  assert.equal(
    lanWebguiRedirectUrl(
      "http://localhost:8790/#/routes/XinghaiBuilder-main/overview",
      "http://192.168.0.57:8790/#/overview",
      "secret"
    ),
    "http://192.168.0.57:8790/#/routes/XinghaiBuilder-main/overview?webgui_token=secret"
  );
});

test("does not redirect an already-LAN WebGUI URL", () => {
  assert.equal(
    lanWebguiRedirectUrl(
      "http://192.168.0.57:8790/#/routes/Rabi/overview",
      "http://192.168.0.57:8790/#/overview",
      "secret"
    ),
    ""
  );
});
