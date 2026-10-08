/** Explicit operator-owned bindings; never infer a notification action from its name. */
export type HomeSpeechBinding = Readonly<{
  mediaPlayerEntityId: string;
  notifyEntityId: string;
  encoding: "text" | "json-array";
}>;

const number = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const object = (properties: Record<string, unknown> = {}) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false
});

// Home Assistant MediaPlayerEntityFeature. No feature bit means no advertised action.
export const HOME_MEDIA_ACTIONS = Object.freeze([
  { name: "play", feature: 16384, service: "media_play", schema: object(), confirmation: "state" },
  { name: "pause", feature: 1, service: "media_pause", schema: object(), confirmation: "state" },
  { name: "stop", feature: 4096, service: "media_stop", schema: object(), confirmation: "state" },
  { name: "next_track", feature: 32, service: "media_next_track", schema: object(), confirmation: "acceptance" },
  { name: "previous_track", feature: 16, service: "media_previous_track", schema: object(), confirmation: "acceptance" },
  { name: "set_volume", feature: 4, service: "volume_set", schema: object({ volume: number(0, 1) }), confirmation: "state" },
  { name: "mute", feature: 8, service: "volume_mute", schema: object({ muted: { type: "boolean" } }), confirmation: "state" },
  { name: "seek", feature: 2, service: "media_seek", schema: object({ positionSeconds: number(0, 86400) }), confirmation: "acceptance" },
  { name: "select_source", feature: 2048, service: "select_source", schema: object({ source: text(256) }), confirmation: "state" },
  { name: "select_sound_mode", feature: 65536, service: "select_sound_mode", schema: object({ soundMode: text(256) }), confirmation: "state" },
  { name: "play_media", feature: 512, service: "play_media", schema: object({ url: text(2048), mediaType: text(128) }), confirmation: "acceptance" }
] as const);

export const HOME_SPEECH_CAPABILITY = "home.speaker.speak@1";
export const HOME_SPEECH_ARGUMENT_SCHEMA = object({ text: text(1000) });
export const HOME_DEVICE_ARGUMENT_SCHEMAS: Readonly<Record<string, ReturnType<typeof object>>> = Object.freeze({
  "home.light.turn_on@1": object(), "home.light.turn_off@1": object(),
  "home.light.set_brightness@1": object({brightnessPercent: number(0, 100)}),
  "home.switch.turn_on@1": object(), "home.switch.turn_off@1": object(),
  "home.fan.turn_on@1": object(), "home.fan.turn_off@1": object(), "home.fan.set_percentage@1": object({percentage: number(0, 100)}),
  "home.cover.open@1": object(), "home.cover.close@1": object(), "home.cover.stop@1": object(),
  "home.climate.set_temperature@1": object({temperature: number(5, 35)}), "home.climate.turn_off@1": object(),
  "home.vacuum.start@1": object(), "home.vacuum.return_home@1": object()
});
export function mediaCapability(name: string): string { return `home.media.${name}@1`; }

export function normalizeHomeSpeechBindings(value: unknown): readonly HomeSpeechBinding[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) throw new TypeError("speechBindings must be an array of at most 64 bindings.");
  const players = new Set<string>();
  const targets = new Set<string>();
  return Object.freeze(value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["mediaPlayerEntityId", "notifyEntityId", "encoding"].includes(key))
      || typeof item.mediaPlayerEntityId !== "string" || !/^media_player\.[a-z0-9_]+$/.test(item.mediaPlayerEntityId)
      || typeof item.notifyEntityId !== "string" || !/^notify\.[a-z0-9_]+$/.test(item.notifyEntityId)
      || !["text", "json-array"].includes(item.encoding)
      || players.has(item.mediaPlayerEntityId) || targets.has(item.notifyEntityId)) {
      throw new TypeError("speechBindings requires unique media_player and notify entities and text/json-array encoding.");
    }
    players.add(item.mediaPlayerEntityId);
    targets.add(item.notifyEntityId);
    return Object.freeze({ mediaPlayerEntityId: item.mediaPlayerEntityId, notifyEntityId: item.notifyEntityId, encoding: item.encoding });
  }));
}

/** A deliberately small schema vocabulary also consumed by Agent discovery. */
export function validateHomeMediaArguments(value: unknown, schema: ReturnType<typeof object>): Record<string, unknown> {
  const args = value === undefined ? {} : value;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object.");
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some(key => !Object.hasOwn(schema.properties, key))) throw new TypeError("Unknown action argument.");
  for (const [key, rule] of Object.entries(schema.properties)) {
    const spec = rule as { type: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number };
    const field = record[key];
    if (spec.type === "number" && (typeof field !== "number" || !Number.isFinite(field) || field < spec.minimum! || field > spec.maximum!)
      || spec.type === "boolean" && typeof field !== "boolean"
      || spec.type === "string" && (typeof field !== "string" || !field.trim() || field.length > spec.maxLength! || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(field))) {
      throw new TypeError(`Invalid action argument: ${key}.`);
    }
  }
  return record;
}
