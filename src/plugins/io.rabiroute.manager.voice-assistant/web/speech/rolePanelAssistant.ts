import type { VoiceResponse } from "../../../../../packages/assistant-runtime/src/voice-interaction.js";

export type AssistantReply = {
  roleId: string; gatewayId?: string; messageId: string; replyToMessageId?: string; text: string;
};
export type AssistantAdmission = { messageId?: string; roleId?: string; uncertain?: boolean; message?: string };
type Options = {
  roleId: string;
  gatewayId: string;
  voice: { beginResponse(options: { id: string }): VoiceResponse };
  send(command: { gatewayId: string; text: string }): Promise<AssistantAdmission>;
  onReply(reply: AssistantReply): void;
  onAdmission(admission: AssistantAdmission): void;
  onError(error: unknown): void;
};

/** First-layer transport only. The selected native Agent owns prompt, tools and durable work. */
export function createRolePanelAssistant(options: Options) {
  if (!options.roleId || !options.gatewayId) throw new Error("ASSISTANT_ROUTE_SELECTION_REQUIRED");
  type Token = ReturnType<Options["voice"]["beginResponse"]>;
  type Turn = { token: Token; inputId?: string; sequence: number };
  let closed = false, sequence = 0, latest: Turn | undefined, pending = 0;
  const turns = new Map<string, Turn>();
  const deferred = new Map<string, AssistantReply>();
  const seen = new Set<string>();
  const retire = (turn?: Turn) => turn?.token.finish({ speak: false });
  function receive(reply: AssistantReply): boolean {
    if (closed || reply.roleId !== options.roleId || reply.gatewayId !== options.gatewayId
        || !reply.replyToMessageId || !reply.messageId || typeof reply.text !== "string" || seen.has(reply.messageId)) return false;
    const turn = turns.get(reply.replyToMessageId);
    if (!turn) {
      // A committed reply can beat its HTTP acceptance response. Buffer only while admission is in flight.
      if (pending && deferred.size < 64) deferred.set(reply.messageId, reply);
      return false;
    }
    seen.add(reply.messageId);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    options.onReply(reply); // Text remains visible even when voice for an older input has retired.
    if (turn === latest) {
      // A native Agent can commit progress and final messages for one input. A newline flushes each
      // committed message without pretending that HTTP admission or one delivery ended native work.
      turn.token.append(reply.text + "\n");
    }
    return true;
  }
  return Object.freeze({
    receive,
    async send(text: string) {
      if (closed || !text.trim()) return;
      if (pending >= 4) throw new Error("ASSISTANT_ADMISSION_BACKLOG_FULL");
      retire(latest);
      const turn: Turn = { sequence: ++sequence, token: options.voice.beginResponse({ id: `rabi-input-${sequence}` }) };
      latest = turn;
      pending++;
      try {
        const admission = await options.send({ gatewayId: options.gatewayId, text });
        if (closed) return;
        if (admission.roleId && admission.roleId !== options.roleId) throw new Error("ASSISTANT_ROLE_CHANGED");
        if (!admission.messageId) throw new Error(admission.message || "ASSISTANT_ADMISSION_UNCERTAIN_NO_RETRY");
        turn.inputId = admission.messageId;
        turns.set(admission.messageId, turn);
        if (turns.size > 64) {
          const oldest = [...turns].filter(([, value]) => value !== latest).sort((a, b) => a[1].sequence - b[1].sequence)[0];
          if (oldest) turns.delete(oldest[0]);
        }
        options.onAdmission(admission); // Accepted/uncertain is not model or tool completion.
        for (const [id, reply] of deferred) if (reply.replyToMessageId === admission.messageId) {
          deferred.delete(id);
          receive(reply);
        }
      } catch (error) {
        retire(turn);
        if (!closed) options.onError(error);
      } finally {
        pending--;
        if (!pending) deferred.clear();
      }
    },
    dispose() {
      if (closed) return;
      closed = true;
      retire(latest);
      turns.clear(); deferred.clear(); seen.clear();
      // No cancellation request: accepted model/tool work remains owned by the native Agent.
    }
  });
}
