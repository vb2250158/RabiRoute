import type http from "node:http";
import { managerReadHttpResponse } from "./managerReadHttpResponse.js";

type Context = {
  querySkills: (roleDir: string, skillId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
};

/** Both list and detail use the same bounded interactive reader, after role authorization. */
export function respondRoleSkillRead(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  roleDir: string,
  skillId: string | undefined,
  context: Context
): Promise<void> {
  return managerReadHttpResponse(request, response, {
    read: signal => context.querySkills(roleDir, skillId, { signal }),
    json: context.json,
    errorStatus: 500,
    respond: data => {
      if (skillId && !data) {
        context.json(response, 404, { code: -1, message: `Skill not found: ${skillId}` });
        return;
      }
      context.json(response, 200, { code: 0, data });
    }
  });
}
