/** A directory groups published HA entities by the provider's device registry. */
export type HomeDeviceDirectory<TResource> = {
  schemaVersion: 1;
  observedAt: string;
  devices: Array<{
    deviceId: string; displayName: string; model: string; manufacturer: string; areaName: string;
    resources: TResource[];
  }>;
  unassignedResources: TResource[];
};
