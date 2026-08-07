import assert from "node:assert/strict";
import test from "node:test";
import {
  createLazyRouteRecovery,
  isLazyRouteLoadError,
  lazyRouteRecoveryUrl
} from "../src/lazyRouteRecovery";

test("recognizes only stale lazy-route asset failures", () => {
  assert.equal(isLazyRouteLoadError(new TypeError(
    "Failed to fetch dynamically imported module: http://127.0.0.1/assets/SpeechServicePage-old.js"
  )), true);
  assert.equal(isLazyRouteLoadError(new Error("Loading chunk 17 failed")), true);
  assert.equal(isLazyRouteLoadError(new Error("speech status request failed")), false);
});

test("builds a recovery URL for the intended Route while preserving hash access parameters", () => {
  assert.equal(
    lazyRouteRecoveryUrl(
      "http://192.168.0.57:8790/#/routes/main/overview?webgui_token=secret&view=current",
      "/routes/main/speech"
    ),
    "http://192.168.0.57:8790/#/routes/main/speech?webgui_token=secret"
  );
});

test("recovers a failed lazy Route once and clears the loop guard only after a ready page", () => {
  const values = new Map<string, string>();
  const replacements: string[] = [];
  let reloads = 0;
  const recovery = createLazyRouteRecovery({
    location: {
      href: "http://127.0.0.1:8790/#/routes/main/overview?webgui_token=secret",
      reload: () => { reloads += 1; },
      replace: value => { replacements.push(value); }
    },
    sessionStorage: {
      getItem: key => values.get(key) ?? null,
      removeItem: key => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); }
    }
  });
  const error = new TypeError("Failed to fetch dynamically imported module: SpeechServicePage-old.js");

  assert.equal(recovery.recover(error, "/routes/main/speech"), true);
  assert.deepEqual(replacements, [
    "http://127.0.0.1:8790/#/routes/main/speech?webgui_token=secret"
  ]);
  assert.equal(reloads, 1);
  assert.equal(recovery.recover(error, "/routes/main/speech"), false);

  recovery.markReady();
  assert.equal(recovery.recover(error, "/routes/main/speech"), true);
  assert.equal(replacements.length, 2);
  assert.equal(reloads, 2);
  recovery.dispose();
});
