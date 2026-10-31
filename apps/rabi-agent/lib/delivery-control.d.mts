import type { ReliableDeliveryInput, DeliveryQuery, DeliveryPage } from "./delivery-owner.mjs";
export type LocalDeliveryReceipt = { ok: boolean; accepted?: boolean | null; acceptance?: "local-durable"; intentId?: string; deliveryId?: string; error?: string; guidance?: string; record?: Record<string, unknown> };
export function requestDeliveryControl(configPath: string, operation: "submit" | "query", params: unknown, options?: { timeoutMs?: number }): Promise<LocalDeliveryReceipt & Partial<DeliveryPage>>;
export function submitDeliveryToOwner(configPath: string, input: Omit<ReliableDeliveryInput, "intentId"> & { intentId?: string }): Promise<LocalDeliveryReceipt>;
export function runDeliveryCommand(args: string[], configPath: string, readInput: () => Promise<string>): Promise<LocalDeliveryReceipt>;
export function createReliableDeliveryClient(options: { configPath: string; agentType: string; sessionId: string }): Readonly<{
  submit(request: Record<string, unknown>, options?: { intentId?: string }): Promise<LocalDeliveryReceipt>;
  get(intentId: string): Promise<LocalDeliveryReceipt & Partial<DeliveryPage>>;
  list(options?: DeliveryQuery): Promise<LocalDeliveryReceipt & Partial<DeliveryPage>>;
}>;
export function rememberDeliveryDescriptor(configPath: string | undefined, catalog: Record<string, unknown>, identity: { applicationGenerationId: string; managerInstanceId: string } | undefined, expectedGuid?: string): void;
export function readDeliveryDescriptor(configPath: string | undefined, operationId: string): Record<string, unknown> | undefined;
