import assert from "node:assert/strict";
import test from "node:test";
import { RabiCordisHost } from "./cordisHost.js";

test("RabiCordisHost activates and disposes plugin effects with their Fiber", async () => {
  const host = new RabiCordisHost();
  let activeEffects = 0;

  const fiber = await host.mount({
    name: "test:effect",
    apply(ctx) {
      ctx.effect(() => {
        activeEffects += 1;
        return () => {
          activeEffects -= 1;
        };
      }, "test effect");
    }
  });

  assert.equal(activeEffects, 1);
  await fiber.dispose();
  assert.equal(activeEffects, 0);
  await host.dispose();
});

test("RabiCordisHost root disposal unloads every mounted Fiber", async () => {
  const host = new RabiCordisHost();
  const active = new Set<string>();

  for (const id of ["first", "second"]) {
    await host.mount({
      name: `test:${id}`,
      apply(ctx) {
        ctx.effect(() => {
          active.add(id);
          return () => {
            active.delete(id);
          };
        }, `test ${id}`);
      }
    });
  }

  assert.deepEqual([...active].sort(), ["first", "second"]);
  await host.dispose();
  assert.deepEqual([...active], []);
});
