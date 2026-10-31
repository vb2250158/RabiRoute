export function webReleaseQuery(): string {
  const revision = (typeof document === "undefined" ? null : document.documentElement?.getAttribute("data-rabi-web-release"))
    ?? (typeof location === "undefined" ? null : location.pathname.match(/^\/_rabiroute\/web\/([a-f0-9]{64})\/.+$/)?.[1]);
  return revision && /^[a-f0-9]{64}$/.test(revision) ? `?webRelease=${revision}` : "";
}
