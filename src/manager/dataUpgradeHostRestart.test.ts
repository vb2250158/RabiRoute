import assert from "node:assert/strict";
import test from "node:test";
import { createDataUpgradeHostRestart } from "./dataUpgradeHostRestart.js";

const layout = { packageRoot: process.cwd(), stateRoot: process.cwd() };

test("one accepted operation submits one generation-fenced Host restart", async () => {
  const calls: string[][] = [];
  const restart = createDataUpgradeHostRestart({ layout, hosted: true, generation: () => "original-generation",
    run: async (_executable, arguments_) => {
      calls.push(arguments_);
      return { stdout: JSON.stringify({ ok: true, state: "healthy", applicationGenerationId: "original-generation" }) };
    }
  });
  const first = restart("original-operation");
  assert.equal(restart("original-operation"), first);
  await first;
  assert.deepEqual(calls, [["--command", "status", "--json"],
    ["--command", "restart", "--application-generation-id", "original-generation", "--json"]]);
  await assert.rejects(restart("different-operation"), /already requested/);
});

test("a stale generation prevents the lifecycle command", async () => {
  let calls = 0;
  const restart = createDataUpgradeHostRestart({ layout, hosted: true, generation: () => "original",
    run: async () => { calls++; return { stdout: JSON.stringify({ ok: true, state: "healthy", applicationGenerationId: "different" }) }; }
  });
  await assert.rejects(restart("operation"), error => Boolean(error && typeof error === "object" && "restartDispatched" in error && error.restartDispatched === false));
  assert.equal(calls, 1);
});

for (const failure of ["stale", "transport", "invalid-json"] as const) {
  test(`an explicit new confirmation can retry after ${failure} preflight without replaying a restart`, async () => {
    const calls: string[][] = [];
    const restart = createDataUpgradeHostRestart({ layout, hosted: true, generation: () => "original",
      run: async (_executable, arguments_) => {
        calls.push(arguments_);
        if (calls.length === 1) {
          if (failure === "transport") throw new Error("Status unavailable");
          if (failure === "invalid-json") return { stdout: "invalid" };
          return { stdout: JSON.stringify({ ok: true, state: "healthy", applicationGenerationId: "stale" }) };
        }
        return { stdout: JSON.stringify({ ok: true, state: "healthy", applicationGenerationId: "original" }) };
      }
    });
    await assert.rejects(restart("first-operation"), error => Boolean(error && typeof error === "object" && "restartDispatched" in error && error.restartDispatched === false));
    await restart("explicit-new-operation");
    assert.deepEqual(calls.map(arguments_ => arguments_[1]), ["status", "status", "restart"]);
  });
}

test("an uncertain command failure keeps its original operation and does not replay", async () => {
  let calls = 0;
  const restart = createDataUpgradeHostRestart({ layout, hosted: true, generation: () => "original",
    run: async () => {
      calls++;
      if (calls === 1) return { stdout: JSON.stringify({ ok: true, state: "healthy", applicationGenerationId: "original" }) };
      throw new Error("Command process retired with the original Job");
    }
  });
  await assert.rejects(restart("operation"), error => Boolean(error && typeof error === "object" && "restartDispatched" in error && error.restartDispatched === true));
  await assert.rejects(restart("operation"), /uncertain/);
  assert.equal(calls, 2);
});

test("source-mode data upgrades do not start another Host", async () => {
  let calls = 0;
  const restart = createDataUpgradeHostRestart({ layout, hosted: false, generation: () => "original",
    run: async () => { calls++; return { stdout: "{}" }; }
  });
  await assert.rejects(restart("operation"), /through its Host/);
  assert.equal(calls, 0);
});
