import fs from "node:fs";
import path from "node:path";
import { apiDigest } from "@rabiroute/host-api/manager/apiOperationContract";
import { RabiLinkHomeError, type RabiLinkHomeDevice } from "@rabiroute/host-api/manager/rabiLinkHome";
import { atomicWriteFileSync } from "@rabiroute/host-api/shared/filePersistence";

export type DeviceLabels = { alias: string; tags: string[] };
export type LabeledDevice = RabiLinkHomeDevice & { labels?: DeviceLabels; labelRevision: string };
export const deviceLabelLimits = { alias: 80, tags: 20, tag: 32 };

const deviceKey = ({ id, guid }: RabiLinkHomeDevice) => apiDigest([id, guid]);

function cleanLabels({ alias, tags }: DeviceLabels): DeviceLabels {
  const seen = new Set<string>();
  return { alias: alias.trim(), tags: tags.map(tag => tag.trim()).filter(tag => {
    const key = tag.normalize("NFKC").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
}

function project(scope: string, device: RabiLinkHomeDevice, labels?: DeviceLabels): LabeledDevice {
  return { ...device, ...(labels ? { labels } : {}), labelRevision: apiDigest([scope, deviceKey(device), labels ?? null]).slice("sha256:".length) };
}

/** This Manager owns presentation labels for devices in its current Relay application. */
export class RabiLinkDeviceLabels {
  constructor(private readonly directory: string) {}

  private read(scope: string): Record<string, DeviceLabels> | undefined {
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(path.join(this.directory, scope + ".json"), "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid device labels");
      return saved as Record<string, DeviceLabels>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private source(scope: string, legacyScope: string) {
    const scoped = this.read(scope);
    if (scoped === undefined && scope !== legacyScope) {
      // The authenticated Relay credential also identifies its existing legacy bucket.
      const legacy = this.read(legacyScope);
      if (legacy !== undefined) return { fileScope: legacyScope, revisionScope: scope + ":" + legacyScope, labels: legacy };
    }
    return { fileScope: scope, revisionScope: scope, labels: scoped ?? {} };
  }

  list(scope: string, legacyScope: string, devices: RabiLinkHomeDevice[]): LabeledDevice[] {
    const { labels, revisionScope } = this.source(scope, legacyScope);
    return devices.map(device => project(revisionScope, device, labels[deviceKey(device)]));
  }

  save(scope: string, legacyScope: string, device: RabiLinkHomeDevice, labels: DeviceLabels, expectedRevision: string): LabeledDevice {
    const { labels: stored, fileScope, revisionScope } = this.source(scope, legacyScope);
    const key = deviceKey(device);
    const current = project(revisionScope, device, stored[key]);
    if (current.labelRevision !== expectedRevision) {
      throw new RabiLinkHomeError(409, "RABILINK_DEVICE_LABELS_CHANGED", "别名或标签已更新，请刷新设备后重试。");
    }
    const next = cleanLabels(labels);
    if (next.alias || next.tags.length) stored[key] = next;
    else delete stored[key];
    const result = project(revisionScope, device, stored[key]);
    if (result.labelRevision !== current.labelRevision) {
      atomicWriteFileSync(path.join(this.directory, fileScope + ".json"), JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
    }
    return result;
  }
}
