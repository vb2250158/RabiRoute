import type { AppLocale } from "../i18n";

export function guideLocale(path: string): AppLocale {
  if (path.endsWith("_ja.md")) return "ja";
  return path.endsWith("_en.md") ? "en" : "zh-CN";
}

export function guideKey(path: string): string {
  return (path.split("/").pop() || "README.md").replace(/(?:_en|_ja)?\.md$/, "");
}

export function guideSection(key: string, locale: AppLocale): string {
  const labels = {
    "zh-CN": ["开始使用", "日常使用", "运行与安全", "获得帮助"],
    en: ["Start here", "Use RabiRoute", "Operate safely", "Help"],
    ja: ["はじめに", "日常の操作", "運用と安全", "ヘルプ"]
  }[locale];
  if (key === "README" || key === "first-route") return labels[0];
  if (["interface-and-status", "routes-and-adapters", "home-devices", "speech-api", "agents-and-sessions", "personas-and-rules", "persona-skills", "knowledge-bridge-settings", "interface-theme"].includes(key)) return labels[1];
  if (["instance-identity", "operations-and-troubleshooting", "safety-and-data"].includes(key)) return labels[2];
  return labels[3];
}
