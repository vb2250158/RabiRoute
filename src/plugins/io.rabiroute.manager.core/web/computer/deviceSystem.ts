/** The operating system decides a device's list icon. An advertised platform or
 * model is authoritative; a display name is only a fallback hint. */
export type DeviceSystem = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";

export type DeviceSystemHint = {
  /** RabiPC nodes report `win32-x64` / `darwin-arm64`; this Manager reports `process.platform`. */
  platform?: string;
  /** `phone` keeps an unlabelled mobile device from looking like an unknown desktop. */
  deviceKind?: string;
  deviceModel?: string;
  name?: string;
  id?: string;
};

const icons: Record<DeviceSystem, string> = {
  windows: "mdi-microsoft-windows",
  macos: "mdi-apple",
  linux: "mdi-linux",
  android: "mdi-android",
  ios: "mdi-apple-ios",
  unknown: "mdi-monitor"
};

const names: Record<DeviceSystem, string> = {
  windows: "Windows", macos: "Mac", linux: "Linux", android: "Android", ios: "iOS", unknown: ""
};

function advertised(text: string): DeviceSystem | undefined {
  const value = text.trim().toLowerCase();
  if (!value) return undefined;
  // Anchor the standard values first: `darwin-arm64` must never match "win".
  if (/^(win|windows)/.test(value)) return "windows";
  if (/^(darwin|macos|mac os)/.test(value)) return "macos";
  if (/^linux/.test(value)) return "linux";
  if (/^android/.test(value)) return "android";
  if (/^(ios|iphone|ipad)/.test(value)) return "ios";
  if (value.includes("darwin") || value.includes("macos")) return "macos";
  if (/(^|[^a-z])win(dows|32|64)?([^a-z]|$)/.test(value)) return "windows";
  if (value.includes("linux")) return "linux";
  if (value.includes("android")) return "android";
  if (/(^|[^a-z])ios([^a-z]|$)|iphone|ipad/.test(value)) return "ios";
  return undefined;
}

function labelled(text: string): DeviceSystem | undefined {
  if (/\bios\b|iphone|ipad/.test(text)) return "ios";
  if (/android/.test(text)) return "android";
  if (/windows|win32/.test(text)) return "windows";
  if (/macbook|mac ?os|darwin|imac|mac mini|(^|[^a-z])mac([^a-z]|$)/.test(text)) return "macos";
  if (/linux|ubuntu|debian|fedora/.test(text)) return "linux";
  return undefined;
}

export function deviceSystem(hint: DeviceSystemHint): DeviceSystem {
  const reported = advertised(hint.platform ?? "");
  if (reported) return reported;
  const text = [hint.deviceModel, hint.name, hint.id].filter(Boolean).join(" ").toLowerCase();
  const named = labelled(text);
  if (named) return named;
  // The Relay directory carries no platform for a phone, and the current RabiLink
  // mobile client is Android, so an unlabelled phone keeps the Android icon
  // instead of claiming an unknown system.
  return hint.deviceKind === "phone" || hint.deviceKind === "glasses" ? "android" : "unknown";
}

export function deviceSystemIcon(hint: DeviceSystemHint): string {
  return icons[deviceSystem(hint)];
}

/** Empty for an unreported desktop system; the template shows its own fallback label. */
export function deviceSystemName(hint: DeviceSystemHint): string {
  return names[deviceSystem(hint)];
}
