import { createVideoContracts } from "./contracts.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { VideoService, VideoError } from "./service.mjs";
import { VideoModels } from "./models.mjs";
import { VideoAssets } from "./assets.mjs";
import { VideoProjects } from "./projects.mjs";
import { RemoteVideoCompute } from "./remoteCompute.mjs";
import { createVideoApiEvents, createVideoOperationsOwner } from "./apiOwner.mjs";

/** Candidate state is read-only; shared recovery and component preparation belong to the published activation. */
export function createVideoPluginLifecycle({ identity, signal, http, host, api, runtime, catalog }) {
  const events = createVideoApiEvents(catalog), registrations = [];
  let service, models, assets, computeAssets, prepared = false, published = false, ready = false;
  let retiring = false, closeFlight, startup;
  const preparations = new Set();
  const assertPreparing = () => {
    signal.throwIfAborted();
    if (retiring) throw new Error("Video preparation is retiring.");
  };
  const prepare = async operation => {
    assertPreparing();
    const completion = Promise.resolve().then(() => { assertPreparing(); return operation(); });
    preparations.add(completion);
    try { const value = await completion; assertPreparing(); return value; }
    finally { preparations.delete(completion); }
  };
  const publish = (name, data) => {
    if (!published || retiring) return;
    http.publishManagerEvent("plugin_event", { instanceId: identity.instanceId, name, data });
    events.publish(name, data);
  };
  const remote = () => new RemoteVideoCompute(runtime, catalog,
    (name, data) => { if (published && !retiring) http.publishManagerEvent("plugin_event", { instanceId: identity.instanceId, name, data }); }, service.jobs.values());
  const close = () => closeFlight ??= (async () => {
    retiring = true; ready = false;
    if (assets) assets.closed = true;
    if (computeAssets) computeAssets.closed = true;
    await Promise.allSettled([...preparations]);
    // A post-publication preparation may still own native I/O. Join it before
    // shutdown can save jobs or release this runtime's process leases.
    if (startup) await startup.catch(() => {});
    const settled = await Promise.allSettled([
      ...registrations.map(registration => Promise.resolve().then(() => registration.dispose())),
      Promise.resolve().then(() => events.close()), Promise.resolve().then(() => runtime.stopMediaProbe()),
      ...(models ? [Promise.resolve().then(() => models.close())] : []),
      Promise.resolve().then(() => service ? service.close() : runtime.stop())
    ]);
    const failure = settled.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  })();
  return Object.freeze({
    async prepare() {
      let stage = "native service snapshot";
      try {
        assertPreparing();
        service = new VideoService(runtime, catalog, publish);
        await prepare(() => service.initialize({ recover: false }));
        assets = new VideoAssets(runtime); service.assets = assets;
        computeAssets = new VideoAssets({ ...runtime, stateRoot: path.join(runtime.stateRoot, "compute"), inspectAsset: (id, kind, access) => runtime.inspectAsset(id, kind, access, true) });
        service.computeAssets = computeAssets; service.remote = remote();
        const projects = new VideoProjects(runtime);
        stage = "model snapshot";
        models = new VideoModels(runtime, catalog, () => publish("video.models", {})); await prepare(() => models.initialize());
        stage = "executable contracts";
        const assertReady = () => { if (!ready || retiring) throw new VideoError("视频服务正在准备或停止。", 503); };
        const nativeContext = { contracts: createVideoContracts(catalog), runtime, catalog, service, models, assets, computeAssets, projects, events, readJsonBody: http.readJsonBody, assertReady };
        const definitions = host.createOperations({ ...nativeContext, owner: createVideoOperationsOwner(nativeContext) });
        await prepare(async () => { registrations.push(await api.registerOperationsAsync(definitions.operations, signal)); });
        registrations.push(api.registerHttpProxies(definitions.proxies));
        prepared = true;
        return close;
      } catch (cause) {
        await close().catch(() => {});
        throw new Error(`Video activation failed during ${stage}.`, { cause });
      }
    },
    publication: Object.freeze({
      publish() {
        if (!prepared || retiring) throw new Error("Video activation must be prepared before publication.");
        published = true;
      },
      rollback() { published = false; ready = false; },
      afterPublish({ previousRetirement, signal }) {
        return startup ??= (async () => {
          await previousRetirement;
          const assertCurrent = () => { signal.throwIfAborted(); if (!published || retiring) throw new Error("Video activation is retiring."); };
          assertCurrent();
          // The previous owner can have completed or cancelled records after the
          // candidate snapshot. Never recover from that stale candidate copy.
          await service.initialize(); assertCurrent();
          await models.initialize(); assertCurrent();
          service.remote = remote();
          if (!runtime.readOnly) {
            await fs.mkdir(runtime.componentRoot, { recursive: true }); assertCurrent();
            await fs.copyFile(new URL("./inspect-media.py", import.meta.url), path.join(runtime.componentRoot, "inspect-media.py")); assertCurrent();
          }
          ready = true;
        })();
      },
      retire: close
    })
  });
}
