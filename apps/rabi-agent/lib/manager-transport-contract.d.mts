export const MANAGER_TRANSPORT_ABI: 1;
export const MANAGER_CONTEXT_HEADER: "x-rabiroute-manager-context";
export const EXPECTED_MANAGER_GENERATION_HEADER: "x-rabiroute-expected-application-generation-id";
export const EXPECTED_MANAGER_INSTANCE_HEADER: "x-rabiroute-expected-manager-instance-id";
export type ManagerTransportContext = Readonly<{abi:1;applicationGenerationId:string;managerInstanceId:string;metadataRevision:string}>;
export function managerContextFromHeaders(headers: unknown): ManagerTransportContext | undefined;
