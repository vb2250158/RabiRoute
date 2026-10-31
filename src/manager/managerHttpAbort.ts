import type http from "node:http";

/** Record a connection closed before the response finished; normal completion is owned by the finish listener. */
export function observeManagerHttpAbort(response: http.ServerResponse, record: () => void): void {
  response.once("close", () => {
    if (!response.writableFinished) record();
  });
}
