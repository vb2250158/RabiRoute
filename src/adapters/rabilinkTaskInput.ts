/** PC-owned interpretation of opaque Relay task input. Transport fields always win over client data. */
export function normalizeRabiLinkTaskInput(envelope: Record<string, unknown>): Record<string, unknown> {
  const raw = envelope.raw;
  if (envelope.inputFormat !== 'opaque-v1') throw new Error('TASK_FORMAT_UPGRADE_REQUIRED');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('RABILINK_INPUT_OBJECT_REQUIRED');
  const input = raw as Record<string, unknown>;
  const string = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const portable = envelope.ingressPath === '/api/rabilink/devices/input';
  const rokid = ['/rokid/rabilink/input', '/api/rokid/rabilink/input'].includes(String(envelope.ingressPath));
  const health = input.health && typeof input.health === 'object' && !Array.isArray(input.health) ? input.health as Record<string, unknown> : null;
  const hasHealth = health && Array.isArray(health.samples) && health.samples.length > 0;
  if (hasHealth && (envelope.expectedWorkerFencing !== true || !['transcribe', 'agent'].includes(String(input.processingPolicy)) || !string(input.routeProfileId))) {
    throw new Error('WEARABLE_PROCESSING_POLICY_OR_FENCE_REQUIRED');
  }
  const nested = input.data && typeof input.data === 'object' ? input.data as Record<string, unknown> : {};
  const last = Array.isArray(input.messages) ? input.messages.at(-1) : undefined;
  const lastValue = last && typeof last === 'object' ? last as Record<string, unknown> : {};
  const connection = envelope.source && typeof envelope.source === 'object' ? envelope.source as Record<string, unknown> : {};
  const bindingId = string(connection.connectionDeviceId);
  const text = [input.text, input.message, input.query, input.prompt, input.input, input.question, input.content, nested.text, nested.message, last, lastValue.content, lastValue.text, lastValue.message].map(string).find(Boolean)
    || (hasHealth ? 'Wearable health observation' : '');
  if (!text) throw new Error('RABILINK_INPUT_TEXT_REQUIRED');
  return {
    ...input,
    ...envelope,
    text, normalizedText: text.replace(/\s+/g, ' '),
    type: hasHealth ? 'wearable.health' : string(input.type) || (portable ? 'rabilink.observation' : rokid ? 'voice_transcript' : 'rabilink'),
    source: string(input.source) || (hasHealth ? 'rabilink-wearable' : portable ? 'rabilink-portable-device' : rokid ? 'rabilink-aiui' : 'rabilink'),
    sender: string(input.sender || input.user || input.deviceId),
    deliveryMode: hasHealth ? 'observe' : string(input.deliveryMode) || (portable ? 'observe' : ''),
    clientMessageId: string(input.clientMessageId || input.segmentId),
    sessionId: string(input.sessionId || input.conversationId),
    sourceDeviceId: bindingId && bindingId !== '$application' ? bindingId : string(input.sourceDeviceId || input.deviceId),
    sourceDeviceName: string(input.sourceDeviceName || input.deviceName),
    sourceDeviceKind: string(input.sourceDeviceKind || input.deviceKind).toLowerCase() || (portable ? 'other' : ''),
    transport: string(input.transport || input.sourceTransport).toLowerCase() || (portable ? 'direct-network' : ''),
    health: hasHealth ? health : input.health,
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 8) : []
  };
}
