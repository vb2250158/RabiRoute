import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export async function buildPluginPackages(root = process.cwd()) {
  const sourceRoot = path.join(root, "plugins");
  const outputRoot = path.join(root, "dist", "plugins");
  const packagesRoot = path.join(outputRoot, "packages");
  const profilesRoot = path.join(outputRoot, "profiles");
  const profilePath = path.join(sourceRoot, "profiles", "desktop.json");
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  if (profile?.schemaVersion !== 1 || !Array.isArray(profile.instances)) throw new Error("Plugin profile is invalid.");

  const stageRoot = path.join(root, "dist", `.plugin-build-${process.pid}-${Date.now()}`);
  const stagedPackagesRoot = path.join(stageRoot, "packages");
  const stagedProfilesRoot = path.join(stageRoot, "profiles");
  const copied = [];
  const desired = new Map();

  await fs.rm(stageRoot, { recursive: true, force: true });
  try {
    await fs.mkdir(stagedProfilesRoot, { recursive: true });
    await fs.copyFile(profilePath, path.join(stagedProfilesRoot, "desktop.json"));

    for (const instance of profile.instances) {
      if (!instance || typeof instance.package !== "string" || typeof instance.version !== "string") throw new Error("Plugin profile entry is invalid.");
      const encodedPackage = encodeURIComponent(instance.package);
      const source = path.join(sourceRoot, "builtin", encodedPackage, instance.version);
      const stagedTarget = path.join(stagedPackagesRoot, encodedPackage, instance.version);
      const manifest = JSON.parse(await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8"));
      if (manifest.id !== instance.package || manifest.version !== instance.version || manifest.schemaVersion !== 1) {
        throw new Error(`Plugin package identity mismatch: ${instance.id}.`);
      }
      if (!manifest.entries || manifest.hosts !== undefined || manifest.entry !== undefined || manifest.webEntry !== undefined) {
        throw new Error(`Plugin package uses a removed manifest shape: ${instance.id}.`);
      }
      await fs.mkdir(path.dirname(stagedTarget), { recursive: true });
      await fs.cp(source, stagedTarget, { recursive: true, force: true });
      const versions = desired.get(encodedPackage) ?? new Set();
      versions.add(instance.version);
      desired.set(encodedPackage, versions);
      copied.push(`${instance.package}@${instance.version}`);
    }

    const sdkSource = path.join(sourceRoot, "contracts", "plugin-sdk");
    await fs.cp(sdkSource, path.join(stageRoot, "contracts", "plugin-sdk"), { recursive: true, force: true });

    await fs.mkdir(packagesRoot, { recursive: true });
    await fs.mkdir(profilesRoot, { recursive: true });

    for (const [encodedPackage, versions] of desired) {
      const packageOutput = path.join(packagesRoot, encodedPackage);
      await fs.mkdir(packageOutput, { recursive: true });
      for (const version of versions) {
        const target = path.join(packageOutput, version);
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(path.join(stagedPackagesRoot, encodedPackage, version), target);
      }
    }

    for (const packageEntry of await fs.readdir(packagesRoot, { withFileTypes: true })) {
      if (!packageEntry.isDirectory()) continue;
      const versions = desired.get(packageEntry.name);
      const packageOutput = path.join(packagesRoot, packageEntry.name);
      if (!versions) {
        await fs.rm(packageOutput, { recursive: true, force: true });
        continue;
      }
      for (const versionEntry of await fs.readdir(packageOutput, { withFileTypes: true })) {
        if (versionEntry.isDirectory() && !versions.has(versionEntry.name)) {
          await fs.rm(path.join(packageOutput, versionEntry.name), { recursive: true, force: true });
        }
      }
    }

    const outputProfilePath = path.join(profilesRoot, "desktop.json");
    await fs.rm(outputProfilePath, { force: true });
    await fs.rename(path.join(stagedProfilesRoot, "desktop.json"), outputProfilePath);

    const contractsTarget = path.join(outputRoot, "contracts");
    await fs.rm(contractsTarget, { recursive: true, force: true });
    await fs.rename(path.join(stageRoot, "contracts"), contractsTarget);
  } finally {
    if (await pathExists(stageRoot)) await fs.rm(stageRoot, { recursive: true, force: true });
  }

  return Object.freeze({ outputRoot, packagesRoot, profilesRoot, copied: Object.freeze(copied) });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const result = await buildPluginPackages();
  console.log(`Built ${result.copied.length} plugin packages in ${path.relative(process.cwd(), result.outputRoot)}.`);
}
