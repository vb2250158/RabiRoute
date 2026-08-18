export type RequirementDeliveryReadbackState = "accepted" | "completed" | "in_progress" | "missing" | "uncertain";

export type RequirementDeliveryRecoveryResult = {
  state: Exclude<RequirementDeliveryReadbackState, "missing">;
};

function timeoutLike(error: unknown): boolean {
  return /timeout|timed out|aborted|connection closed|EPIPE/i.test(error instanceof Error ? error.message : String(error));
}

export async function deliverRequirementBatchWithRecovery(input: {
  deliveryId: string;
  deliver: () => Promise<RequirementDeliveryRecoveryResult>;
  readback: () => Promise<{ state: RequirementDeliveryReadbackState }>;
}): Promise<RequirementDeliveryRecoveryResult> {
  try {
    return await input.deliver();
  } catch (error) {
    if (!timeoutLike(error)) throw error;
    const readback = await input.readback();
    if (readback.state !== "missing") return { state: readback.state };
    return input.deliver();
  }
}
