/** Stable exception identities shared by host admission and immutable speech packages. */
export class SpeechControlError extends Error {
  readonly code?: "SPEECH_PARAMETER_INVALID";
  constructor(message: string, readonly status: number, readonly parameter?: Readonly<{ field: string; repair: string }>) {
    super(message); this.name = "SpeechControlError";
    if (parameter) this.code = "SPEECH_PARAMETER_INVALID";
  }
}
export class SpeechRuntimeControlError extends Error {
  constructor(message: string, readonly status = 502, readonly detail = "", readonly resolution = "") {
    super(message); this.name = "SpeechRuntimeControlError";
  }
}
export class SpeechModelManagerError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "SpeechModelManagerError"; }
}
export class SpeechModelSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
