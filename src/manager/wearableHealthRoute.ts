export type WearableHealthResource = "state" | "history" | "summary" | "config" | "observations";

export type WearableHealthResourceRoute = {
  roleId: string;
  resource: WearableHealthResource;
};

const wearableHealthResourcePattern = /^\/(?:api\/)?roles\/([^/]+)\/health(?:\/(state|history|summary|config|observations))?$/;

export function parseWearableHealthResourceRoute(pathname: string): WearableHealthResourceRoute | null {
  const match = pathname.match(wearableHealthResourcePattern);
  if (!match) return null;
  return {
    roleId: decodeURIComponent(match[1]),
    resource: (match[2] || "summary") as WearableHealthResource
  };
}
