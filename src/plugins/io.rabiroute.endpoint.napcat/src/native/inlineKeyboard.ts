import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { NapcatApiError, verifyNapcatApiIdentity, type NapcatApiSelection, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
export const inlineKeyboardParameters = {
    type: "object", additionalProperties: false, required: ["source", "bot_appid", "button_id", "callback_data", "msg_seq"], properties: {
        source: { type: "object", additionalProperties: false, required: ["kind", "targetId", "messageId"], properties: {
                kind: { const: "group" }, targetId: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
                messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }
            } },
        bot_appid: { type: "string", minLength: 1, maxLength: 1024 }, button_id: { type: "string", maxLength: 1024 },
        callback_data: { type: "string", maxLength: 65536 }, msg_seq: { type: "string", pattern: "^[0-9]{1,20}$" }
    }
};
export const inlineKeyboardDescription = "The original exact group message proves conversation access. Caller supplies the published native bot_appid/button_id/callback_data/msg_seq coordinates; the native platform validates that button protocol. When the original response includes message_seq it must match. The source reader does not claim an independently parsed keyboard/button catalog.";
export async function prepareInlineKeyboard(context: NapcatApiTransportContext, selection: NapcatApiSelection, parameters: Record<string, unknown>, signal: AbortSignal) {
    const source = parameters.source as {
        kind: "group";
        targetId: string;
        messageId: string;
    };
    await verifyNapcatApiIdentity(context, selection, signal);
    const message = await readExactQqMessage({ endpoint: selection, kind: "group", target: source.targetId, messageId: source.messageId,
        current: selection.assertCurrent, signal, transport: context.transport });
    const sequence = (message as unknown as Record<string, unknown>).message_seq;
    if (sequence !== undefined && String(sequence) !== parameters.msg_seq) {
        throw new NapcatApiError(409, "QQ_INLINE_KEYBOARD_SOURCE_SEQUENCE_CHANGED");
    }
    selection.assertCurrent();
    return { parameters: { group_id: source.targetId, bot_appid: parameters.bot_appid, button_id: parameters.button_id,
            callback_data: parameters.callback_data, msg_seq: parameters.msg_seq }, digest: { source, sequence: sequence ?? null } };
}
