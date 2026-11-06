import { decodeXiaomiVacuumMap } from "./vacuumMapDecoder.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";

type MapData = ReturnType<typeof decodeXiaomiVacuumMap>;
type Point = { x: number; y: number };
const reject = (code: string, message: string, status = 422): never => { throw new XiaomiHomeManagerApiError(status, `xiaomi_vacuum_path_${code}`, message); };
const validPoint = (value: Point): boolean => Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) <= 1e9 && Math.abs(value.y) <= 1e9;

/** Pure map planning, shared by UI and Agents. It never supplies a motion or arrival receipt. */
export function planVacuumMapPath(data: MapData, target: Point, clearanceMm = 250) {
  const g = data.grid, start = data.robotPosition, labels = g.labels;
  if (!g.cellSemanticsVerified || !labels) reject("semantics_unverified", "此型号的栅格含义尚未核对，不能规划路径。");
  if (!validPoint(target)) reject("target_invalid", "目标坐标必须是有限毫米数值。", 400);
  if (!Number.isInteger(clearanceMm) || clearanceMm < 200 || clearanceMm > 500) reject("clearance_invalid", "净空半径必须是200–500毫米整数。", 400);
  if (!start || !validPoint(start)) reject("position_missing", "当前地图没有机器人位置，不能猜测起点。");
  if (g.width * g.height > 1_000_000 || g.rotation !== 0) reject("geometry_unsupported", "此地图尺寸或旋转尚未支持路径规划。");
  const cells = Buffer.from(g.dataBase64, "base64"), extra = g.additionalDataBase64 ? Buffer.from(g.additionalDataBase64, "base64") : undefined;
  if (cells.length !== g.width * g.height || extra && extra.length !== cells.length) reject("grid_invalid", "栅格长度无法确认。");
  const constraints = data.map;
  // No guessed polygon key or movement-specific mode: unfamiliar non-empty restrictions stop planning.
  if (constraints.fb_regions !== undefined && (!Array.isArray(constraints.fb_regions) || constraints.fb_regions.length)) reject("restriction_unsupported", "禁行区域格式尚未核对，暂停路径规划。");
  const polygons = parseConstraints(constraints.hidden_zones, "zone_points", false);
  const walls = parseConstraints(constraints.fb_walls, "wall_points", true);
  if (cells.length * (polygons.reduce((n, p) => n + p.length, 0) + walls.length) > 20_000_000) reject("complexity_limit", "地图限制区域超出本次计算上限。");
  const blocked = new Uint8Array(cells.length);
  const center = (x: number, y: number): Point => ({ x: g.originX + (x + .5) * g.resolution, y: g.originY + (y + .5) * g.resolution });
  const room = labels!.roomGridRange;
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const i = y * g.width + x, cell = cells[i]!;
    blocked[i] = Number(!labels!.floor.includes(cell) && !(cell >= room[0]! && cell <= room[1]!)
      || Boolean(extra && (extra[i]! & ~labels!.additionalBits.carpet)));
    if (!blocked[i] && polygons.length) blocked[i] = Number(polygons.some(polygon => inPolygon(center(x, y), polygon)));
  }
  const stride = g.width + 1, sums = new Uint32Array((g.width + 1) * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let row = 0;
    for (let x = 0; x < g.width; x++) { row += blocked[y * g.width + x]!; sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + row; }
  }
  const radius = Math.ceil(clearanceMm / g.resolution) + 1, open = new Uint8Array(cells.length);
  for (let y = radius; y < g.height - radius; y++) for (let x = radius; x < g.width - radius; x++) {
    const left = x - radius, right = x + radius + 1, bottom = y - radius, top = y + radius + 1;
    const occupied = sums[top * stride + right]! - sums[bottom * stride + right]! - sums[top * stride + left]! + sums[bottom * stride + left]!;
    if (!occupied && !walls.some(wall => segmentDistance(center(x, y), wall[0]!, wall[1]!) <= clearanceMm + g.resolution * Math.SQRT2)) open[y * g.width + x] = 1;
  }
  const index = (p: Point) => { const x = Math.floor((p.x - g.originX) / g.resolution), y = Math.floor((p.y - g.originY) / g.resolution); return x < 0 || y < 0 || x >= g.width || y >= g.height ? -1 : y * g.width + x; };
  const from = index(start!), to = index(target);
  if (from < 0 || !open[from]) reject("start_blocked", "地图中的机器人起点没有足够净空，不能自动挪动起点。");
  if (to < 0 || !open[to]) reject("target_blocked", "目标位于墙、未知区域、禁行区域或净空不足的位置。");
  const path = search(open, g.width, from, to);
  const waypoints: Point[] = [{ x: start!.x, y: start!.y }];
  for (let n = 0; n < path.length; n++) {
    const i = path[n]!;
    if (n > 0 && n + 1 < path.length && i - path[n - 1]! === path[n + 1]! - i) continue;
    const p = center(i % g.width, Math.floor(i / g.width));
    if (Math.hypot(p.x - waypoints.at(-1)!.x, p.y - waypoints.at(-1)!.y) > 0) waypoints.push(p);
  }
  if (Math.hypot(target.x - waypoints.at(-1)!.x, target.y - waypoints.at(-1)!.y) > 0) waypoints.push({ ...target });
  if (waypoints.length > 4096) reject("complexity_limit", "路径复杂度超出本次规划上限。");
  return { schemaVersion: 1 as const, state: "planned" as const, start: { x: start!.x, y: start!.y }, target: { ...target }, clearanceMm,
    mapId: g.mapId, taskId: Number.isInteger(constraints.task_id) ? constraints.task_id : undefined,
    poseId: Number.isInteger(constraints.paths?.pose_id) ? constraints.paths.pose_id : undefined,
    waypoints, lengthMm: Math.round(waypoints.reduce((total, p, n) => n ? total + Math.hypot(p.x - waypoints[n - 1]!.x, p.y - waypoints[n - 1]!.y) : total, 0)),
    startSource: "cloud-map-snapshot" as const, poseFreshness: "unverified" as const, coordinateNavigation: false as const, movementCommandsSent: 0 as const };
}

