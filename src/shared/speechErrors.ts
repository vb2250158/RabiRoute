/** Stable exception identities shared by host admission and immutable speech packages. */
export class SpeechControlError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "SpeechControlError"; }
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
