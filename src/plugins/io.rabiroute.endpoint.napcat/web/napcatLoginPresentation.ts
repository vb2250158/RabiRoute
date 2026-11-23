/** Keep the native explanation, without displaying its account and protocol envelope. */
export function napcatLoginErrorMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.trim();
  const envelope = /^登录失败:\s*(\[.*\])$/s.exec(text);
  if (!envelope) return text;
  try {
    const result: unknown = JSON.parse(envelope[1]!);
    const detail = Array.isArray(result) ? result[1] : undefined;
    if (detail && typeof detail.message === "string" && detail.message.trim()) return detail.message.trim();
  } catch { /* A malformed native error still needs a visible recovery message. */ }
  return "QQ 登录失败，请在手机 QQ 查看登录提示后重试。";
}
