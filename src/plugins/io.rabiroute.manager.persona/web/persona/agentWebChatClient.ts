import { webChatHostCanReadUploads, type WebChatAttachment } from '@shared/agentWebChat';
import type { PersonaSessionAgent } from './agentSessionClient';

export type WebChatTarget = { key: string; agent: PersonaSessionAgent; threadId: string };
export type WebChatIntent = { deliveryId: string; prompt: string; webChatAttachments: WebChatAttachment[] };
type WebChatResult = { state: 'accepted' | 'failed' | 'uncertain' | 'retry'; message?: string };
type WebChatCallerReceipt = {
  data?: { state?: string; deliveryId?: string; canSubmitSameIntent?: boolean; receipt?: { endpoint?: { sessionId?: string } } };
  message?: string;
  errorCode?: string;
  canSubmitSameIntent?: boolean;
};

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
  const acceptedReceipt = (body: WebChatCallerReceipt, threadId: string) => body.data?.state === 'committed'
    && body.data.receipt?.endpoint?.sessionId === threadId;
  async function receipt(target: WebChatTarget, intent: WebChatIntent): Promise<WebChatResult> {
    try {
      const lookup = () => request(`/api/agent/deliveries/caller/${encodeURIComponent(intent.deliveryId)}`);
      const response = await lookup();
      const body = await response.json() as WebChatCallerReceipt;
      if (response.ok && acceptedReceipt(body, target.threadId)) return { state: 'accepted' };
      if (response.ok && body.data?.state === 'prepared' && body.data.canSubmitSameIntent
        || response.status === 404 && body.errorCode === 'DELIVERY_NOT_RESERVED' && body.canSubmitSameIntent) return { state: 'retry' };

      // Resolve the original Manager ID from the authenticated caller lookup.
      // This endpoint checks native evidence without re-dispatching the message.
      const originalId = body.data?.deliveryId;
      if (response.ok && body.data?.state === 'dispatching' && typeof originalId === 'string' && originalId) {
        const reconciled = await request(`/api/agent/deliveries/${encodeURIComponent(originalId)}/reconcile`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
        });
        if (reconciled.ok) {
          const confirmed = await lookup();
          if (confirmed.ok && acceptedReceipt(await confirmed.json(), target.threadId)) return { state: 'accepted' };
        }
      }
      return { state: 'uncertain', message: body.message };
    } catch { return { state: 'uncertain' }; }
  }
  return {
    async send(target: WebChatTarget, intent: WebChatIntent): Promise<WebChatResult> {
      const { agent, threadId } = target;
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
        if (agent.provider === 'workbuddy' && body.status === 'delivery_unconfirmed') {
          const checked = await receipt(target, intent);
          if (checked.state === 'accepted') return checked;
        }
        if (body.uncertain || body.status === 'delivery_unconfirmed' || response.status >= 500 || response.ok || response.status === 409) {
          return { state: 'uncertain', message };
        }
        return { state: 'failed', message };
      } catch { return { state: 'uncertain' }; }
    },
    receipt
  };
}
