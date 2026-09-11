import type http from "node:http";
import { automaticCodeRuntime } from "../plugin-kernel/automaticCodeRuntime.js";

export function withAutomaticCodeRequest(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  return (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const lease = automaticCodeRuntime.acquireBoundary();
    const release = () => {
      response.off("finish", release);
      response.off("close", release);
      lease.release();
    };
    response.once("finish", release);
    response.once("close", release);
    response.setHeader("x-rabiroute-code-revision", String(lease.revision));
    try { lease.run(() => handler(request, response)); }
    catch (error) { release(); throw error; }
  };
}
