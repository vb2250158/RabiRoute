import { COMPANION_ACTIVITY_KINDS, type CompanionObservation, type CompanionSession } from "../shared/companionActivity.js";

type SceneRule = { kind: CompanionSession["activityKind"]; process?: RegExp; title?: RegExp };
export function readCompanionSceneRules(value: unknown): SceneRule[] {
  const rows = (value as { rules?: unknown })?.rules;
  if (!Array.isArray(rows) || rows.length > 64) throw new Error("Invalid companion scene rules");
  return rows.map(row => {
    if (!row || row.kind === "uncertain" || !COMPANION_ACTIVITY_KINDS.includes(row.kind)) throw new Error("Invalid companion scene rule");
    const pattern = (value: unknown): RegExp | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !value || value.length > 400) throw new Error("Invalid scene pattern");
      return new RegExp(value, "i");
    };
    const process = pattern(row.processPattern), title = pattern(row.titlePattern);
    if (!process && !title) throw new Error("Scene rule needs evidence");
    return { kind: row.kind, process, title };
  });
}

export function classifyCompanionScene(input: CompanionObservation, rules: SceneRule[]): CompanionSession["activityKind"] {
  if (input.source === "player") return "watch";
  const window = input.window;
  if (!window) return "uncertain";
  const title = window.title.trim();
  const media = input.media;
  if (media?.kind === "video" && media.status === "playing" && media.title
      && title.toLowerCase().includes(media.title.toLowerCase())) return "watch";
  return rules.find(rule => (!rule.process || rule.process.test(window.processName))
    && (!rule.title || rule.title.test(title)))?.kind || "uncertain";
}
