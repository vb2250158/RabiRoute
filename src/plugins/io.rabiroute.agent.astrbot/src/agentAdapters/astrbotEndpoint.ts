/** Only configured endpoints may receive AstrBot credentials or messages. */
export function requireAstrbotUrl(value: string | undefined = process.env.ASTRBOT_URL): string {
  const raw = value?.trim();
  if (!raw) throw new Error("ASTRBOT_URL is required; configure the intended AstrBot dashboard URL.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("AstrBot URL must be an HTTP(S) address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port === "0" || url.search || url.hash) {
    throw new Error("AstrBot URL must be an HTTP(S) address without embedded credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Environment credentials remain attached to the explicitly configured environment endpoint. */
export function astrbotEnvironmentMatches(baseUrl: string): boolean {
  try { return requireAstrbotUrl(process.env.ASTRBOT_URL) === baseUrl; }
  catch { return false; }
}
