import { ReadSettingsError } from "./readSettingsError.js";
import { getTimeoutMs } from "./timeoutSettings.js";
import { constants as bufferConstants } from "node:buffer";

/** Public process settings; zero bytes means no application quota, only the runtime Buffer limit. */
function createQqSettings(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new ReadSettingsError(name, `must be an integer from ${minimum} to ${maximum}; received ${JSON.stringify(value)}.`);
    }
    return parsed;
  };
  const bytes = (name: string) => integer(name, 0, 0) || bufferConstants.MAX_LENGTH;
  return Object.freeze({
    get jsonBytes() { return bytes("RABIROUTE_QQ_JSON_MAX_BYTES"); },
    get mediaBytes() { return bytes("RABIROUTE_QQ_MEDIA_MAX_BYTES"); },
    get previewBytes() { return bytes("RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES"); },
    get readTimeoutMs() { return getTimeoutMs("qq.read", integer("RABIROUTE_QQ_READ_TIMEOUT_MS", 8000, 1, 2_147_483_647)); },
    get mediaTimeoutMs() { return getTimeoutMs("qq.media", integer("RABIROUTE_QQ_MEDIA_TIMEOUT_MS", 30000, 1, 2_147_483_647)); },
    get previewTimeoutMs() { return getTimeoutMs("qq.preview", integer("RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS", 10000, 1, 2_147_483_647)); },
    get readConcurrency() { return integer("RABIROUTE_QQ_READ_CONCURRENCY", 2); },
    get stickerCount() { return integer("RABIROUTE_QQ_STICKER_COUNT", 1000); }
  });
}

export function readQqSettings(env: NodeJS.ProcessEnv = process.env) {
  const settings = createQqSettings(env); Object.values(settings); return settings;
}
export const qqReadSettings = createQqSettings();
