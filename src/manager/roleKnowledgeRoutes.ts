import http from "node:http";

export type RoleKnowledgeRouteHandler = (
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse
) => boolean;

export function createRoleKnowledgeRoutes(handler: RoleKnowledgeRouteHandler): RoleKnowledgeRouteHandler {
  return handler;
}
