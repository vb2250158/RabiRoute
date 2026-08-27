import assert from "node:assert/strict";
import test from "node:test";
import { retryRouteLoad } from "../src/routeLoadRetry";

test("route load retry reloads the current URL without rebuilding Route parameters", () => {
  let reloads = 0;
  retryRouteLoad({ reload: () => { reloads += 1; } });
  assert.equal(reloads, 1);
});
