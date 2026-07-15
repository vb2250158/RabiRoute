(function rabiLinkAiuiCraftEmbeddedAixUploadHelper() {
  "use strict";

  const EMBEDDED_AIX = {
    name: "__RABILINK_AIX_NAME__",
    size: __RABILINK_AIX_SIZE__,
    sha256: "__RABILINK_AIX_SHA256__",
    base64: "__RABILINK_AIX_BASE64__",
  };
  const DEFAULT_TOOLS = JSON.parse(__RABILINK_TOOLS_JSON_STRING__);
  const DEFAULTS = {
    agentName: "RabiLink",
    version: "1.0.16",
    description: "AI glasses continuous Agent stream and native AIUI LanguageModel configuration surface through RabiLink Relay.",
    iconUrl: "https://basecloud.rokidcdn.com/basecloud/prod/coze/default_agent_icon.png",
    permissions: "RECORD_AUDIO,SPEECH_RECOGNITION,INTERNET",
    category: "tool",
    tools: DEFAULT_TOOLS,
  };
  const PANEL_ID = "rabilink-aiui-craft-embedded-upload-helper";
  const TOKEN_KEY = "ROKID_ACCOUNT_SESSION";
  const REPORT_FILE_NAME = "rabilink-aiui-craft-upload-report.json";
  const FALLBACK_AGENT_ID = "__RABILINK_FALLBACK_AGENT_ID__";
  const AGENT_ID_PATTERN = /\b[a-f0-9]{32}\b/gi;
  const report = {
    source: "rabilink-aiui-craft-browser-upload-helper",
    mode: "embedded-aix",
    generated_at: new Date().toISOString(),
    page_url: window.location.href,
    origin: window.location.origin,
    session_present: false,
    session_source: "",
    account_id_parsed: false,
    expected: {
      agent_id: "",
      agent_name: DEFAULTS.agentName,
      version: DEFAULTS.version,
    },
    embedded_aix: {
      name: EMBEDDED_AIX.name,
      size: EMBEDDED_AIX.size,
      sha256: EMBEDDED_AIX.sha256,
    },
    region: "cn",
    upload: null,
    list_agents: null,
    matched: false,
    error: "",
  };

  function parseQuery() {
    const params = new URLSearchParams(window.location.search || "");
    return {
      agentId: params.get("defaultAgentId") || params.get("agentId") || params.get("botId") || params.get("id") || FALLBACK_AGENT_ID || "",
      region: params.get("region") || "cn",
    };
  }

  function addAgentIdCandidate(map, id, source, context, score) {
    const normalized = String(id || "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(normalized)) return;
    const previous = map.get(normalized) || {
      id: normalized,
      sources: [],
      contexts: [],
      score: 0,
    };
    previous.score += score || 1;
    if (source && !previous.sources.includes(source)) previous.sources.push(source);
    if (context && previous.contexts.length < 4) previous.contexts.push(context.slice(0, 220));
    map.set(normalized, previous);
  }

  function scanAgentIdText(map, source, text, baseScore) {
    const value = String(text || "");
    if (!value) return;
    AGENT_ID_PATTERN.lastIndex = 0;
    let match = AGENT_ID_PATTERN.exec(value);
    while (match) {
      const start = Math.max(0, match.index - 100);
      const end = Math.min(value.length, match.index + match[0].length + 100);
      const context = value.slice(start, end).replace(/\s+/g, " ").trim();
      const lowered = context.toLowerCase();
      let score = baseScore || 1;
      if (lowered.includes("rabilink") || lowered.includes("rabi")) score += 6;
      if (lowered.includes("defaultagentid") || lowered.includes("agentid")) score += 5;
      if (lowered.includes("agent") || lowered.includes("智能体")) score += 2;
      addAgentIdCandidate(map, match[0], source, context, score);
      match = AGENT_ID_PATTERN.exec(value);
    }
  }

  function scanStorageForAgentIds(map, storageName, storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        scanAgentIdText(map, `${storageName}:${key}`, `${key}\n${value}`, 2);
      }
    } catch {}
  }

  function inferAgentIdCandidates() {
    const candidates = new Map();
    const params = new URLSearchParams(window.location.search || "");
    for (const key of ["defaultAgentId", "agentId", "botId", "id"]) {
      addAgentIdCandidate(candidates, params.get(key), `query:${key}`, window.location.href, 40);
    }
    addAgentIdCandidate(candidates, FALLBACK_AGENT_ID, "launcher-fallback", "ROKID_CRAFT_AGENT_ID or ROKID_CRAFT_URL", 35);
    scanAgentIdText(candidates, "location.href", window.location.href, 18);
    scanStorageForAgentIds(candidates, "localStorage", window.localStorage);
    scanStorageForAgentIds(candidates, "sessionStorage", window.sessionStorage);
    try {
      const html = document.documentElement ? document.documentElement.outerHTML : "";
      scanAgentIdText(candidates, "document", html.slice(0, 2000000), 1);
    } catch {}
    try {
      for (const element of Array.from(document.querySelectorAll("a[href],[data-id],[data-agent-id],[data-bot-id]")).slice(0, 2000)) {
        const bits = [];
        for (const attr of element.attributes || []) {
          if (/^(href|data-|aria-label|title)$/i.test(attr.name) || /agent|bot|id/i.test(attr.name)) {
            bits.push(`${attr.name}=${attr.value}`);
          }
        }
        if (bits.length) scanAgentIdText(candidates, "dom-attributes", bits.join("\n"), 3);
      }
    } catch {}
    return Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  function getCookie(name) {
    const pairs = String(document.cookie || "").split(";");
    for (const pair of pairs) {
      const [rawKey, ...rawValue] = pair.trim().split("=");
      if (rawKey === name) return decodeURIComponent(rawValue.join("=") || "");
    }
    return "";
  }

  function getCraftSession() {
    try {
      const localValue = window.localStorage.getItem(TOKEN_KEY) || "";
      if (localValue.trim()) return { token: localValue.trim(), source: "localStorage" };
    } catch {}
    const cookieValue = getCookie(TOKEN_KEY);
    if (cookieValue.trim()) return { token: cookieValue.trim(), source: "cookie" };
    return { token: "", source: "" };
  }

  function parseJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    try {
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const json = decodeURIComponent(
        Array.from(atob(padded))
          .map((char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function accountIdFromToken(token) {
    const payload = parseJwtPayload(token);
    if (!payload || typeof payload !== "object") return "";
    for (const key of ["accountId", "account_id", "uid", "userId", "user_id", "sub"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  }

  function base64ToFile() {
    const binary = atob(EMBEDDED_AIX.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], EMBEDDED_AIX.name || "rabilink-aiui.aix", { type: "application/octet-stream" });
  }

  function collectAgents(node, output) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) collectAgents(item, output);
      return;
    }
    if (typeof node !== "object") return;
    const id = node.agentId || node.botId || node.id || node.agent_id || node.bot_id || "";
    const name = node.agentName || node.name || node.title || node.agent_name || node.botName || "";
    const version = node.version || node.agentVersion || node.agent_version || "";
    if (id || name) output.push({ id: String(id || ""), name: String(name || ""), version: String(version || "") });
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") collectAgents(value, output);
    }
  }

  function parseSse(text) {
    const events = [];
    const errors = [];
    let complete = false;
    for (const chunk of String(text || "").split(/\r?\n\r?\n/)) {
      if (!chunk.trim()) continue;
      let eventName = "message";
      let dataText = "";
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
        if (line.startsWith("data:")) dataText += line.slice(5).trimStart();
      }
      if (!dataText) continue;
      try {
        const data = JSON.parse(dataText);
        events.push(`${eventName}: ${data.message || data.stage || JSON.stringify(data)}`);
        const stage = String(data.stage || data.status || "").toLowerCase();
        if (eventName.toLowerCase() === "done" || stage === "done" || data.done === true) complete = true;
        if (eventName.toLowerCase() === "error" || stage === "error" || data.error) {
          errors.push(String(data.message || data.error || dataText));
        }
      } catch {
        events.push(`${eventName}: ${dataText}`);
        if (eventName.toLowerCase() === "done") complete = true;
        if (eventName.toLowerCase() === "error") errors.push(dataText);
      }
    }
    return {
      complete,
      hasError: errors.length > 0,
      errors,
      summary: events.join("\n") || text,
    };
  }

  function createField(label, value, attrs) {
    const wrap = document.createElement("label");
    wrap.style.display = "grid";
    wrap.style.gap = "4px";
    wrap.style.fontSize = "12px";
    const caption = document.createElement("span");
    caption.textContent = label;
    caption.style.color = "#9eff9e";
    const input = document.createElement(attrs && attrs.multiline ? "textarea" : "input");
    input.value = value || "";
    input.style.cssText = [
      "box-sizing:border-box",
      "width:100%",
      "min-height:30px",
      "border:1px solid #00aa00",
      "background:#050805",
      "color:#eaffea",
      "border-radius:4px",
      "padding:6px",
      "font:12px/1.4 ui-monospace,Consolas,monospace",
    ].join(";");
    if (attrs && attrs.multiline) input.rows = attrs.rows || 3;
    wrap.append(caption, input);
    return { wrap, input };
  }

  function appendButton(row, text, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.style.cssText = [
      "border:1px solid #00ff00",
      "background:#061006",
      "color:#00ff00",
      "border-radius:4px",
      "padding:7px 9px",
      "font:600 12px system-ui,sans-serif",
      "cursor:pointer",
    ].join(";");
    button.addEventListener("click", handler);
    row.appendChild(button);
    return button;
  }

  function refreshReportBase() {
    const active = getCraftSession();
    report.generated_at = new Date().toISOString();
    report.page_url = window.location.href;
    report.origin = window.location.origin;
    report.session_present = !!active.token;
    report.session_source = active.source || "";
    report.account_id_parsed = !!accountIdFromToken(active.token);
    report.expected = {
      agent_id: agentIdField.input.value.trim(),
      agent_name: nameField.input.value.trim(),
      version: versionField.input.value.trim(),
    };
    report.agent_id_candidates = inferAgentIdCandidates().slice(0, 10);
    report.region = (regionField.input.value.trim() || "cn") === "global" ? "global" : "cn";
    report.matched = !!(report.list_agents && report.list_agents.matched);
  }

  function writeOutput(text) {
    refreshReportBase();
    output.textContent = text;
  }

  function downloadReport() {
    refreshReportBase();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = REPORT_FILE_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  const context = parseQuery();
  const session = getCraftSession();
  const tokenAccountId = accountIdFromToken(session.token);

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "width:min(540px,calc(100vw - 32px))",
    "max-height:calc(100vh - 32px)",
    "overflow:auto",
    "box-sizing:border-box",
    "border:1px solid #00ff00",
    "background:#000",
    "color:#eaffea",
    "border-radius:6px",
    "box-shadow:0 16px 48px rgba(0,0,0,.5)",
    "padding:12px",
    "font:12px/1.45 system-ui,sans-serif",
  ].join(";");

  const title = document.createElement("div");
  title.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px";
  const h = document.createElement("strong");
  h.textContent = "RabiLink AIUI Embedded AIX Upload";
  h.style.color = "#00ff00";
  const close = document.createElement("button");
  close.textContent = "x";
  close.type = "button";
  close.style.cssText = "border:0;background:transparent;color:#00ff00;font:700 16px system-ui;cursor:pointer";
  close.addEventListener("click", () => panel.remove());
  title.append(h, close);

  const summary = document.createElement("div");
  summary.style.cssText = "margin-bottom:8px;color:#bfffbf";
  summary.textContent = `origin=${location.origin}; session=${session.token ? "present via " + session.source : "missing"}; accountId=${tokenAccountId ? "parsed" : "not parsed"}; embedded=${EMBEDDED_AIX.name} ${EMBEDDED_AIX.size} bytes`;

  const agentIdField = createField("agentId", context.agentId);
  const regionField = createField("region", context.region);
  const nameField = createField("agentName", DEFAULTS.agentName);
  const versionField = createField("version", DEFAULTS.version);
  const descField = createField("description", DEFAULTS.description, { multiline: true, rows: 2 });
  const iconField = createField("iconUrl", DEFAULTS.iconUrl);
  const permissionsField = createField("permissions", DEFAULTS.permissions);
  const categoryField = createField("category", DEFAULTS.category);
  const toolsField = createField("tools JSON", JSON.stringify(DEFAULTS.tools), { multiline: true, rows: 2 });

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px";
  grid.append(
    agentIdField.wrap,
    regionField.wrap,
    nameField.wrap,
    versionField.wrap,
    descField.wrap,
    iconField.wrap,
    permissionsField.wrap,
    categoryField.wrap,
    toolsField.wrap
  );
  toolsField.wrap.style.gridColumn = "1 / -1";
  descField.wrap.style.gridColumn = "1 / -1";

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:10px 0";
  const output = document.createElement("pre");
  output.style.cssText = [
    "white-space:pre-wrap",
    "max-height:180px",
    "overflow:auto",
    "background:#020402",
    "border:1px solid #005e00",
    "border-radius:4px",
    "padding:8px",
    "color:#dfffe0",
    "font:12px/1.4 ui-monospace,Consolas,monospace",
  ].join(";");
  output.textContent = "This helper embeds the AIX package, so it does not need Chrome file access. It never prints the account token.";

  const initialAgentIdCandidates = inferAgentIdCandidates();
  if (!agentIdField.input.value.trim() && initialAgentIdCandidates.length > 0) {
    const [best, second] = initialAgentIdCandidates;
    if (!second || best.score >= second.score + 4 || best.score >= 35) {
      agentIdField.input.value = best.id;
    }
  }

  function headers(extra) {
    const token = getCraftSession().token;
    const region = regionField.input.value.trim() || "cn";
    const accountId = accountIdFromToken(token);
    return {
      ...(extra || {}),
      ...(token ? { "X-Account-Token": token } : {}),
      ...(accountId ? { "X-Account-ID": accountId } : {}),
      "X-Craft-Region": region === "global" ? "global" : "cn",
    };
  }

  appendButton(buttons, "Check session", () => {
    const active = getCraftSession();
    report.error = active.token ? "" : "No ROKID_ACCOUNT_SESSION found in localStorage or non-HttpOnly cookie.";
    writeOutput(active.token
      ? `Session present via ${active.source}. Account ID ${accountIdFromToken(active.token) ? "parsed" : "not parsed"}.\nEmbedded AIX: ${EMBEDDED_AIX.name} ${EMBEDDED_AIX.size} bytes ${EMBEDDED_AIX.sha256}`
      : "No ROKID_ACCOUNT_SESSION found in localStorage or non-HttpOnly cookie. Log in to Craft first.");
  });

  appendButton(buttons, "Find agentId", () => {
    const candidates = inferAgentIdCandidates();
    if (!agentIdField.input.value.trim() && candidates.length > 0) {
      agentIdField.input.value = candidates[0].id;
    }
    writeOutput(candidates.length > 0
      ? [
          `agentId candidates: ${candidates.length}`,
          ...candidates.slice(0, 8).map((candidate) => [
            `- ${candidate.id} score=${candidate.score} source=${candidate.sources.join(",")}`,
            candidate.contexts[0] ? `  ${candidate.contexts[0]}` : "",
          ].filter(Boolean).join("\n")),
        ].join("\n")
      : "No 32-character Craft agentId candidate was found on this page. Open the target project URL or paste agentId manually.");
  });

  appendButton(buttons, "Upload embedded AIX", async () => {
    try {
      const token = getCraftSession().token;
      if (!token) {
        report.error = "No Craft session found. Log in to Craft first, then run the helper again.";
        writeOutput(report.error);
        return;
      }
      const agentId = agentIdField.input.value.trim();
      if (!agentId) {
        report.error = "agentId is required. Open the target Craft URL or paste defaultAgentId here.";
        writeOutput(report.error);
        return;
      }
      let tools = [];
      try {
        tools = JSON.parse(toolsField.input.value || "[]");
      } catch (error) {
        report.error = `tools JSON is invalid: ${error.message}`;
        writeOutput(report.error);
        return;
      }
      const file = base64ToFile();
      const metadata = {
        agentId,
        agentName: nameField.input.value.trim(),
        version: versionField.input.value.trim(),
        description: descField.input.value.trim(),
        iconUrl: iconField.input.value.trim(),
        permissions: permissionsField.input.value.trim(),
        category: categoryField.input.value.trim(),
        tools,
      };
      const form = new FormData();
      form.append("file", file, file.name || "rabilink-aiui.aix");
      form.append("metadata", JSON.stringify(metadata));
      writeOutput(`Uploading embedded ${file.name} (${file.size} bytes) to ${agentId}...`);
      const response = await fetch("/api/craft/project/upload-agent", {
        method: "POST",
        credentials: "include",
        headers: headers(),
        body: form,
      });
      const text = await response.text();
      const sse = parseSse(text);
      const uploadOk = response.ok && sse.complete && !sse.hasError;
      report.upload = {
        endpoint: "/api/craft/project/upload-agent",
        http_status: response.status,
        transport_ok: response.ok,
        stream_complete: sse.complete,
        stream_error: sse.hasError,
        ok: uploadOk,
        file: {
          name: file.name || "rabilink-aiui.aix",
          size: file.size,
          sha256: EMBEDDED_AIX.sha256,
          embedded: true,
        },
        metadata,
        summary: sse.summary,
        error: uploadOk ? "" : (sse.errors.join("\n") || text.slice(0, 1200) || "Upload stream did not complete."),
      };
      report.error = uploadOk ? "" : report.upload.error;
      writeOutput([`HTTP ${response.status}`, report.upload.summary].join("\n"));
    } catch (error) {
      report.upload = {
        endpoint: "/api/craft/project/upload-agent",
        http_status: 0,
        ok: false,
        error: error && error.message ? error.message : String(error),
      };
      report.error = report.upload.error;
      writeOutput(`Upload failed: ${report.upload.error}`);
    }
  });

  appendButton(buttons, "List agents", async () => {
    try {
      writeOutput("Loading agents...");
      const response = await fetch("/api/craft/project/agents", {
        method: "GET",
        credentials: "include",
        headers: headers({ Accept: "application/json" }),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {}
      const agents = [];
      collectAgents(payload, agents);
      const expectedId = agentIdField.input.value.trim();
      const expectedName = nameField.input.value.trim();
      const matches = agents.filter((agent) => agent.id === expectedId || agent.name === expectedName);
      report.list_agents = {
        endpoint: "/api/craft/project/agents",
        http_status: response.status,
        ok: response.ok,
        visible_agent_count: agents.length,
        matched: matches.length > 0,
        matches: matches.slice(0, 20),
        error: response.ok ? "" : text.slice(0, 1200),
      };
      report.error = response.ok ? "" : "List agents request failed.";
      writeOutput([
        `HTTP ${response.status}`,
        `visible agents: ${agents.length}`,
        `matches: ${matches.length}`,
        ...matches.slice(0, 5).map((agent) => `- ${agent.name || "(unnamed)"} ${agent.id || ""} ${agent.version || ""}`),
        !response.ok ? text.slice(0, 1200) : "",
      ].filter(Boolean).join("\n"));
    } catch (error) {
      report.list_agents = {
        endpoint: "/api/craft/project/agents",
        http_status: 0,
        ok: false,
        visible_agent_count: 0,
        matched: false,
        matches: [],
        error: error && error.message ? error.message : String(error),
      };
      report.error = report.list_agents.error;
      writeOutput(`List agents failed: ${report.list_agents.error}`);
    }
  });

  appendButton(buttons, "Download report", () => {
    downloadReport();
    writeOutput(`Downloaded ${REPORT_FILE_NAME}. Import it with scripts/Import-RabiLinkAiuiBrowserCraftReport.ps1.`);
  });

  panel.append(title, summary, grid, buttons, output);
  document.body.appendChild(panel);
  refreshReportBase();
})();
