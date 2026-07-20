import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_BASE_CONTEXT_CHARS = 5000;
const MAX_RECALL_CONTEXT_CHARS = 2400;
const MAX_HOOK_CONTEXT_CHARS = 6200;
const CONTROL_PATTERN = /\[rabi:(use|bind)\s+([^\]\r\n]{1,80})\]|\[rabi:(status|refresh|off)\]/i;

function nowIso() {
  return new Date().toISOString();
}

function expandHome(inputPath) {
  const value = String(inputPath || "").trim();
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveRabiCodexHome(env = process.env) {
  const configured = String(env.RABI_CODEX_HOME || "").trim();
  return path.resolve(expandHome(configured || path.join(os.homedir(), ".rabi", "codex")));
}

function storePaths(home) {
  return {
    config: path.join(home, "config.json"),
    bindings: path.join(home, "session-bindings.json"),
    hookState: path.join(home, "hook-state.json"),
    localRoles: path.join(home, "roles")
  };
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath, fallback) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, targetPath);
}

function defaultConfig(home) {
  return {
    version: STORE_VERSION,
    roleRoots: [
      {
        id: "local",
        label: "Rabi local roles",
        path: storePaths(home).localRoles
      }
    ]
  };
}

function normalizeRoleId(roleId) {
  const value = String(roleId || "").trim();
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("Role ID must be a non-empty folder name without path separators.");
  }
  return value;
}

function normalizeSourceId(sourceId) {
  const value = String(sourceId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("Source ID must use 1-64 letters, digits, dots, underscores, or hyphens.");
  }
  return value;
}

export async function ensureStore(home = resolveRabiCodexHome()) {
  const paths = storePaths(home);
  await fs.mkdir(paths.localRoles, { recursive: true });
  if (!(await exists(paths.config))) await writeJsonAtomic(paths.config, defaultConfig(home));
  if (!(await exists(paths.bindings))) await writeJsonAtomic(paths.bindings, { version: STORE_VERSION, sessions: {} });
  return paths;
}

export async function readConfig(home = resolveRabiCodexHome()) {
  const paths = await ensureStore(home);
  const config = await readJson(paths.config, defaultConfig(home));
  const roleRoots = Array.isArray(config.roleRoots) ? config.roleRoots : [];
  return {
    version: STORE_VERSION,
    roleRoots: roleRoots
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: normalizeSourceId(item.id),
        label: String(item.label || item.id),
        path: path.resolve(expandHome(item.path))
      }))
  };
}

