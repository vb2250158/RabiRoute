/** Safe protocol fields for receipts; raw upstream text can contain private paths. */
export class NapCatRequestError extends Error {
  constructor(message: string, readonly diagnostic: {
    action: string; kind: "http" | "rejected" | "transport" | "invalid_response";
    httpStatus?: number; retcode?: number; transportCode?: string;
  }) { super(message); this.name = "NapCatRequestError"; }
}
