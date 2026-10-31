import { translateText, useI18n } from "./i18n";
import { presentError, type ErrorDetails } from "../../src/shared/errorPresentation";
/** Read locale at the display boundary, preserving structured diagnostics. */
export function userFacingError(error: unknown): string {
  const value = error && typeof error === "object" ? error as ErrorDetails & { message?: string; details?: ErrorDetails } : {};
  const locale = useI18n().locale.value;
  const message = presentError(value.message ?? String(error || ""), value.details ?? value, locale === "ja" ? "zh-CN" : locale);
  return locale === "ja" ? message.split("\n").map(line => translateText(line, locale)).join("\n") : message;
}
