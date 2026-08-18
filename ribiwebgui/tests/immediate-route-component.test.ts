import assert from "node:assert/strict";
import test from "node:test";
import { defineComponent, type Component } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { createImmediateRouteComponent } from "../src/immediateRouteComponent";

test("route navigation completes before the page module resolves", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
  let resolvePage!: (component: Component) => void;
  const pageModule = new Promise<Component>(resolve => { resolvePage = resolve; });
  const loadingComponent = defineComponent({ name: "RouteLoadingTestPage", template: "<div>loading</div>" });
  const slowPage = createImmediateRouteComponent(() => pageModule, loadingComponent);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: defineComponent({ template: "<div>home</div>" }) },
      { path: "/slow", component: slowPage }
    ]
  });

  try {
    await router.push("/");
    await router.isReady();
    const navigation = router.push("/slow");
    const result = await Promise.race([
      navigation.then(() => "switched"),
      new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 30))
    ]);

    assert.equal(result, "switched");
    assert.equal(router.currentRoute.value.path, "/slow");
    assert.equal(warnings.some(message => message.includes("defineAsyncComponent")), false);
    resolvePage(defineComponent({ template: "<div>slow</div>" }));
  } finally {
    console.warn = originalWarn;
  }
});
