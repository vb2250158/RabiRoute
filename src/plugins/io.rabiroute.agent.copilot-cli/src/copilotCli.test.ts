import assert from "node:assert/strict";
import test from "node:test";
import { resolveCopilotSessionName } from "./copilotCli.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

test("Copilot session names have a dedicated configuration source", () => {
  assert.equal(resolveCopilotSessionName(" Copilot Route ", "Configured Copilot"), "Copilot Route");
  assert.equal(resolveCopilotSessionName(undefined, " Configured Copilot "), "Configured Copilot");
  assert.equal(resolveCopilotSessionName(undefined, undefined), "");
});

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT_PROMPT = "Read the UTF-8 task at the file path in environment variable RABIROUTE_COPILOT_PROMPT_FILE, then follow all instructions in that file.";

async function controlledDelivery(t: test.TestContext, input: string, options: { extension?: "cmd" | "bat"; native?: boolean; stdin?: boolean; exit?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-copilot-private-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-copilot-private-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "project & space");
  await fs.mkdir(cwd);
  const inputFile = path.join(root, "controlled-input.json");
  const resultFile = path.join(root, "controlled-result.json");
  const receiver = path.join(root, "controlled-receiver.cjs");
  const wrapper = path.join(root, `controlled wrapper.${options.extension ?? "cmd"}`);
  await fs.writeFile(inputFile, JSON.stringify(input), "utf8");
  await fs.writeFile(receiver, `const fs=require('node:fs');let stdin='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>stdin+=s);process.stdin.on('end',()=>{const promptFile=process.env.RABIROUTE_COPILOT_PROMPT_FILE;process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin,promptFile,text:promptFile?fs.readFileSync(promptFile,'utf8'):undefined}));process.exitCode=Number(process.env.CONTROLLED_COPILOT_EXIT||0);});`, "utf8");
  await fs.writeFile(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0controlled-receiver.cjs" %*\r\n`, "utf8");
  const moduleUrl = new URL("./copilotCli.ts", import.meta.url).href;
  const configUrl = pathToFileURL(path.join(sourceRoot, "config.ts")).href;
  const worker = `import fs from 'node:fs/promises';
    if(process.env.CONTROLLED_NATIVE==='1'){const {config}=await import(${JSON.stringify(configUrl)});config.codexCwd='';config.copilotThreadName='';}
    const {notifyCopilotCli}=await import(${JSON.stringify(moduleUrl)});
    let error;try{await notifyCopilotCli(JSON.parse(await fs.readFile(process.env.CONTROLLED_INPUT,'utf8')));}catch(cause){error=String(cause);}
    await fs.writeFile(process.env.CONTROLLED_RESULT,JSON.stringify({error}));`;
  const args = options.native ? [receiver, "--prompt", "{prompt}"] : options.stdin ? ["--silent"] : ["--silent", "--prompt", "{prompt}"];
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(sourceRoot, "../node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "--eval", worker], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      RABIROUTE_STATE_ROOT: root, RABIROUTE_PACKAGE_ROOT: path.resolve(sourceRoot, ".."), DATA_DIR: path.join(root, "data"),
      ROLES_DIR: path.join(root, "roles"), GATEWAY_ID: "", GATEWAY_MANAGER_URL: "http://127.0.0.1:1",
      COPILOT_CLI_BIN: options.native ? process.execPath : wrapper, COPILOT_CLI_ARGS: JSON.stringify(args),
      COPILOT_CWD: options.native ? "" : cwd, COPILOT_THREAD_NAME: options.native ? "" : 'Session & quote " value %PATH% !literal! ^',
      COPILOT_CLI_TIMEOUT_MS: "5000", RABIROUTE_COPILOT_PROMPT_FILE: undefined,
      CONTROLLED_INPUT: inputFile, CONTROLLED_RESULT: resultFile, CONTROLLED_NATIVE: options.native ? "1" : "0",
      CONTROLLED_COPILOT_EXIT: String(options.exit ?? 0), TSX_TSCONFIG_PATH: path.join(sourceRoot, "../tsconfig.json") }
  });
  let stderr = "";
  child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`Controlled Copilot child timed out: ${stderr}`)); }, 20_000);
    child.once("error", error => { clearTimeout(deadline); reject(error); });
    child.once("close", code => { clearTimeout(deadline); resolve(code); });
  });
  assert.equal(code, 0, stderr);
  const outcome = JSON.parse(await fs.readFile(resultFile, "utf8")) as { error?: string };
  const promptDirectory = path.join(root, "data/copilot-prompts");
  const prompts = await fs.readdir(promptDirectory);
  assert.equal(prompts.length, 1);
  const promptPath = path.join(promptDirectory, prompts[0]!);
  assert.equal(await fs.readFile(promptPath, "utf8"), input);
  assert.equal(await fs.stat(path.join(cwd, "unexpected-shell-marker.txt")).then(() => true, () => false), false);
  const rows = await fs.readFile(path.join(root, "data/copilot-output.jsonl"), "utf8").then(text => text.trim().split(/\r?\n/).map(line => JSON.parse(line)), () => []);
  if (options.exit) {
    assert.match(outcome.error ?? "", new RegExp(`exited with code ${options.exit}`));
    assert.equal(rows.length, 0, "A rejected child must not produce a successful output receipt.");
    return;
  }
  assert.equal(outcome.error, undefined);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].promptPath, promptPath);
  assert.equal(rows[0].id, path.basename(promptPath, ".txt"));
  assert.equal(rows[0].code, 0);
  const capture = JSON.parse(rows[0].stdout) as { argv: string[]; stdin: string; promptFile?: string; text?: string };
  if (options.native) {
    assert.deepEqual(capture.argv, ["--prompt", input]);
    assert.equal(capture.promptFile, undefined);
  } else {
    assert.equal(capture.promptFile, promptPath);
    assert.equal(capture.text, input);
    assert.deepEqual(capture.argv.slice(0, 3), ["-C", cwd, '--name=Session & quote " value %PATH% !literal! ^']);
    if (options.stdin) {
      assert.equal(capture.stdin, SCRIPT_PROMPT);
      assert.deepEqual(capture.argv.slice(3), ["--silent"]);
    } else {
      assert.deepEqual(capture.argv.slice(3), ["--silent", "--prompt", SCRIPT_PROMPT]);
      assert.equal(capture.stdin, "");
    }
  }
}

const dangerousLookingText = '原始消息 " & echo controlled-marker>unexpected-shell-marker.txt | more %PATH% !literal! ^ $& $$\n第二行';
for (const extension of ["cmd", "bat"] as const) {
  test(`real .${extension} receives one fixed pickup argument and reads the original private UTF-8 task`, { skip: process.platform !== "win32" }, async t => {
    await controlledDelivery(t, dangerousLookingText, { extension });
  });
}
test("real command script preserves the full long message and its original prompt/output identity", { skip: process.platform !== "win32" }, async t => {
  await controlledDelivery(t, dangerousLookingText.repeat(40));
});
test("explicit custom stdin mode sends only the fixed pickup instruction to a command script", { skip: process.platform !== "win32" }, async t => {
  await controlledDelivery(t, dangerousLookingText, { stdin: true });
});
test("native executable still receives the short original message as an independent argument", async t => {
  await controlledDelivery(t, dangerousLookingText, { native: true });
});
test("command-script failure preserves the original prompt and does not claim a successful receipt", { skip: process.platform !== "win32" }, async t => {
  await controlledDelivery(t, dangerousLookingText, { exit: 7 });
});
