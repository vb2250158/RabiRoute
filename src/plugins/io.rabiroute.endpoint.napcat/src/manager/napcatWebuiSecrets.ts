/** Known credential data roles; packetServer and ordinary business IDs are deliberately not secret by name. */
export const isNapcatCredentialField = (key: string): boolean => /(?:token|password|passwd|credential|privatekey|secretkey|secret|apikey|accesskey|signingkey|authorization|cookie|cookies|skey|pskey|superkey|sessionkey|qrcode)$/i.test(key.replace(/[^a-z0-9]/gi, ""));
export const hasNapcatProtectedMarker = (value: unknown): boolean => typeof value === "string" && /\[protected(?: PEM)?\]|%5Bprotected%5D/i.test(value);