export async function addRoleRoot({ id, rootPath, label }, home = resolveRabiCodexHome()) {
  const paths = await ensureStore(home);
  const config = await readConfig(home);
  const sourceId = normalizeSourceId(id);
  const absolutePath = path.resolve(expandHome(rootPath));
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Role root does not exist or is not a directory: ${absolutePath}`);
  const next = {
    version: STORE_VERSION,
    roleRoots: [
      ...config.roleRoots.filter((item) => item.id !== sourceId),
      { id: sourceId, label: String(label || sourceId), path: absolutePath }
    ]
  };
  await writeJsonAtomic(paths.config, next);
  return next.roleRoots.find((item) => item.id === sourceId);
}

async function discoverWorkspaceRoleRoots(cwd) {
  const roots = [];
  let current = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(current, "data", "roles");
    if (await exists(candidate)) roots.push({ id: `workspace-${depth}`, label: "Workspace Rabi roles", path: candidate });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function roleAtRoot(root, roleId) {
  const roleDir = path.join(root.path, roleId);
  if (!(await exists(path.join(roleDir, "persona.md")))) return null;
  return { roleId, roleDir, rootId: root.id, rootLabel: root.label, rootPath: root.path };
}

export async function findRole(roleId, options = {}) {
  const normalizedRoleId = normalizeRoleId(roleId);
  const home = options.home || resolveRabiCodexHome();
  const config = await readConfig(home);
  const workspaceRoots = await discoverWorkspaceRoleRoots(options.cwd || process.cwd());
  const roots = [...workspaceRoots, ...config.roleRoots];
  const preferredRootId = String(options.rootId || "").trim();
  const ordered = preferredRootId
    ? [...roots.filter((item) => item.id === preferredRootId), ...roots.filter((item) => item.id !== preferredRootId)]
    : roots;
  for (const root of ordered) {
    const found = await roleAtRoot(root, normalizedRoleId);
    if (found) return found;
  }
  return null;
}

export async function listRoles(options = {}) {
  const home = options.home || resolveRabiCodexHome();
  const config = await readConfig(home);
  const workspaceRoots = await discoverWorkspaceRoleRoots(options.cwd || process.cwd());
  const result = [];
  const seen = new Set();
  for (const root of [...workspaceRoots, ...config.roleRoots]) {
    const entries = await fs.readdir(root.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await roleAtRoot(root, entry.name);
      if (!found) continue;
      const key = path.resolve(found.roleDir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(found);
    }
  }
  return result.sort((left, right) => left.roleId.localeCompare(right.roleId) || left.rootId.localeCompare(right.rootId));
}

async function countRolesAtRoot(root) {
  const entries = await fs.readdir(root.path, { withFileTypes: true }).catch(() => []);
  const roles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => roleAtRoot(root, entry.name)));
  return roles.filter(Boolean).length;
}

async function readBindings(home) {
  const paths = await ensureStore(home);
  const payload = await readJson(paths.bindings, { version: STORE_VERSION, sessions: {} });
  return { paths, payload: { version: STORE_VERSION, sessions: payload.sessions && typeof payload.sessions === "object" ? payload.sessions : {} } };
}

export async function bindSession({ sessionId, roleId, rootId, cwd }, home = resolveRabiCodexHome()) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("A real Codex session ID is required.");
  const role = await findRole(roleId, { home, rootId, cwd });
  if (!role) throw new Error(`Rabi role not found: ${normalizeRoleId(roleId)}`);
  const { paths, payload } = await readBindings(home);
  const previous = payload.sessions[id];
  const timestamp = nowIso();
  const binding = {
    sessionId: id,
    roleId: role.roleId,
    rootId: role.rootId,
    roleDir: role.roleDir,
    enabled: true,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp
  };
  payload.sessions[id] = binding;
  await writeJsonAtomic(paths.bindings, payload);
  return binding;
}

export async function getBinding(sessionId, home = resolveRabiCodexHome()) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const { payload } = await readBindings(home);
  const binding = payload.sessions[id];
  return binding?.enabled === true ? binding : null;
}

export async function listBindings(home = resolveRabiCodexHome()) {
  const { payload } = await readBindings(home);
  return Object.values(payload.sessions).filter((item) => item && item.enabled === true);
}

export async function unbindSession(sessionId, home = resolveRabiCodexHome()) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("A real Codex session ID is required.");
  const { paths, payload } = await readBindings(home);
  const previous = payload.sessions[id] || null;
  delete payload.sessions[id];
  await writeJsonAtomic(paths.bindings, payload);
  return previous;
}

async function walkJsonFiles(rootDir, limit = 200) {
  const result = [];
  const pending = [rootDir];
  while (pending.length && result.length < limit) {
    const current = pending.shift();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) result.push(target);
      if (result.length >= limit) break;
    }
  }
  return result;
}

async function loadItems(rootDir, kind) {
  const files = await walkJsonFiles(rootDir);
  const result = [];
  for (const file of files) {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      const id = String(value.id || value.planId || value.memoryId || path.basename(file, ".json"));
      const title = String(value.focus || value.title || value.name || id).trim();
      const status = String(value.status || "").trim();
      const keywords = Array.isArray(value.keywords) ? value.keywords.map(String).filter(Boolean) : [];
      result.push({
        kind,
        id,
        title,
        status,
        keywords,
        content: String(value.content || value.currentStep || value.summary || "").trim(),
        nextAction: String(value.nextAction || "").trim(),
        updatedAt: String(value.updatedAt || value.viewedAt || value.createdAt || "")
      });
    } catch {
      // A malformed knowledge item must not disable the whole hook.
    }
  }
  return result.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

async function readOptionalText(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

function excerpt(text, limit, tail = 0) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  if (tail > 0 && limit > tail + 80) {
    const headLength = limit - tail - 45;
    return `${value.slice(0, headLength).trimEnd()}\n\n[...Rabi context clipped...]\n\n${value.slice(-tail).trimStart()}`;
  }
  return `${value.slice(0, Math.max(0, limit - 35)).trimEnd()}\n[...Rabi context clipped...]`;
}

function itemIndex(items, limit) {
  return items.slice(0, limit).map((item) => {
    const status = item.status ? `（${item.status}）` : "";
    return `- ${item.id}: ${item.title}${status}`;
  }).join("\n") || "- 暂无";
}

async function listRoleSkillFiles(roleDir) {
  const skillsDir = path.join(roleDir, "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.basename(entry.name, path.extname(entry.name)))
    .sort();
}

export async function loadRoleContext(binding) {
  const roleDir = path.resolve(binding.roleDir);
  const persona = await readOptionalText(path.join(roleDir, "persona.md"));
  if (!persona) throw new Error(`Bound Rabi role is missing persona.md: ${binding.roleId}`);
  const [growth, skills, plans, memories, roleSkills] = await Promise.all([
    readOptionalText(path.join(roleDir, "growth.md")),
    readOptionalText(path.join(roleDir, "skills.md")),
    loadItems(path.join(roleDir, "plans"), "plan"),
    loadItems(path.join(roleDir, "memory", "recent"), "memory"),
    listRoleSkillFiles(roleDir)
  ]);
  return { roleDir, persona, growth, skills, plans, memories, roleSkills };
}

export async function renderBaseContext(binding) {
  const context = await loadRoleContext(binding);
  const sections = [
    "[Rabi Codex 会话人格]",
    "用户已显式把当前 Codex 会话绑定到以下 Rabi 人格。只对当前会话生效；不得把该绑定扩散到其他会话。",
    `角色 ID：${binding.roleId}`,
    `上下文源：${binding.rootId}`,
    "人格与知识文件仍是唯一真源；本段是受 Hook 输出限制的工作集。遇到截断或冲突时，应说明不确定性，不得补造设定。",
    "",
    "[人格工作集]",
    excerpt(context.persona, 3000, 750)
  ];
  if (context.growth) sections.push("", "[成长规则摘要]", excerpt(context.growth, 350));
  if (context.skills) sections.push("", "[角色技能摘要]", excerpt(context.skills, 350));
  sections.push("", "[计划索引]", itemIndex(context.plans.filter((item) => item.status !== "已归档"), 4));
  sections.push("", "[近期记忆索引]", itemIndex(context.memories, 5));
  if (context.roleSkills.length) sections.push("", "[可用角色技能]", context.roleSkills.slice(0, 8).map((id) => `- ${id}`).join("\n"));
  sections.push("", "处理消息前，先用当前消息匹配计划、记忆与角色技能；Hook 会在后续用户轮次补充少量高相关正文。技术事实、权限与安全边界优先于人格表达。");
  return excerpt(sections.join("\n"), MAX_BASE_CONTEXT_CHARS, 500);
}

function scoreItem(prompt, item) {
  const haystack = String(prompt || "").toLocaleLowerCase();
  if (!haystack) return 0;
  let score = 0;
  const id = item.id.toLocaleLowerCase();
  const title = item.title.toLocaleLowerCase();
  if (id && haystack.includes(id)) score += 100;
  if (title && title.length >= 2 && haystack.includes(title)) score += 80;
  for (const keyword of item.keywords) {
    const token = keyword.toLocaleLowerCase().trim();
    if (token.length >= 2 && haystack.includes(token)) score += 20;
  }
  return score;
}

export async function renderRecallContext(binding, prompt) {
  const context = await loadRoleContext(binding);
  const matched = [...context.plans, ...context.memories]
    .map((item) => ({ ...item, score: scoreItem(prompt, item) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 4);
  if (!matched.length) return "";
  const lines = ["[Rabi 本轮相关上下文]", "以下条目由当前用户消息与 ID、标题或 keywords 的显式匹配选出："];
  for (const item of matched) {
    lines.push("", `## ${item.kind === "plan" ? "计划" : "近期记忆"} ${item.id}: ${item.title}`);
    if (item.status) lines.push(`状态：${item.status}`);
    if (item.content) lines.push(excerpt(item.content, 900));
    if (item.nextAction) lines.push(`下一步：${excerpt(item.nextAction, 450)}`);
  }
  return excerpt(lines.join("\n"), MAX_RECALL_CONTEXT_CHARS, 300);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readHookState(home) {
  const paths = await ensureStore(home);
  const payload = await readJson(paths.hookState, { version: STORE_VERSION, sessions: {} });
  return { paths, payload: { version: STORE_VERSION, sessions: payload.sessions && typeof payload.sessions === "object" ? payload.sessions : {} } };
}

