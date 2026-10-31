/** A malformed preference disables only the feature that consumes this field. */
export class ReadSettingsError extends Error {
  readonly code = "READ_SETTING_INVALID";
  readonly statusCode = 503;
  constructor(readonly setting: string, requirement: string) {
    super(`${setting} ${requirement} Update this Manager environment setting and retry.`);
  }
}
