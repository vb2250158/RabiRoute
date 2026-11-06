import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {getTimeoutMs} from '@rabiroute/host-api/shared/timeoutSettings';
import type {AgentManagerApiContext,AgentScanOptions,AgentScanResult,AgentScanSession,AgentSessionPage,AgentScanProject,AgentScanPerformanceOperation,CopilotSessionEntry,AstrbotSessionScan,AstrbotLoginTestRequest,MarvisOpenRequest} from '@rabiroute/host-api/agentAdapters/managerTypes';
import {agentScanManifestFields,getRuntimeList,projectOptionsFromPaths,normalizeComparablePath,checkHttpEndpoint,collectAgentCwdOptions} from '@rabiroute/host-api/agentAdapters/managerScanShared';
export function readCopilotSessions(): CopilotSessionEntry[] {
  const copilotSessionStateDir = path.join(os.homedir(), ".copilot", "session-state");
  const sessions: CopilotSessionEntry[] = [];
  try {
    for (const entry of fs.readdirSync(copilotSessionStateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const yamlPath = path.join(copilotSessionStateDir, entry.name, "workspace.yaml");
      if (!fs.existsSync(yamlPath)) continue;
      try {
        const yamlContent = fs.readFileSync(yamlPath, "utf8");
        const idMatch = yamlContent.match(/^id:\s*(.+)$/m);
        const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
        const cwdMatch = yamlContent.match(/^cwd:\s*(.+)$/m);
        const userNamedMatch = yamlContent.match(/^user_named:\s*(.+)$/m);
        const updatedMatch = yamlContent.match(/^updated_at:\s*(.+)$/m);
        if (idMatch && nameMatch) {
          sessions.push({
            id: idMatch[1].trim(),
            name: nameMatch[1].trim(),
            cwd: cwdMatch?.[1].trim(),
            userNamed: userNamedMatch?.[1].trim() === "true",
            updatedAt: updatedMatch?.[1].trim()
          });
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // dir not found
  }
  return sessions;
}
export async function detectCopilotBins(resolveWingetCopilot?: () => string | null): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const whereCmd = process.platform === "win32" ? "where.exe" : "which";
  const copilotBins: string[] = [];
  try {
    const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: getTimeoutMs("backend.agentAdapters.managerApi.detectCopilotBins.execFileAsync.timeout", 2000), windowsHide: true });
    copilotBins.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch {
    // not found
  }
  const wingetBin = resolveWingetCopilot?.();
  if (wingetBin && fs.existsSync(wingetBin)) {
    copilotBins.unshift(wingetBin);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const userProfile = process.env.USERPROFILE ?? "";
    const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(wingetBase)) {
        if (entry.startsWith("GitHub.Copilot")) {
          const exe = path.join(wingetBase, entry, "copilot.exe");
          if (fs.existsSync(exe)) copilotBins.unshift(exe);
        }
      }
    } catch {
      // skip
    }
    for (const root of [
      path.join(localAppData, "Programs", "Microsoft VS Code"),
      path.join(localAppData, "Programs", "Microsoft VS Code Insiders"),
      path.join(userProfile, ".vscode", "extensions")
    ]) {
      try {
        const extDir = path.join(root, "resources", "app", "extensions");
        if (!fs.existsSync(extDir)) continue;
        for (const entry of fs.readdirSync(extDir)) {
          if (!entry.startsWith("github.copilot-chat")) continue;
          for (const binName of ["copilot.exe", "copilot", "cli/copilot.exe"]) {
            const p = path.join(extDir, entry, "dist", binName);
            if (fs.existsSync(p)) copilotBins.push(p);
          }
        }
      } catch {
        // skip
      }
    }
    try {
      const vsDir = path.join(localAppData, "Microsoft", "VisualStudio");
      if (fs.existsSync(vsDir)) {
        for (const vsVer of fs.readdirSync(vsDir, { withFileTypes: true })) {
          if (!vsVer.isDirectory()) continue;
          const extRoot = path.join(vsDir, vsVer.name, "Extensions");
          if (!fs.existsSync(extRoot)) continue;
          for (const extId of fs.readdirSync(extRoot, { withFileTypes: true })) {
            if (!extId.isDirectory()) continue;
            const distDir = path.join(extRoot, extId.name, "service", "dist");
            if (!fs.existsSync(distDir)) continue;
            for (const f of fs.readdirSync(distDir)) {
              if (f.startsWith("copilot-agent") && f.endsWith(".exe")) {
                copilotBins.push(path.join(distDir, f));
              }
            }
          }
        }
      }
    } catch {
      // skip
    }
  }
  return copilotBins;
}
export function readCopilotLoggedIn(copilotHome: string): boolean {
  try {
    const configPath = path.join(copilotHome, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/[^\n]*\n/gm, "");
      const cfg = JSON.parse(raw) as { loggedInUsers?: unknown[] };
      return Array.isArray(cfg.loggedInUsers) && cfg.loggedInUsers.length > 0;
    }
  } catch {
    // ignore
  }
  return false;
}
export async function getCopilotStatus(ctx: AgentManagerApiContext): Promise<Record<string, unknown>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let installed = false;
  let binPath = ctx.resolveWingetCopilot?.() ?? "";
  if (binPath) {
    installed = true;
  } else {
    const whereCmd = process.platform === "win32" ? "where.exe" : "which";
    try {
      const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: getTimeoutMs("backend.agentAdapters.managerApi.getCopilotStatus.execFileAsync.timeout", 2000), windowsHide: true });
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .find((p) => !p.endsWith(".ps1"));
      if (first) {
        installed = true;
        binPath = first;
      }
    } catch {
      // not installed
    }
  }
  const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  return { installed, binPath, loggedIn: readCopilotLoggedIn(copilotHome), copilotHome };
}
export async function scanCopilotAgentAdapter(ctx:AgentManagerApiContext,options:AgentScanOptions={}) {
 const runtimes=getRuntimeList(ctx),copilotSessions=ctx.copilotSessions??readCopilotSessions(),copilotBins=ctx.copilotBins??await detectCopilotBins(ctx.resolveWingetCopilot);
 const cwdOptions=ctx.cwdOptions??collectAgentCwdOptions(ctx.rootDir,runtimes,['copilotCwd'],copilotSessions),projects=ctx.projects??projectOptionsFromPaths(cwdOptions);
 const copilotScanSessions:AgentScanSession[]=copilotSessions.map(session=>({id:session.id,name:session.name,projectPath:session.cwd,updatedAt:session.updatedAt,userNamed:session.userNamed}));
 const copilotHome=process.env.COPILOT_HOME??path.join(os.homedir(),'.copilot'),copilotLoggedIn=readCopilotLoggedIn(copilotHome);
 return {agents:{copilotCli:{
      ...agentScanManifestFields("copilotCli",ctx.manifest),
      installed: copilotBins.length > 0,
      installCandidates: copilotBins.map((binPath) => ({ label: path.basename(binPath), path: binPath })),
      auth: {
        required: true,
        loggedIn: copilotLoggedIn,
        loginUrl: "https://github.com/login/device",
        message: copilotLoggedIn ? "已发现 Copilot 登录状态。" : `未在 ${copilotHome} 发现登录状态。`
      },
      projects,
      sessions: copilotScanSessions,
      warnings: [
        "尚未完成真实端到端烟测：需确认 --name 会复用同一会话，且连续两次注入不会新开线程。",
        ...(copilotScanSessions.length === 0 ? ["未发现 Copilot session-state；会话下拉需要先运行过 Copilot CLI。"] : [])
      ]
    }},cwdOptions,threadNames:copilotSessions.map(s=>s.name),copilotBins,copilotSessions:copilotSessions.map(s=>({name:s.name,cwd:s.cwd,userNamed:s.userNamed}))};
}