function parseConstraints(value: unknown, key: string, line: boolean): Point[][] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256) return reject("restriction_invalid", "地图限制区域超出边界。");
  return value.map(item => {
    const points = item?.[key];
    if (!Array.isArray(points) || points.length % 2 || (line ? points.length !== 4 : points.length < 6 || points.length > 128)) return reject("restriction_invalid", "地图限制区域格式无法确认。");
    const result: Point[] = [];
    for (let i = 0; i < points.length; i += 2) {
      if (typeof points[i] !== "number" || typeof points[i + 1] !== "number") return reject("restriction_invalid", "地图限制坐标无法确认。");
      const point = { x: points[i], y: points[i + 1] }; if (!validPoint(point)) return reject("restriction_invalid", "地图限制坐标无法确认。"); result.push(point);
    }
    return result;
  });
}
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (segmentDistance(p, a, b) < 1e-6) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function search(open: Uint8Array, width: number, from: number, to: number): number[] {
  const costs = new Float64Array(open.length); costs.fill(Infinity); costs[from] = 0;
  const parents = new Int32Array(open.length); parents.fill(-1);
  const closed = new Uint8Array(open.length), heap: Array<{ i: number; f: number; g: number }> = [];
  const heuristic = (i: number) => Math.hypot(i % width - to % width, Math.floor(i / width) - Math.floor(to / width));
  const push = (item: typeof heap[number]) => { let n = heap.length; heap.push(item); while (n) { const p = (n - 1) >> 1; if (heap[p]!.f <= item.f) break; heap[n] = heap[p]!; n = p; } heap[n] = item; };
  const pop = () => { const result = heap[0]!, last = heap.pop()!; if (heap.length) { let n = 0; while (2 * n + 1 < heap.length) { let c = 2 * n + 1; if (c + 1 < heap.length && heap[c + 1]!.f < heap[c]!.f) c++; if (last.f <= heap[c]!.f) break; heap[n] = heap[c]!; n = c; } heap[n] = last; } return result; };
  push({ i: from, f: heuristic(from), g: 0 }); let expanded = 0, pushed = 1;
  while (heap.length) {
    const current = pop(), i = current.i;
    if (closed[i] || current.g !== costs[i]) continue;
    if (i === to) { const result: number[] = []; for (let p = to; p !== -1; p = parents[p]!) { result.push(p); if (result.length > 16384) reject("complexity_limit", "路径长度超出本次规划上限。"); } return result.reverse(); }
    if (++expanded > 250000) reject("complexity_limit", "本次路径搜索超出计算上限。"); closed[i] = 1;
    const x = i % width, y = Math.floor(i / width), height = open.length / width;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
      const next = i + dy * width + dx;
      if (!open[next] || closed[next] || dx && dy && (!open[i + dx] || !open[i + dy * width])) continue;
      const cost = current.g + (dx && dy ? Math.SQRT2 : 1);
      if (cost >= costs[next]!) continue;
      costs[next] = cost; parents[next] = i; push({ i: next, f: cost + heuristic(next), g: cost });
      if (++pushed > 500000) reject("complexity_limit", "本次路径搜索超出队列上限。");
    }
  }
  return reject("unreachable", "在当前地图及净空条件下没有可通行路径。");
}
