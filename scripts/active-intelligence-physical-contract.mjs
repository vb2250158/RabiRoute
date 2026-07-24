export const PHYSICAL_OBSERVATION_SCHEMA_VERSION = 1;
export const PHYSICAL_OBSERVATION_KIND = "active_intelligence_physical_observation";

export const PHYSICAL_OBSERVATION_CHECKS = Object.freeze([
  { id: "personaSyncDistinctPhysicalHosts", domain: "personaSync", description: "Two distinct physical PCs participated." },
  { id: "personaSyncLan", domain: "personaSync", description: "Persona synchronization completed over the LAN data plane." },
  { id: "personaSyncRelayFallback", domain: "personaSync", description: "Persona synchronization recovered through Relay fallback." },
  { id: "personaSyncDisconnectRecovery", domain: "personaSync", description: "Synchronization recovered after a real disconnect." },
  { id: "personaSyncConflictResolution", domain: "personaSync", description: "A real conflict was resolved and convergence was confirmed." },
  { id: "personaSyncLongRun", domain: "personaSync", description: "Long-running physical synchronization remained healthy." },
  { id: "androidOfflineRecovery", domain: "android", description: "Android automatically recovered after a real offline interval." },
  { id: "androidProcessReclaimRecovery", domain: "android", description: "Android recovered after system process reclaim." },
  { id: "androidBootRecovery", domain: "android", description: "Android recovered after a device reboot." },
  { id: "androidPhonePlayback", domain: "android", description: "Reply audio was audibly played by the phone." },
  { id: "rokidContinuousPcm", domain: "rokid", description: "Rokid continuously streamed valid PCM to the PC." },
  { id: "rokidTouchpad", domain: "rokid", description: "Rokid touchpad controls worked on the physical device." },
  { id: "rokidPlaybackHeard", domain: "rokid", description: "Reply audio was audibly played by Rokid glasses." },
  { id: "rokidConnectionRecovery", domain: "rokid", description: "Rokid recovered after a real connection interruption." }
]);

export const ALL_PHYSICAL_OBSERVATION_CHECK_IDS = Object.freeze(
  PHYSICAL_OBSERVATION_CHECKS.map(item => item.id)
);

export const REQUIRED_PERSONA_CHECKS = Object.freeze(
  PHYSICAL_OBSERVATION_CHECKS.filter(item => item.domain === "personaSync").map(item => item.id)
);

export const REQUIRED_ANDROID_CHECKS = Object.freeze(
  PHYSICAL_OBSERVATION_CHECKS.filter(item => item.domain === "android").map(item => item.id)
);

export const REQUIRED_ROKID_CHECKS = Object.freeze(
  PHYSICAL_OBSERVATION_CHECKS.filter(item => item.domain === "rokid").map(item => item.id)
);

export function emptyPhysicalObservationChecks() {
  return Object.fromEntries(ALL_PHYSICAL_OBSERVATION_CHECK_IDS.map(id => [id, false]));
}

export function isPhysicalObservationChecks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...ALL_PHYSICAL_OBSERVATION_CHECK_IDS].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && expected.every(id => typeof value[id] === "boolean");
}