async function updateHookState(sessionId, patch, home) {
  const { paths, payload } = await readHookState(home);
  if (patch === null) delete payload.sessions[sessionId];
  else payload.sessions[sessionId] = { ...(payload.sessions[sessionId] || {}), ...patch };
  await writeJsonAtomic(paths.hookState, payload);
  return payload.sessions[sessionId] || null;
}

export function parseControl(prompt) {
  const match = CONTROL_PATTERN.exec(String(prompt || ""));
  if (!match) return null;
  if (match[1]) return { action: "use", roleId: match[2].trim() };
  return { action: match[3].toLowerCase() };
}

function hookOutput(eventName, additionalContext, systemMessage) {
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: excerpt(additionalContext, MAX_HOOK_CONTEXT_CHARS, 500)
    }
  };
  if (systemMessage) output.systemMessage = systemMessage;
  return output;
}

function bindingStatus(binding) {
  return binding
    ? `[Rabi Codex 绑定状态]\n当前会话已绑定人格：${binding.roleId}\n上下文源：${binding.rootId}`
    : "[Rabi Codex 绑定状态]\n当前会话没有绑定 Rabi 人格。";
}

export async function handleHookInput(input, options = {}) {
  const eventName = String(input?.hook_event_name || "");
  if (eventName !== "SessionStart" && eventName !== "UserPromptSubmit") return null;
  const sessionId = String(input?.session_id || "").trim();
  if (!sessionId) return null;
  const cwd = String(input?.cwd || process.cwd());
  const prompt = eventName === "UserPromptSubmit" ? String(input?.prompt || "") : "";
  const home = options.home || resolveRabiCodexHome(options.env || process.env);
  const control = eventName === "UserPromptSubmit" ? parseControl(prompt) : null;
  let binding = await getBinding(sessionId, home);
  let forceBase = eventName === "SessionStart";

  if (control?.action === "off") {
    await unbindSession(sessionId, home);
    await updateHookState(sessionId, null, home);
    return hookOutput(eventName, "[Rabi Codex]\n用户已显式解除当前会话的人格绑定。后续轮次不得继续沿用此前注入的人格、计划或记忆。", "Rabi persona context disabled for this session.");
  }
  if (control?.action === "use") {
    try {
      binding = await bindSession({ sessionId, roleId: control.roleId, cwd }, home);
      forceBase = true;
    } catch (error) {
      const roles = await listRoles({ home, cwd });
      const available = roles.length ? roles.map((item) => item.roleId).join(", ") : "none";
      return hookOutput(eventName, `[Rabi Codex]\n无法绑定人格 ${control.roleId}：${error instanceof Error ? error.message : String(error)}\n可用角色 ID：${available}`, "Rabi persona binding failed.");
    }
  }
  if (control?.action === "status") return hookOutput(eventName, bindingStatus(binding));
  if (control?.action === "refresh" && binding) {
    try {
      binding = await bindSession({
        sessionId,
        roleId: binding.roleId,
        rootId: binding.rootId,
        cwd
      }, home);
      forceBase = true;
    } catch (error) {
      return hookOutput(eventName, `[Rabi Codex]\n无法刷新人格 ${binding.roleId}：${error instanceof Error ? error.message : String(error)}\n保留原会话绑定，但本轮不注入无法确认的上下文。`, "Rabi persona refresh failed.");
    }
  }
  if (!binding) return null;

  try {
    const base = await renderBaseContext(binding);
    const baseFingerprint = sha256(base);
    const { payload: statePayload } = await readHookState(home);
    const previousState = statePayload.sessions[sessionId] || {};
    const includeBase = forceBase || previousState.baseFingerprint !== baseFingerprint;
    const recall = eventName === "UserPromptSubmit" ? await renderRecallContext(binding, prompt) : "";
    const context = [includeBase ? base : "", recall].filter(Boolean).join("\n\n");
    await updateHookState(sessionId, {
      baseFingerprint,
      roleId: binding.roleId,
      promptCount: Number(previousState.promptCount || 0) + (eventName === "UserPromptSubmit" ? 1 : 0),
      lastEvent: eventName,
      updatedAt: nowIso()
    }, home);
    if (!context) return null;
    return hookOutput(eventName, context, control?.action === "use" ? `Rabi persona ${binding.roleId} bound to this session.` : undefined);
  } catch (error) {
    return hookOutput(eventName, `[Rabi Codex]\n人格 ${binding.roleId} 的上下文加载失败：${error instanceof Error ? error.message : String(error)}\n不要补造缺失的人格、计划或记忆。`, "Rabi context loading failed; Codex continued without invented context.");
  }
}

export async function doctor(options = {}) {
  const home = options.home || resolveRabiCodexHome();
  const config = await readConfig(home);
  const roles = await listRoles({ home, cwd: options.cwd || process.cwd() });
  const bindings = await listBindings(home);
  const roleRoots = await Promise.all(config.roleRoots.map(async (item) => ({
    ...item,
    available: await exists(item.path),
    roleCount: await countRolesAtRoot(item)
  })));
  return {
    ok: true,
    home,
    node: process.version,
    roleRoots,
    roles: roles.map((item) => ({ roleId: item.roleId, rootId: item.rootId })),
    bindings: bindings.map((item) => ({ sessionId: item.sessionId, roleId: item.roleId, rootId: item.rootId }))
  };
}
