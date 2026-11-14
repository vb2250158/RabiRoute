export const COMPUTER_IMAGE_VIEW_CAPABILITY = "imageView-v1";

/** Identify requests whose coordinates depend on the host's resized image. */
export function computerRequestUsesImageView(action, body = {}) {
  const source = body?.source;
  const view = source?.imageView;
  if (!view || source.coordinateSpace === "desktop" && !source.frameId) return false;
  if (view.width === source.width && view.height === source.height) return false;
  if (action === "input.execute") {
    const actions = Array.isArray(body.actions) ? body.actions : body.input ? [body.input] : [];
    return actions.some(item => item?.type === "move" || item?.type === "click" || item?.type === "drag"
      || item?.type === "scroll" && item.x !== undefined && item.y !== undefined);
  }
  return action === "annotation.show" || action === "annotation.update" || action === "annotation.track.start";
}

function resolveSchema(value, root) {
  const seen = new Set();
  while (value && typeof value === "object" && typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    value = value.$ref.slice(2).split("/").reduce((current, key) =>
      current?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return value;
}

/** Inspect the actual receiver contract, including its action-specific branches. */
export function computerRequestSchemaSupportsImageView(schema, action) {
  const pending = [schema];
  const seen = new Set();
  while (pending.length) {
    const current = resolveSchema(pending.pop(), schema);
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const actionSchema = resolveSchema(current.properties?.action, schema);
    if (actionSchema?.const !== undefined && actionSchema.const !== action) continue;
    if (Array.isArray(actionSchema?.enum) && !actionSchema.enum.includes(action)) continue;
    const source = resolveSchema(current.properties?.source, schema);
    const view = resolveSchema(source?.properties?.imageView, schema);
    if (view?.properties?.width && view?.properties?.height) return true;
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(current[keyword])) pending.push(...current[keyword]);
    }
  }
  return false;
}
