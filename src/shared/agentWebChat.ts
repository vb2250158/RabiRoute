export const WEB_CHAT_ADAPTER = 'WebChat';
export const WEB_CHAT_ATTACHMENT_COUNT = 8;
export const WEB_CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const WEB_CHAT_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;
export const WEB_CHAT_REQUEST_MAX_BYTES = 36 * 1024 * 1024;

export type WebChatAttachment = { name: string; contentBase64: string };

export function webChatHostCanReadUploads(agentBaseUrl?: string): boolean {
  if (!agentBaseUrl) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(agentBaseUrl).hostname); }
  catch { return false; }
}
