export type DesktopPetModeAnimationSet = {
  idleState: string;
  randomMinSeconds: number;
  randomMaxSeconds: number;
  randomStates: string[];
  clickStates: string[];
};

type ModeState = { loop: boolean; next?: string };
type JsonObject = Record<string, unknown>;
const MODE_ID = /^[a-z][a-z0-9_-]{0,79}$/i;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** The manifest owns mode pools. Both import admission and catalog DTOs use this validator. */
export function normalizeDesktopPetModeAnimationSets(
  value: unknown, states: Record<string, ModeState>
): Record<string, DesktopPetModeAnimationSet> {
  if (value === undefined) return {};
  const raw = object(value);
  if (!raw || Object.keys(raw).length > 32) throw new Error("modeAnimationSets must contain at most 32 named mode groups.");
  const result: Record<string, DesktopPetModeAnimationSet> = {};
  for (const [modeId, input] of Object.entries(raw)) {
    const group = object(input);
    if (!MODE_ID.test(modeId) || !group) throw new Error("modeAnimationSets contains an invalid mode group.");
    const idleState = typeof group.idleState === "string" ? group.idleState.trim() : "";
    if (!idleState || states[idleState]?.loop !== true) {
      throw new Error(`modeAnimationSets.${modeId}.idleState must reference an existing looping state.`);
    }
    const pool = (name: "randomStates" | "clickStates"): string[] => {
      const values = group[name] ?? [];
      if (!Array.isArray(values) || values.length > 12) {
        throw new Error(`modeAnimationSets.${modeId}.${name} must contain at most 12 action IDs.`);
      }
      const actions: string[] = [];
      for (const value of values) {
        const action = typeof value === "string" ? value.trim() : "";
        if (!action || states[action]?.loop !== false || states[action]?.next !== idleState) {
          throw new Error(`modeAnimationSets.${modeId}.${name} actions must be one-shot states returning to ${idleState}.`);
        }
        if (!actions.includes(action)) actions.push(action);
      }
      return actions;
    };
    const interval = group.randomIntervalSeconds === undefined ? {} : object(group.randomIntervalSeconds);
    if (!interval) throw new Error(`modeAnimationSets.${modeId}.randomIntervalSeconds must be an object.`);
    const randomMinSeconds = interval.min ?? 90;
    const randomMaxSeconds = interval.max ?? Math.max(240, Number(randomMinSeconds));
    if (typeof randomMinSeconds !== "number" || !Number.isFinite(randomMinSeconds)
      || typeof randomMaxSeconds !== "number" || !Number.isFinite(randomMaxSeconds)
      || randomMinSeconds < 5 || randomMaxSeconds < randomMinSeconds || randomMaxSeconds > 3600) {
      throw new Error(`modeAnimationSets.${modeId}.randomIntervalSeconds must satisfy 5 <= min <= max <= 3600.`);
    }
    result[modeId] = { idleState, randomMinSeconds, randomMaxSeconds, randomStates: pool("randomStates"), clickStates: pool("clickStates") };
  }
  return result;
}

/** Validate newly authored mode metadata before publishing an imported immutable pack. */
export function validateDesktopPetModeAnimationSetManifest(manifest: JsonObject): void {
  const rawStates = object(manifest.states) ?? {};
  const defaults = object(manifest.defaults) ?? {};
  const states = Object.fromEntries(Object.entries(rawStates).map(([name, input]) => {
    const row = object(input) ?? {};
    return [name, { loop: typeof row.loop === "boolean" ? row.loop : defaults.loop !== false,
      ...(typeof row.next === "string" ? { next: row.next.trim() } : {}) }];
  }));
  normalizeDesktopPetModeAnimationSets(manifest.modeAnimationSets, states);
}
