export const compatibilityDefaults = Object.freeze(['remoteAgentDefaultDeviceId','remoteAgentDefaultCwd','remoteAgentDefaultThreadName']);
export function assertCurrentRemoteSurface({webgui, aiui, shared, runtime, owner}) {
  for (const name of compatibilityDefaults) {
    if (![aiui,shared,runtime].every(source=>source.includes(name))) throw new Error(`Missing compatibility default: ${name}`);
  }
  for (const marker of ['gateway.value?.remoteAgentTargets','target.instanceId','target.agentId','<InstanceAgentSettings',':instance="target.instance"',':agent="target.agent"']) {
    if (!webgui.includes(marker)) throw new Error(`Missing current remote UI binding: ${marker}`);
  }
  if (!owner.includes('return "local"') || !owner.includes('legacy-remote-observer')) throw new Error('Missing explicit inference owner boundary');
}
export function missingSharedFields(fields, exposed) { return fields.filter(field=>!exposed.has(field)); }
