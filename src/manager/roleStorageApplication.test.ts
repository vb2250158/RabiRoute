import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { storageRevisionToken } from "../shared/storageRevision.js";
import {
  RoleStorageApplication,
  RoleStorageApplicationError,
  roleStorageHttpError,
  type RoleStorageApplicationOptions
} from "./roleStorageApplication.js";
import { ManagerStorageMutationError } from "./managerStorageMutationPool.js";

test("role storage recent-memory read-after-write uses one stable view event per call", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-storage-touch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  let currentIdentity: { applicationGenerationId: string; managerInstanceId: string } | null = {
    applicationGenerationId: "touch-application-generation",
    managerInstanceId: "touch-manager-instance"
  };
  const application = new RoleStorageApplication({
    rolesRoot,
    ...currentIdentity,
    currentIdentity: () => currentIdentity
  });
  t.after(() => application.stop());

  const created = await application.commands.createRecentMemory("YeYu", {
    id: "application-touch-memory",
    title: "Application touch",
    focus: "Read through a fenced mutation",
    content: "Each logical view owns one event id.",
    keywords: ["application", "touch"]
  }, { idempotencyKey: "application-touch-create" });
  assert.equal(created.projection.memory.viewedAt, undefined);

  const first = await application.commands.touchRecentMemory("YeYu", "application-touch-memory");
  const second = await application.commands.touchRecentMemory("YeYu", "application-touch-memory");
  assert.notEqual(first.operationId, second.operationId);
  assert.notEqual(first.commit.storageRevision, second.commit.storageRevision);
  assert.equal(first.commit.updatedAt, created.commit.updatedAt);
  assert.equal(second.commit.updatedAt, created.commit.updatedAt);
  assert.equal(first.projection.memory.id, first.commit.id);
  assert.equal(first.projection.memory.viewedAt, first.commit.viewedAt);
  assert.equal(first.projection.revision, storageRevisionToken(first.commit));
  assert.equal(second.projection.memory.id, second.commit.id);
  assert.equal(second.projection.memory.viewedAt, second.commit.viewedAt);
  assert.equal(second.projection.revision, storageRevisionToken(second.commit));

  const explicit = await application.commands.touchRecentMemory("YeYu", "application-touch-memory", {
    idempotencyKey: "application-touch-explicit"
  });
  const replay = await application.commands.touchRecentMemory("YeYu", "application-touch-memory", {
    idempotencyKey: "application-touch-explicit"
  });
  assert.equal(replay.operationId, explicit.operationId);
  assert.deepEqual(replay.commit, explicit.commit);

  currentIdentity = null;
  await assert.rejects(
    application.commands.touchRecentMemory("YeYu", "application-touch-memory"),
    (error: unknown) => error instanceof RoleStorageApplicationError && error.code === "generation_mismatch"
  );
});

test("active-child failures expose an unknown commit state and same-key-only retry", async () => {
  const uncertainCodes = [
    "timeout",
    "aborted",
    "worker_failed",
    "termination_unconfirmed",
    "fence_mismatch"
  ] as const;

  for (const code of uncertainCodes) {
    const mutationPool = {
      status: () => ({
        state: "idle",
        active: 0,
        queued: 0,
        spawnedChildren: 0,
        applicationGenerationId: "uncertain-application-generation",
        managerInstanceId: "uncertain-manager-instance",
        storageGenerationLease: "uncertain-storage-generation"
      }),
      stop: async () => undefined,
      createRecentMemory: async () => {
        throw new ManagerStorageMutationError("private child diagnostic", code);
      }
    } as unknown as NonNullable<RoleStorageApplicationOptions["mutationPool"]>;
    const application = new RoleStorageApplication({
      rolesRoot: "C:/example/roles",
      applicationGenerationId: "uncertain-application-generation",
      managerInstanceId: "uncertain-manager-instance",
      mutationPool
    });

    await assert.rejects(
      application.commands.createRecentMemory("ExampleRole", {
        title: "Uncertain memory",
        focus: "Preserve the idempotency key",
        content: "The child may have committed before its response was lost.",
        keywords: ["idempotency"]
      }, { idempotencyKey: `uncertain-${code}` }),
      (error: unknown) => {
        const response = roleStorageHttpError(error);
        assert.equal(response.statusCode, 503, code);
        assert.equal(response.body.commitState, "unknown", code);
        assert.equal(response.body.retry, "same_idempotency_key_only", code);
        assert.equal(response.body.idempotencyKey, `uncertain-${code}`, code);
        assert.doesNotMatch(JSON.stringify(response), /private child diagnostic/);
        return true;
      }
    );
  }
});
