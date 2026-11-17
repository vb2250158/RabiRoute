/** Local identity lookup is separate from permission to dispatch Agent work. */
export function createVoiceAssistantHostAccess(options: {
  readOnly(): boolean;
  assertActive(): void;
  deliveryAuthorityId(): string;
}) {
  return Object.freeze({
    deliveryAuthorityId() {
      options.assertActive();
      return options.deliveryAuthorityId();
    },
    assertSendAllowed() {
      options.assertActive();
      if (options.readOnly()) throw new Error("Agent sender admission is unavailable.");
    }
  });
}
