export function wireBend(from, to) {
  return Math.max(70, Math.abs(to.x - from.x) * 0.45);
}

export function wirePath(from, to) {
  const bend = wireBend(from, to);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

export function canvasGraphThumbnail(canvas) {
  const visibleNodes = canvas.graph.nodes.slice(0, 120);
  if (!visibleNodes.length) return;
  const nodes = visibleNodes.map((node, index) => ({
    id: node.id,
    x: node.layout?.x ?? 416 * (index % 4),
    y: node.layout?.y ?? 224 * Math.floor(index / 4),
    width: node.layout?.width ?? 380,
    height: node.layout?.height ?? (node.config.legacyCardId || node.config.textOutput ? 214 : 76),
    enabled: node.enabled !== false,
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const inputLinks = [];
  for (const node of visibleNodes) {
    if (typeof node.config.legacyCardId === "string") byId.set(node.config.legacyCardId, byId.get(node.id));
  }
  for (const node of visibleNodes) {
    const inputs = new Set((node.inputs ?? []).filter(input => typeof input?.artifactKey === "string").map(input => input.producerNodeId));
    for (const from of inputs) if (from !== node.id && byId.has(from)) inputLinks.push({ from, to: node.id });
  }
  const wires = [...canvas.graph.edges, ...(canvas.mediaLinks ?? []), ...inputLinks].slice(0, 240).flatMap(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) return [];
    return [wirePath({ x: from.x + from.width, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 })];
  });
  const left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + node.width)), bottom = Math.max(...nodes.map(node => node.y + node.height));
  return { viewBox: `${left - 80} ${top - 80} ${right - left + 160} ${bottom - top + 160}`, nodes, wires };
}
