import { webChatHostCanReadUploads, type WebChatAttachment } from '@shared/agentWebChat';
import type { PersonaSessionAgent } from './agentSessionClient';

export type WebChatTarget = { key: string; agent: PersonaSessionAgent; threadId: string };
export type WebChatIntent = { deliveryId: string; prompt: string; webChatAttachments: WebChatAttachment[] };
type WebChatResult = { state: 'accepted' | 'failed' | 'uncertain' | 'retry'; message?: string };

export function canAttachToWebChat(agent: PersonaSessionAgent): boolean {
  return !agent.binding && webChatHostCanReadUploads(agent.dshBaseUrl);
}

function encodeAttachment(file: File): Promise<WebChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, contentBase64: String(reader.result).split(',', 2)[1] ?? '' });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function createWebChatIntent(prompt: string, files: readonly File[]): Promise<WebChatIntent> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const deliveryId = `webchat-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return { deliveryId, prompt: prompt.trim(), webChatAttachments: await Promise.all(files.map(encodeAttachment)) };
}

export function createAgentWebChatClient(request: typeof fetch) {
  return {
    async send({ agent, threadId }: WebChatTarget, intent: WebChatIntent): Promise<WebChatResult> {
      try {
        const response = await request('/api/agent/webchat', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...intent, threadId, agentAdapter: agent.provider,
            instanceBinding: agent.binding, dshBaseUrl: agent.dshBaseUrl })
        });
        const body = await response.json();
        const message = body.message ?? body.error?.message;
        if (response.ok && body.status === 'delivered' && body.delivery?.targetThreadId === threadId) return { state: 'accepted' };
        if (body.delivery?.status === 'prepared') return { state: 'retry', message };
        if (body.uncertain || body.status === 'delivery_unconfirmed' || response.status >= 500 || response.ok || response.status === 409) {
          return { state: 'uncertain', message };
        }
        return { state: 'failed', message };
      } catch { return { state: 'uncertain' }; }
    },
    async receipt(target: WebChatTarget, intent: WebChatIntent): Promise<WebChatResult> {
      try {
        const response = await request(`/api/agent/deliveries/caller/${encodeURIComponent(intent.deliveryId)}`);
        const body = await response.json();
        if (response.ok && body.data?.state === 'committed' && body.data.receipt?.endpoint?.sessionId === target.threadId) return { state: 'accepted' };
        if (response.ok && body.data?.state === 'prepared' && body.data.canSubmitSameIntent
          || response.status === 404 && body.errorCode === 'DELIVERY_NOT_RESERVED' && body.canSubmitSameIntent) return { state: 'retry' };
        return { state: 'uncertain', message: body.message };
      } catch { return { state: 'uncertain' }; }
    }
  };
}
