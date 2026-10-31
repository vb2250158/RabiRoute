import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";

export type LanAgentReleaseFile = {
  path: string;
  sha256: string;
  size: number;
  downloadUrl: string;
};

export type LanAgentReleaseManifest = {
  version: string;
  platform: "node";
  minNodeVersion: string;
  files: LanAgentReleaseFile[];
  publicKey: string;
  publicKeySha256: string;
  signature: string;
};

type SigningKeyRecord = {
  publicKey: string;
  privateKey: string;
};

type ReleaseManifestPayload = Pick<LanAgentReleaseManifest, "version" | "platform" | "minNodeVersion" | "files">;
type CommonReleaseSelection = {
  schemaVersion: 1;
  releaseDigest: string;
  agentRoot: string;
  manifest: LanAgentReleaseManifest;
};
export class LanAgentReleaseSelectionConflictError extends Error {
  constructor() { super("Node release selection conflict; read the current publication before retrying."); }
}
const releaseHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function lanAgentReleasePublicKeySha256(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return sha256(der);
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid LAN Agent release asset path: ${value}`);
  }
  return normalized;
}

function manifestPayload(manifest: ReleaseManifestPayload): string {
  return JSON.stringify({
    version: manifest.version,
    platform: manifest.platform,
    minNodeVersion: manifest.minNodeVersion,
    files: manifest.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      downloadUrl: file.downloadUrl
    }))
  });
}

export function lanAgentReleaseManifestDigest(manifest: LanAgentReleaseManifest): string {
  return sha256(Buffer.from(manifestPayload(manifest)));
}

function readJson(filePath: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`LAN Agent release metadata is invalid: ${filePath}`);
  }
  return raw as Record<string, unknown>;
}

function readSigningKeys(filePath: string): SigningKeyRecord {
  if (fs.existsSync(filePath)) {
    const raw = readJson(filePath);
    return {
      publicKey: requiredString(raw.publicKey, "LAN Agent release publicKey"),
      privateKey: requiredString(raw.privateKey, "LAN Agent release privateKey")
    };
  }
  const pair = generateKeyPairSync("ed25519");
  const record: SigningKeyRecord = {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "lan-agent",
      event: "lan_agent_signing_key_create_failed",
      owner: "lan-agent-release",
      action: "create-signing-key",
      target: { type: "signing-key", id: "lan-agent-release" },
      dataSource: { kind: "file", id: path.basename(filePath) },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "lan-agent",
    event: "lan_agent_signing_key_created",
    owner: "lan-agent-release",
    action: "create-signing-key",
    target: { type: "signing-key", id: "lan-agent-release" },
    dataSource: { kind: "file", id: path.basename(filePath) },
    outcome: "committed",
    after: { digest: lanAgentReleasePublicKeySha256(record.publicKey) }
  });
  return record;
}

function collectReleaseAssetPaths(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (child === "node_modules" || child === "test") return [];
      return collectReleaseAssetPaths(root, child);
    }
    if (!entry.isFile()) return [];
    if (entry.name === "package.json" || entry.name.endsWith(".mjs") || ["desktop/tray.ps1", "desktop/rabi-agent.ico", "desktop/computer.ps1", "terminal/host.ps1"].includes(child) || /^dist\/native\/(terminal|computer|tray)-[a-f0-9]{64}\.dll$/.test(child) || (child.startsWith("dist/agent-hooks/") && /\.(json|md)$/.test(entry.name))) return [normalizeAssetPath(child)];
    return [];
  });
}

export function verifyLanAgentReleaseManifest(manifest: LanAgentReleaseManifest, expectedPublicKeySha256: string): boolean {
  try {
    const actualPublicKeySha256 = lanAgentReleasePublicKeySha256(manifest.publicKey);
    if (actualPublicKeySha256 !== expectedPublicKeySha256.toLowerCase() || manifest.publicKeySha256 !== actualPublicKeySha256) {
      return false;
    }
    const payload = manifestPayload(manifest);
    return verify(null, Buffer.from(payload), manifest.publicKey, Buffer.from(manifest.signature, "base64"));
  } catch {
    return false;
  }
}

export class LanAgentReleaseStore {
  private readonly rootDir: string;
  private readonly agentRoot: string;
  private readonly signingKeyPath: string;

  constructor(options: { rootDir: string; agentRoot?: string; signingKeyPath?: string }) {
    this.rootDir = path.resolve(options.rootDir);
    this.agentRoot = path.resolve(options.agentRoot ?? path.join(this.rootDir, "apps", "rabi-agent"));
    this.signingKeyPath = path.resolve(options.signingKeyPath ?? path.join(this.rootDir, "data", "lan-agent-release-signing-key.json"));
  }

  manifest(nodeId?: string): LanAgentReleaseManifest {
    const selected = nodeId ? this.selectedReleaseDigest(nodeId) : undefined;
    if (selected) return this.archivedRelease(selected).manifest;
    return this.commonRelease()?.manifest ?? this.packagedManifest();
  }

  private packagedManifest(): LanAgentReleaseManifest {
    const packageJsonPath = path.join(this.agentRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Rabi Agent package metadata is missing: ${packageJsonPath}`);
    }
    const packageJson = readJson(packageJsonPath);
    const version = requiredString(packageJson.version, "Rabi Agent package version");
    const files = collectReleaseAssetPaths(this.agentRoot)
      .sort((left, right) => left.localeCompare(right))
      .map(assetPath => {
        const file = fs.readFileSync(this.resolveAssetPath(assetPath));
        return {
          path: assetPath,
          sha256: sha256(file),
          size: file.byteLength,
          downloadUrl: `/api/lan-agent/releases/${encodeURIComponent(version)}/node/${assetPath.split("/").map(encodeURIComponent).join("/")}`
        };
      });
    if (!files.some(file => file.path === "rabi-agent.mjs")) {
      throw new Error("Rabi Agent release is missing rabi-agent.mjs.");
    }
    const keys = readSigningKeys(this.signingKeyPath);
    const unsigned: ReleaseManifestPayload = {
      version,
      platform: "node",
      minNodeVersion: "22.13.0",
      files
    };
    return {
      ...unsigned,
      publicKey: keys.publicKey,
      publicKeySha256: lanAgentReleasePublicKeySha256(keys.publicKey),
      signature: sign(null, Buffer.from(manifestPayload(unsigned)), keys.privateKey).toString("base64")
    };
  }

  publication(nodeId?: string): Readonly<{ version: string; releaseDigest: string }> {
    const manifest = this.manifest(nodeId);
    return Object.freeze({ version: manifest.version, releaseDigest: lanAgentReleaseManifestDigest(manifest) });
  }

  selectedReleaseDigest(nodeId: string): string | undefined {
    const selections = this.selections();
    return Object.hasOwn(selections, nodeId) ? selections[nodeId] : undefined;
  }

  nodeReleaseDigests(nodeIds: readonly string[], commonManifest: LanAgentReleaseManifest): ReadonlyMap<string, string> {
    const selections = this.selections(), commonDigest = lanAgentReleaseManifestDigest(commonManifest);
    return new Map(nodeIds.map(nodeId => [nodeId, Object.hasOwn(selections, nodeId) ? selections[nodeId]! : commonDigest]));
  }

  readAsset(version: string, platform: string, assetPath: string, nodeId?: string, snapshot?: string): Buffer {
    // A signed snapshot URL remains stable across a later node assignment change.
    const selected = nodeId ? this.selectedReleaseDigest(nodeId) : undefined;
    const archived = snapshot ? this.archivedSnapshot(snapshot) : selected ? this.archivedRelease(selected) : undefined;
    const common = archived ? undefined : this.commonRelease();
    const manifest = archived?.manifest ?? common?.manifest ?? this.packagedManifest();
    if (version !== manifest.version) throw new Error(`Rabi Agent release version is not available: ${version}`);
    if (platform !== manifest.platform) throw new Error(`Rabi Agent release platform is not available: ${platform}`);
    const normalizedPath = normalizeAssetPath(assetPath);
    const entry = manifest.files.find(file => file.path === normalizedPath);
    if (!entry) {
      throw new Error(`Rabi Agent release asset is not available: ${normalizedPath}`);
    }
    const archiveRoot = archived?.root;
    const bytes = fs.readFileSync(archiveRoot ? path.join(archiveRoot, "assets", ...normalizedPath.split("/")) : this.resolveAssetPath(normalizedPath, common?.agentRoot));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error("LAN Agent release asset integrity mismatch.");
    return bytes;
  }

  /** Local trusted publication owner only; preserves original URLs and signed digest. */
  publishCommonRelease(expectedReleaseDigest: string): Readonly<{ version: string; releaseDigest: string }> {
    if (!releaseHash(expectedReleaseDigest)) throw new Error("A valid expected common release digest is required.");
    return withFileLockSync(path.join(this.archiveRoot(), "selection.lock"), () => {
      const previous = this.commonRelease();
      const current = previous?.manifest ?? this.packagedManifest();
      const currentDigest = lanAgentReleaseManifestDigest(current);
      if (currentDigest !== expectedReleaseDigest) throw new LanAgentReleaseSelectionConflictError();
      // Never replace a damaged selection to silently adopt another package.
      if (previous) this.verifyCommonAssets(previous);
      const manifest = this.packagedManifest();
      const keys = readSigningKeys(this.signingKeyPath);
      if (!verifyLanAgentReleaseManifest(manifest, lanAgentReleasePublicKeySha256(keys.publicKey))) throw new Error("LAN Agent common release signature mismatch.");
      const record: CommonReleaseSelection = { schemaVersion: 1, releaseDigest: lanAgentReleaseManifestDigest(manifest),
        agentRoot: fs.realpathSync(this.agentRoot), manifest };
      this.verifyCommonAssets(record);
      atomicWriteFileSync(path.join(this.archiveRoot(), "common.json"), JSON.stringify(record), { mode: 0o600 });
      recordDataMutationAudit({ group: "lan-agent", event: "lan_agent_common_release_published", owner: "lan-agent-release", action: "publish-common-release",
        target: { type: "lan-agent-release", id: "common" }, dataSource: { kind: "file", id: "common.json" }, outcome: "committed",
        before: { digest: currentDigest }, after: { digest: record.releaseDigest } });
      return Object.freeze({ version: manifest.version, releaseDigest: record.releaseDigest });
    });
  }

  /** Local trusted publication owner only. HTTP never accepts a source directory. */
  importRelease(agentRoot: string): Readonly<{ version: string; releaseDigest: string }> {
    const source = path.resolve(agentRoot);
    const staging = path.join(this.archiveRoot(), `.prepare-${randomUUID()}`);
    fs.mkdirSync(path.join(staging, "assets"), { recursive: true });
    try {
      for (const asset of collectReleaseAssetPaths(source)) {
        const destination = path.join(staging, "assets", ...asset.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(source, ...asset.split("/")), destination);
      }
      const frozen = new LanAgentReleaseStore({ rootDir: this.rootDir, agentRoot: path.join(staging, "assets"), signingKeyPath: this.signingKeyPath });
      const original = frozen.packagedManifest();
      const snapshot = sha256(Buffer.from(manifestPayload(original)));
      const unsigned: ReleaseManifestPayload = { ...original, files: original.files.map(file => ({ ...file, downloadUrl: `${file.downloadUrl}?release=${snapshot}` })) };
      const keys = readSigningKeys(this.signingKeyPath);
      const manifest: LanAgentReleaseManifest = { ...unsigned, publicKey: keys.publicKey, publicKeySha256: lanAgentReleasePublicKeySha256(keys.publicKey),
        signature: sign(null, Buffer.from(manifestPayload(unsigned)), keys.privateKey).toString("base64") };
      const releaseDigest = sha256(Buffer.from(manifestPayload(manifest)));
      fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      withFileLockSync(path.join(this.archiveRoot(), "publication.lock"), () => {
        const destination = path.join(this.archiveRoot(), "snapshots", snapshot);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!fs.existsSync(destination)) fs.renameSync(staging, destination);
        // Validate existing immutable content before publishing a digest reference.
        const archived = this.archivedSnapshot(snapshot);
        if (sha256(Buffer.from(manifestPayload(archived.manifest))) !== releaseDigest) throw new Error("LAN Agent archived release digest mismatch.");
        for (const file of archived.manifest.files) this.readAsset(manifest.version, manifest.platform, file.path, undefined, snapshot);
        const index = path.join(this.archiveRoot(), "digests", `${releaseDigest}.json`);
        fs.mkdirSync(path.dirname(index), { recursive: true });
        atomicWriteFileSync(index, JSON.stringify({ snapshot }));
      });
      return Object.freeze({ version: manifest.version, releaseDigest });
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  /** Version selection, independent of connection permissions. null returns this node to the common release. */
  assignRelease(nodeId: string, releaseDigest: string | null, expectedReleaseDigest: string): Readonly<{ version: string; releaseDigest: string }> {
    if (!nodeId || nodeId !== nodeId.trim()) throw new Error("Stable nodeId is required.");
    if (!releaseHash(expectedReleaseDigest) || releaseDigest !== null && !releaseHash(releaseDigest)) throw new Error("Valid release digests are required.");
    return withFileLockSync(path.join(this.archiveRoot(), "selection.lock"), () => {
      const current = this.publication(nodeId);
      if (current.releaseDigest !== expectedReleaseDigest) throw new LanAgentReleaseSelectionConflictError();
      const archived = releaseDigest === null ? undefined : this.archivedRelease(releaseDigest);
      const selected = archived?.manifest ?? this.manifest();
      if (archived) for (const file of selected.files) this.readAsset(selected.version, selected.platform, file.path, undefined, path.basename(archived.root));
      const selections = this.selections();
      if (releaseDigest === null) delete selections[nodeId]; else Object.defineProperty(selections, nodeId, { value: releaseDigest, enumerable: true, configurable: true });
      atomicWriteFileSync(path.join(this.archiveRoot(), "selections.json"), JSON.stringify(selections));
      const publication = Object.freeze({ version: selected.version, releaseDigest: sha256(Buffer.from(manifestPayload(selected))) });
      recordDataMutationAudit({ group: "lan-agent", event: "lan_agent_release_selected", owner: "lan-agent-release", action: "select-node-release",
        target: { type: "lan-agent-node", id: nodeId }, dataSource: { kind: "file", id: "selections.json" }, outcome: "committed",
        before: { digest: current.releaseDigest }, after: { digest: publication.releaseDigest } });
      return publication;
    });
  }

  private archiveRoot(): string { return path.join(this.rootDir, "data", "lan-agent-releases"); }
  private commonRelease(): CommonReleaseSelection | undefined {
    let raw: Record<string, unknown>;
    try { raw = readJson(path.join(this.archiveRoot(), "common.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (raw.schemaVersion !== 1 || !releaseHash(raw.releaseDigest) || typeof raw.agentRoot !== "string"
      || !path.isAbsolute(raw.agentRoot) || raw.agentRoot !== path.resolve(raw.agentRoot)) throw new Error("Invalid LAN Agent common release selection.");
    const manifest = raw.manifest as LanAgentReleaseManifest;
    // An existing selection must never create a replacement signing identity.
    const publicKey = requiredString(readJson(this.signingKeyPath).publicKey, "LAN Agent release publicKey");
    if (!verifyLanAgentReleaseManifest(manifest, lanAgentReleasePublicKeySha256(publicKey))) throw new Error("LAN Agent common release signature mismatch.");
    if (lanAgentReleaseManifestDigest(manifest) !== raw.releaseDigest || manifest.platform !== "node"
      || !manifest.files.some(file => file.path === "rabi-agent.mjs")
      || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
      || manifest.files.some(file => normalizeAssetPath(file.path) !== file.path || !releaseHash(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
        || file.downloadUrl !== `/api/lan-agent/releases/${encodeURIComponent(manifest.version)}/node/${file.path.split("/").map(encodeURIComponent).join("/")}`)) {
      throw new Error("LAN Agent common release digest or asset metadata mismatch.");
    }
    return { schemaVersion: 1, releaseDigest: raw.releaseDigest, agentRoot: raw.agentRoot, manifest };
  }

  private verifyCommonAssets(selection: CommonReleaseSelection): void {
    for (const file of selection.manifest.files) {
      const bytes = fs.readFileSync(this.resolveAssetPath(file.path, selection.agentRoot));
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error("LAN Agent common release asset integrity mismatch.");
    }
  }

  private selections(): Record<string, string> {
    const file = path.join(this.archiveRoot(), "selections.json");
    if (!fs.existsSync(file)) return Object.create(null) as Record<string, string>;
    const selections = readJson(file);
    if (!Object.values(selections).every(releaseHash)) throw new Error("Invalid node release selections.");
    return selections as Record<string, string>;
  }
  private archivedRelease(digest: string): { manifest: LanAgentReleaseManifest; root: string } {
    if (!releaseHash(digest)) throw new Error("Invalid archived release digest.");
    const index = readJson(path.join(this.archiveRoot(), "digests", `${digest}.json`));
    const archived = this.archivedSnapshot(requiredString(index.snapshot, "release snapshot"));
    if (sha256(Buffer.from(manifestPayload(archived.manifest))) !== digest) throw new Error("LAN Agent archived release digest mismatch.");
    return archived;
  }
  private archivedSnapshot(snapshot: string): { manifest: LanAgentReleaseManifest; root: string } {
    if (!releaseHash(snapshot)) throw new Error("Invalid release snapshot.");
    const root = path.join(this.archiveRoot(), "snapshots", snapshot);
    const manifest = readJson(path.join(root, "manifest.json")) as unknown as LanAgentReleaseManifest;
    const keys = readSigningKeys(this.signingKeyPath);
    if (!verifyLanAgentReleaseManifest(manifest, lanAgentReleasePublicKeySha256(keys.publicKey))) throw new Error("LAN Agent archived release signature mismatch.");
    if (manifest.files.some(file => normalizeAssetPath(file.path) !== file.path || file.downloadUrl !== `/api/lan-agent/releases/${encodeURIComponent(manifest.version)}/node/${file.path.split("/").map(encodeURIComponent).join("/")}?release=${snapshot}`)) throw new Error("Invalid archived release asset URL.");
    return { manifest, root };
  }

  private resolveAssetPath(assetPath: string, agentRoot = this.agentRoot): string {
    const normalizedPath = normalizeAssetPath(assetPath);
    const resolved = path.resolve(agentRoot, ...normalizedPath.split("/"));
    const relative = path.relative(agentRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Rabi Agent release asset escapes its package root: ${assetPath}`);
    }
    return resolved;
  }
}
