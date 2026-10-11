/** Bounded directory reads; offset refers to the current, ID-sorted matching set. */
export type HomeDirectoryPage<T> = {
  schemaVersion: 1;
  view: "summary" | "detail";
  observedAt: string;
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
};

/** Summary values help choose a resource; read its current detail before acting. */
export type HomeResourceSummary = {
  resourceId: string; entityId: string; displayName: string; kind: string; available: boolean;
};

export type HomeDeviceSummary = {
  deviceId: string; displayName: string; model: string; manufacturer: string; areaName: string;
  resourceCount: number; availableResourceCount: number; kinds: string[];
  resourcesPath: string;
};
