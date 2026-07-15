export function normalizePublicControlUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error("REMOTE_AGENT_PUBLIC_CONTROL_URL must be an absolute ws:// or wss:// URL.", { cause: error });
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    || !parsed.hostname
    || parsed.pathname !== "/api/remote-agent/control"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("REMOTE_AGENT_PUBLIC_CONTROL_URL must be a credential-free ws:// or wss:// URL with path /api/remote-agent/control and no query or fragment.");
  }
  return parsed.toString();
}
