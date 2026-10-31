import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";

const packageRoot = path.resolve(process.env.RABIROUTE_HOT_PATCH_TEST_PACKAGE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const fixtureSourceRoot = path.resolve(process.env.RABIROUTE_HOT_PATCH_TEST_SOURCE_ROOT || packageRoot);

test("built Manager keeps its identity while discovering modules and updating source, resources and documentation", { timeout: 300000 }, async context => {
  const startedAt = Date.now();
  const checkpoint = label => context.diagnostic(`${label}; elapsedMs=${Date.now() - startedAt}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-built-source-patch-"));
  const stateRoot = path.join(root, "state");
  const sourceRoot = path.join(root, "sources");
  const profile = path.join(root, "profile.json");
  const applicationGenerationId = randomUUID();
  const controlToken = randomUUID();
  await fs.mkdir(stateRoot);
  await fs.mkdir(sourceRoot);
  for (const name of ["roles", "routes", "appdata", "localappdata", "home", "userprofile"]) await fs.mkdir(path.join(root, name));
  await fs.writeFile(profile, JSON.stringify({ schemaVersion: 2, readyRequires: ["manager.core@1", "manager.diagnostics@1"],
    instances: ["core", "diagnostics"].map(name => ({ id: `manager:${name}`, package: `io.rabiroute.manager.${name}`, version: "1.0.0", enabled: true, config: {}, grants: [] })) }));
  const sourcePath = path.join(fixtureSourceRoot, "src/manager/pluginCatalogPresentation.ts");
  const sourceBytes = await fs.readFile(sourcePath);
  const catalog = JSON.parse(await fs.readFile(path.join(packageRoot, "dist/automatic-code/catalog.json"), "utf8"));
  const baselineModule = catalog.modules.find(entry => entry.sourcePath === "src/manager/pluginCatalogPresentation.ts");
  assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), baselineModule?.sourceHash,
    "The test fixture source must match the target package's plugin catalog presentation baseline.");
  const source = sourceBytes.toString("utf8");
  const compiled = compileHotPatchModule(source.replace('host || "all"', 'host || "web"'),
    sourcePath);
  const bytes = JSON.stringify(compiled);
  const candidateSha256 = createHash("sha256").update(bytes).digest("hex");
  checkpoint("source candidate compiled");
  const candidates = path.join(stateRoot, "data/.runtime/source-patches/candidates");
  await fs.mkdir(candidates, { recursive: true });
  await fs.writeFile(path.join(candidates, `${candidateSha256}.json`), bytes);
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object" && address.port > 0);
  const requestedPort = address.port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const entry = pathToFileURL(path.join(packageRoot, "dist/manager/controlPlaneRoutes.js")).href;
  const worker = spawn(process.execPath, ["--input-type=module", "--eval", `const {startManager}=await import(${JSON.stringify(entry)}); await startManager();`], {
    cwd: stateRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      HOME: path.join(root, "home"), USERPROFILE: path.join(root, "userprofile"),
      GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: String(requestedPort), GATEWAY_MANAGER_URL: "",
      RABIROUTE_APPLICATION_GENERATION_ID: applicationGenerationId,
      RABIROUTE_HOST_CONTROL_TOKEN: controlToken, RABIROUTE_HOSTED: "1",
      RABIROUTE_MANAGER_AUTOSTART: "0", RABIROUTE_MANAGER_READ_ONLY: "0", REMOTE_AGENT_DISCOVERABLE: "0",
      RABIROUTE_PACKAGE_ROOT: packageRoot, RABIROUTE_STATE_ROOT: stateRoot,
      RABIROUTE_HOT_PATCH_SOURCE_ROOT: sourceRoot, RABIROUTE_HOT_PATCH_WATCH: "1",
      RABIROUTE_PLUGIN_PROFILE: profile, RABIROUTE_PLUGIN_PACKAGE_ROOTS: path.join(packageRoot, "dist/plugins/packages"),
      ROLES_DIR: path.join(root, "roles"), ROUTE_DIR: path.join(root, "routes")
    }
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
  worker.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
  const exited = once(worker, "exit");
  let ready;
  let polling = true;
  let pollingWork;
  let pollError;
  let healthReads = 0;
  const failures = [];
  const request = async (endpoint, body) => {
    const response = await fetch(ready.baseUrl + endpoint, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(10000),
      headers: body ? { "content-type": "application/json", "x-rabiroute-host-token": controlToken } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify({ endpoint, status: response.status, value }));
    return { response, value };
  };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); worker.stdout.off("data", inspect); worker.off("exit", stopped);
        if (error) reject(error); else resolve();
      };
      const stopped = () => finish(new Error(`Manager exited before READY: ${stdout}\n${stderr}`));
      const inspect = () => {
        // Inspect complete records only; stdout chunks can split the READY JSON.
        const lines = stdout.split(/\r?\n/); lines.pop();
        const line = lines.find(value => value.startsWith("RABIROUTE_MANAGER_READY:"));
        if (line) {
          try { ready = JSON.parse(line.slice("RABIROUTE_MANAGER_READY:".length)); finish(); }
          catch (error) { finish(error); }
        } else if (worker.exitCode !== null || worker.signalCode !== null) stopped();
      };
      const timer = setTimeout(() => finish(new Error(`Manager READY observation deadline; pid=${worker.pid}, exit=${worker.exitCode}, signal=${worker.signalCode}: ${stdout}\n${stderr}`)), 60000);
      worker.stdout.on("data", inspect); worker.once("exit", stopped); inspect();
    });
    assert.equal(ready.applicationGenerationId, applicationGenerationId);
    assert.equal(ready.pid, worker.pid);
    assert.equal(new URL(ready.baseUrl).hostname, "127.0.0.1");
    assert.equal(Number(new URL(ready.baseUrl).port), requestedPort);
    const initial = (await request("/meta")).value;
    assert.equal(initial.managerInstanceId, ready.managerInstanceId);
    assert.equal(initial.health.requiredReady, true);
    checkpoint("built Manager requiredReady");
    const builtHtml = await fs.readFile(path.join(packageRoot, "ribiwebgui/dist/index.html"), "utf8");
    const scriptSource = builtHtml.match(/<script[^>]*src="([^"]+)"/)?.[1];
    assert.ok(scriptSource, "The built root document must reference its hashed script.");
    const rootResponse = await fetch(`${ready.baseUrl}/`, { signal: AbortSignal.timeout(10000) });
    assert.equal(rootResponse.status, 200, "Built Manager root document must be available.");
    const servedHtml = await rootResponse.text();
    const servedScript = servedHtml.match(/<script[^>]*src="([^"]+)"/)?.[1];
    assert.ok(servedScript?.endsWith(scriptSource.replace(/^\.\//, "")), "Manager did not serve the newly built root document.");
    checkpoint("built root document verified");
    const bundleResponse = await fetch(new URL(servedScript, `${ready.baseUrl}/`), { signal: AbortSignal.timeout(10000) });
    assert.equal(bundleResponse.status, 200);
    const bundleBytes = await fs.readFile(path.join(packageRoot, "ribiwebgui/dist", scriptSource));
    assert.equal(createHash("sha256").update(Buffer.from(await bundleResponse.arrayBuffer())).digest("hex"), createHash("sha256").update(bundleBytes).digest("hex"));
    checkpoint("built root script hash verified");
    const before = await request("/api/plugins/catalog");
    assert.equal(before.value.data.host, "all");
    checkpoint("initial plugin catalog verified");
    const beforeStatus = (await request("/api/source-patches")).value.data;
    const module = beforeStatus.modules.find(entry => entry.id === "manager.plugin-catalog");
    const sourcePid = module.active.pid;
    const originalSource = module.active.snapshot.sourceHash;
    pollingWork = (async () => {
      while (polling) {
        const health = (await request("/health")).value;
        assert.equal(health.health.live, true);
        assert.equal(health.health.requiredReady, true);
        healthReads++;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })().catch(error => { pollError = error; });
    const publication = {
      operationId: randomUUID(), action: "apply", moduleId: "manager.plugin-catalog", expectedRevision: 0,
      applicationGenerationId, managerInstanceId: ready.managerInstanceId, pluginGenerationId: initial.pluginGeneration.id,
      candidateSha256, contract: { schema: 2, description: "patched catalog" }
    };
    const applied = (await request("/_rabiroute/host/source-patches", publication)).value.data;
    assert.equal(applied.commitState, "committed");
    assert.equal(applied.result.pid, sourcePid);
    assert.equal(applied.result.snapshot.sourceHash, compiled.sourceHash);
    const changed = await request("/api/plugins/catalog");
    assert.equal(changed.value.data.host, "web");
    assert.equal(changed.response.headers.get("x-rabiroute-source-revision"), "1");
    const contract = { schema: 2, description: "clarified catalog" };
    const described = (await request("/_rabiroute/host/source-patches", {
      ...publication, operationId: randomUUID(), expectedRevision: 1, contract
    })).value.data;
    assert.equal(described.result.snapshot.revision, 2);
    assert.deepEqual(described.result.snapshot.contract, contract);
    const restored = (await request("/_rabiroute/host/source-patches", {
      ...publication, operationId: randomUUID(), action: "rollback", expectedRevision: 2
    })).value.data;
    assert.equal(restored.result.snapshot.revision, 3);
    assert.equal(restored.result.snapshot.contract.description, "patched catalog");
    assert.notEqual(originalSource, restored.result.snapshot.sourceHash);
    const sameOperation = (await request("/_rabiroute/host/source-patches", publication)).value.data;
    assert.equal(sameOperation.result.snapshot.revision, 1);
    checkpoint("source apply, receipt recovery and rollback verified");
    const sourceDirectory = path.join(sourceRoot, "source-patches");
    await fs.mkdir(sourceDirectory);
    const dynamicSource = `declare const __rabiResources: { text(path: string): string }; export function read() { return { label: 'first', resource: __rabiResources.text('source-patches/value.txt') }; }`;
    const dynamicPath = path.join(sourceDirectory, "dynamic.ts");
    await fs.writeFile(dynamicPath, dynamicSource);
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "first");
    await fs.writeFile(path.join(sourceDirectory, "modules.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "dynamic", source: "source-patches/dynamic.ts", resources: ["source-patches/value.txt"], contract: { label: "dynamic contract" } }] }));
    const waitDynamic = async revision => {
      const expires = Date.now() + 20000;
      while (Date.now() < expires) {
        const status = (await request("/api/source-patches")).value.data;
        const module = status.modules.find(entry => entry.id === "dynamic");
        if (module?.state === "ready" && module.active.snapshot.revision === revision) return module;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      assert.fail(`Dynamic module revision ${revision} unavailable: ${stderr}\n${stdout}`);
    };
    const registered = await waitDynamic(0);
    assert.equal(registered.active.snapshot.contract.label, "dynamic contract");
    const updatedSource = dynamicSource.replace("label: 'first'", "label: 'second'");
    await fs.writeFile(dynamicPath, updatedSource);
    const updated = await waitDynamic(1);
    assert.equal(updated.active.pid, registered.active.pid);
    assert.equal(updated.active.snapshot.sourceHash, compileHotPatchModule(updatedSource, dynamicPath).sourceHash);
    await fs.writeFile(path.join(sourceDirectory, "value.txt"), "second");
    const resourceUpdated = await waitDynamic(2);
    assert.equal(resourceUpdated.active.pid, registered.active.pid);
    assert.equal(resourceUpdated.active.snapshot.contract.resources["source-patches/value.txt"], createHash("sha256").update("second").digest("hex"));
    assert.equal((await request("/api/plugins/catalog")).value.data.host, "web");
    checkpoint("dynamic source and resource revisions verified");
    const webDeadline = Date.now() + 30000;
    let webBefore;
    do {
      webBefore = (await request("/api/web-patches")).value.data;
      if (webBefore.state === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < webDeadline);
    assert.equal(webBefore.state, "ready", JSON.stringify(webBefore));
    checkpoint("initial Web release ready");
    const webOutput = path.join(sourceRoot, "dist/web-patches");
    // Build outside the watched source tree, then publish one complete candidate atomically.
    const staging = path.join(root, "web-candidate-staging");
    assert.equal(path.dirname(path.resolve(staging)), path.resolve(root));
    assert.ok(path.resolve(webOutput).startsWith(path.resolve(root) + path.sep));
    await fs.mkdir(webOutput, { recursive: true });
    await fs.cp(path.join(stateRoot, "data/.runtime/web-patches/candidates", webBefore.active), staging, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(staging, "manifest.json"), "utf8"));
    const htmlPath = path.join(staging, "web/index.html");
    const html = (await fs.readFile(htmlPath, "utf8")).replace("<head>", '<head><meta name="web-patch-test" content="updated">');
    await fs.writeFile(htmlPath, html);
    const htmlRecord = manifest.files.find(file => file.path === "web/index.html");
    htmlRecord.size = Buffer.byteLength(html);
    htmlRecord.sha256 = createHash("sha256").update(html).digest("hex");
    const rawManifest = JSON.stringify(manifest);
    const webRevision = createHash("sha256").update(rawManifest).digest("hex");
    await fs.writeFile(path.join(staging, "manifest.json"), rawManifest);
    const publishedCandidate = path.resolve(webOutput, webRevision);
    assert.equal(path.dirname(publishedCandidate), path.resolve(webOutput));
    assert.equal(path.dirname(path.resolve(staging)), path.resolve(root));
    const renameDeadline = Date.now() + 3000;
    for (;;) {
      try { await fs.rename(staging, publishedCandidate); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || Date.now() >= renameDeadline) throw error;
        // Keep the same atomic publication. Never overwrite an existing candidate.
        try { await fs.access(publishedCandidate); throw error; }
        catch (probeError) { if (probeError?.code !== "ENOENT") throw probeError; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const webOperation = randomUUID();
    const marker = path.join(webOutput, "latest.json");
    await fs.writeFile(marker + ".tmp", JSON.stringify({ revision: webRevision, operationId: webOperation }));
    await fs.rename(marker + ".tmp", marker);
    const activationDeadline = Date.now() + 30000;
    let webAfter;
    do {
      webAfter = (await request("/api/web-patches")).value.data;
      if (webAfter.active === webRevision) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < activationDeadline);
    assert.equal(webAfter.active, webRevision, JSON.stringify(webAfter));
    checkpoint("Web candidate activated");
    assert.match(await (await fetch(`${ready.baseUrl}/`)).text(), /name="web-patch-test" content="updated"/);
    const oldAsset = await fetch(`${ready.baseUrl}/_rabiroute/web/${webBefore.active}/web/${scriptSource.replace(/^\.\//, "")}`);
    assert.equal(oldAsset.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await oldAsset.arrayBuffer())).digest("hex"), createHash("sha256").update(bundleBytes).digest("hex"));
    const modules = (await request(`/api/plugins/modules?webRelease=${webBefore.active}`)).value.data.modules;
    for (const module of modules) {
      assert.equal(module.rev, webBefore.active);
      const wrapper = await fetch(`${ready.baseUrl}/api/plugins/modules/${module.id}/${module.rev}/${module.entryPath}`);
      assert.equal(wrapper.status, 200);
      assert.match(await wrapper.text(), new RegExp(webBefore.active));
    }
    const rollback = (await request("/_rabiroute/host/web-patches", {
      ...webAfter.identity, operationId: randomUUID(), candidate: webBefore.active, expectedRevision: webAfter.revision
    })).value.data;
    assert.equal(rollback.state, "committed");
    assert.equal(rollback.active, webBefore.active);
    assert.equal((await request(`/api/web-patches/operations/${webOperation}`)).value.data.active, webRevision);
    const current = (await request("/meta")).value;
    assert.equal(current.applicationGenerationId, initial.applicationGenerationId);
    assert.equal(current.managerInstanceId, initial.managerInstanceId);
    assert.equal(current.pluginGeneration.id, initial.pluginGeneration.id);
    polling = false;
    await pollingWork;
    if (pollError) throw pollError;
    assert.ok(healthReads > 0);
    checkpoint("Web rollback and uninterrupted health verified");
  } catch (error) {
    failures.push(error);
    context.diagnostic(`Primary built Manager gate failure: ${error?.stack ?? String(error)}`);
    try {
      const marker = JSON.parse(await fs.readFile(path.join(sourceRoot, "dist/web-patches/latest.json"), "utf8"));
      context.diagnostic(`Web candidate marker: ${JSON.stringify({ revision: marker.revision, operationId: marker.operationId })}`);
      const logRoot = path.join(stateRoot, "logs/manager");
      const logs = (await fs.readdir(logRoot)).filter(name => /^manager-operations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
      if (logs.length) {
        const handle = await fs.open(path.join(logRoot, logs.at(-1)), "r");
        try {
          const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.min(size, 65536));
          await handle.read(buffer, 0, buffer.length, size - buffer.length);
          for (const line of buffer.toString("utf8").split(/\r?\n/)) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.event === "web_patch_marker_failed") context.diagnostic(`Web candidate failure: ${String(entry.result).replaceAll(controlToken, "[fixture-token]").slice(0, 2000)}`);
          }
        } finally { await handle.close(); }
      }
    } catch (diagnosticError) {
      context.diagnostic(`Web candidate diagnostic unavailable: ${String(diagnosticError).replaceAll(controlToken, "[fixture-token]")}`);
    }
  } finally {
    try {
      polling = false;
      await pollingWork;
      if (worker.exitCode === null && worker.signalCode === null && ready) {
        await request("/_rabiroute/host/shutdown", {}).catch(error => {
          failures.push(error);
          context.diagnostic(`Controlled fixture shutdown request failed: ${error?.stack ?? String(error)}`);
        });
        let timer;
        const completed = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); })]);
        clearTimeout(timer);
        if (!completed) worker.kill("SIGKILL");
      } else if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      const [exitCode, exitSignal] = await exited;
      assert.equal(exitCode, 0, `Manager must exit naturally with code 0: ${stderr}`);
      assert.equal(exitSignal, null, "Manager shutdown must not require a termination signal.");
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("rabi-built-source-patch-"));
      if (!failures.length) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
      context.diagnostic(`Built Manager fixture cleanup failed: ${error?.stack ?? String(error)}`);
    }
    if (failures.length) context.diagnostic(`Built Manager fixture diagnostic path: ${root}`);
  }
  if (failures.length > 1) throw new AggregateError(failures,
    `Built Manager gate failed: ${failures[0]?.message ?? String(failures[0])}; fixture cleanup also failed.`, { cause: failures[0] });
  if (failures.length) throw failures[0];
});
