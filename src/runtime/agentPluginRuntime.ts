import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { AgentAdapterHostPorts } from "@rabiroute/plugin-sdk";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile, parsePluginManifest, type LoadedPluginProfile, type PluginGeneration, type PluginHost } from "../plugin-kernel/index.js";
import { PluginProfileSettings, type PluginProfileSettingsSnapshot } from "../plugin-runtime-host/profileSettings.js";
import { PluginProfilePublication } from "../manager/pluginProfilePublication.js";
import { loadInstalledAgentManagerDescriptors } from "../manager/agentManagerProviders.js";
import { publishedAgentAdapterProviders } from "./agentAdapterProviders.js";
import { installAgentAdapterManifestReader, type AgentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import { pluginStorageMigrationFailure } from "../shared/pluginStorage.js";
import { applicationRuntimeLayout } from "../shared/runtimeLayout.js";
export type AgentPluginRuntimeOptions = Readonly<{
    host: Extract<PluginHost, "manager" | "gateway">;
    profilePath: string;
    settingsRoot: string;
    packageRoots: readonly string[];
    runtimeRoot: string;
    stateRoot?: string;
    migrationsPath?: string;
    hostPorts: AgentAdapterHostPorts;
    watch?: boolean;
    /** Whole application lifetime only; individual requests do not own the shared catalog. */
    signal?: AbortSignal;
}>;
/** Loads the Agent subgraph inside an existing application, including the remote node. */
export async function mountAgentPluginRuntime(options: AgentPluginRuntimeOptions): Promise<{
    current(): PluginGeneration;
    reconcile(): Promise<void>;
    diagnostics(): PluginProfileSettingsSnapshot["diagnostics"];
    dispose(): Promise<void>;
}> {
    const settings = new PluginProfileSettings({ profilePath: options.profilePath, settingsRoot: options.settingsRoot, migrationsPath: options.migrationsPath });
    const stateRoot = options.stateRoot ?? options.hostPorts.environment?.RABIROUTE_STATE_ROOT ?? applicationRuntimeLayout().stateRoot;
    const catalog = new PluginPackageCatalog(options.packageRoots);
    const kernel = new GenerationRuntime({ host: options.host, hostServices: [{ capability: "host.agent-adapters@1", value: options.hostPorts }] });
    const publication = new PluginProfilePublication();
    let declaredManifests: AgentAdapterManifest[] = [];
    const releaseManifests = installAgentAdapterManifestReader(() => {
        const declarations = new Map(declaredManifests.map(manifest => [manifest.type, manifest]));
        for (const provider of publishedAgentAdapterProviders(kernel.current()).values())
            declarations.set(provider.type, provider.manifest as AgentAdapterManifest);
        return [...declarations.values()];
    });
    let previous: LoadedPluginProfile | undefined, closing = false;
    let diagnostics: Array<PluginProfileSettingsSnapshot["diagnostics"][number]> = [];
    let tail = Promise.resolve(), disposal: Promise<void> | undefined, timer: NodeJS.Timeout | undefined;
    const watchers: FSWatcher[] = [];
    const assertCurrent = () => { options.signal?.throwIfAborted(); if (closing)
        throw new Error("Agent package preparation stopped during application shutdown."); };
    const reconcile = (): Promise<void> => {
        const pending = tail.then(async () => {
            assertCurrent();
            const snapshot = await settings.snapshot();
            assertCurrent();
            const metadata = await loadInstalledAgentManagerDescriptors(snapshot.profile, catalog);
            assertCurrent();
            declaredManifests = metadata.descriptors.map(descriptor => descriptor.manifest as AgentAdapterManifest);
            diagnostics = [...snapshot.diagnostics, ...metadata.diagnostics];
            const instances = [];
            for (const instance of snapshot.profile.instances) {
                assertCurrent();
                if (!instance.enabled)
                    continue;
                try {
                    const source = await catalog.resolve(instance.package, instance.version);
                    assertCurrent();
                    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(source.sourceRoot, "rabi.plugin.json"), "utf8")));
                    if (manifest.id !== instance.package || manifest.version !== instance.version)
                        throw new Error("Agent package identity does not match the profile.");
                    const knownAgent = previous?.candidates.some(candidate => candidate.instanceId === instance.id)
                        || manifest.provides.some(capability => capability.startsWith("agent.adapter."));
                    if (!manifest.entries[options.host]) {
                        if (knownAgent)
                            throw new Error("The Agent replacement removed its active host entry.");
                        continue;
                    }
                    let descriptor;
                    try {
                        descriptor = JSON.parse(await fs.readFile(path.join(source.sourceRoot, "agent-adapter.json"), "utf8"));
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !knownAgent)
                            continue;
                        throw error;
                    }
                    assertCurrent();
                    if (typeof descriptor.type !== "string" || descriptor.manifest?.type !== descriptor.type || !manifest.provides.includes(descriptor.capability))
                        throw new Error("Invalid Agent package descriptor.");
                    instances.push(instance);
                }
                catch (error) {
                    assertCurrent();
                    // A rejected replacement retains its verified prior package, exactly as the full host does.
                    if (previous?.candidates.some(candidate => candidate.instanceId === instance.id))
                        instances.push(instance);
                    diagnostics.push({ instanceId: instance.id, message: error instanceof SyntaxError ? "Invalid Agent package metadata JSON." : error instanceof Error ? error.message : String(error) });
                }
            }
            const next = await loadPluginProfile({ profilePath: options.profilePath, profile: { ...snapshot.profile, instances, readyRequires: [] }, packageCatalog: catalog, runtimeRoot: options.runtimeRoot,
                preparationFailure: (packageId, instanceId) => pluginStorageMigrationFailure(packageId, stateRoot, instanceId),
                host: options.host, previous, assertCurrent });
            assertCurrent();
            await kernel.switch(next.candidates, { readyRequires: [], beforePublish: assertCurrent });
            previous = publication.capture(next, kernel.current()).profile;
            diagnostics.push(...next.loadFailures.filter(failure => failure.error.code === "package_load_failed")
                .map(failure => ({ instanceId: failure.instanceId, message: failure.error.message })));
        });
        tail = pending.catch(() => { });
        return pending;
    };
    const dispose = (): Promise<void> => disposal ??= (async () => {
        closing = true;
        if (timer)
            clearTimeout(timer);
        for (const watcher of watchers)
            watcher.close();
        options.signal?.removeEventListener("abort", abort);
        const preparation = catalog.dispose();
        void preparation.catch(() => { });
        await tail;
        const results = await Promise.allSettled([kernel.shutdown(), preparation]);
        releaseManifests();
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length)
            throw new AggregateError(failures, "Agent package shutdown remains unconfirmed.");
    })();
    const abort = () => { void dispose().catch(() => { }); };
    try {
        options.signal?.addEventListener("abort", abort, { once: true });
        assertCurrent();
        if (options.watch !== false) {
            const changed = () => { if (closing || timer)
                return; timer = setTimeout(() => { timer = undefined; void reconcile().catch(error => { if (!closing)
                console.error("Agent package reconciliation failed", error); }); }, 30); timer.unref(); };
            for (const directory of options.packageRoots) {
                await fs.mkdir(directory, { recursive: true });
                watchers.push(watch(directory, { recursive: true }, changed));
            }
            await fs.mkdir(path.dirname(options.profilePath), { recursive: true });
            watchers.push(watch(path.dirname(options.profilePath), (_event, name) => { if (name === null || name.toString() === path.basename(options.profilePath))
                changed(); }));
            await fs.mkdir(options.settingsRoot, { recursive: true });
            watchers.push(watch(options.settingsRoot, changed));
        }
        await reconcile();
        return { current: () => kernel.current(), reconcile, diagnostics: () => diagnostics, dispose };
    }
    catch (error) {
        try {
            await dispose();
        }
        catch (cleanup) {
            throw new AggregateError([error, cleanup], "Agent package startup and rollback failed.");
        }
        throw error;
    }
}
