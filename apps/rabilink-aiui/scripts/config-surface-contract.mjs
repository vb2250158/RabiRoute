export const compatibilityDefaults = Object.freeze(['remoteAgentDefaultDeviceId','remoteAgentDefaultCwd','remoteAgentDefaultThreadName']);
// normalizeGatewayDefinition explicitly removes these legacy input fields.
// config-surface-contract.test.mjs executes the shared normalizer to verify this list.
export const retiredGatewayFields = Object.freeze(['grokBotProfilePath', 'grokBotBackendUrl', 'fenneNoteWebhookPort', 'fenneNoteWebhookPath']);
export function assertRetiredGatewayFields(normalize) {
  const input = { id: 'retired-field-check', gatewayPort: 8790, messageAdapters: ['webhook'], agentAdapters: [],
    grokBotProfilePath: 'legacy-profile', grokBotBackendUrl: 'https://legacy.invalid', fenneNoteWebhookPort: 8799, fenneNoteWebhookPath: '/legacy' };
  const output = normalize(input);
  for (const field of retiredGatewayFields) if (Object.hasOwn(output, field)) throw new Error(`Retired field is still saved: ${field}`);
}
export function assertCurrentRemoteSurface({webgui, aiui, shared, runtime, owner}) {
  for (const name of compatibilityDefaults) {
    if (![aiui,shared,runtime].every(source=>source.includes(name))) throw new Error(`Missing compatibility default: ${name}`);
  }
  for (const marker of ['gateway.value?.remoteAgentTargets','target.instanceId','target.agentId','<InstanceAgentSettings',':instance="target.instance"',':agent="target.agent"']) {
    if (!webgui.includes(marker)) throw new Error(`Missing current remote UI binding: ${marker}`);
  }
  if (!owner.includes('this.ensureChatModel()') || !owner.includes('this.executeLingzhuAgentPrompt(delivery.prompt,{deviceContext:') || owner.includes('legacy-remote-observer')) throw new Error('Missing actual device inference owner boundary');
}
export function missingSharedFields(fields, exposed) { return fields.filter(field=>!retiredGatewayFields.includes(field) && !exposed.has(field)); }
