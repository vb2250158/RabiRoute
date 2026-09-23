import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ps = value => `'${String(value).replaceAll("'", "''")}'`;
const scripts = ['Install-RabiRouteReleaseTransaction.ps1', 'Stop-RabiRouteHostFenced.ps1'];
const functionText = file => readFileSync(path.resolve('scripts', file), 'utf8').match(/function Repair-ChildProcessEnvironment \{[\s\S]*?\n\}/)[0];
test('standalone installer and stop carry identical environment policy without a new deployment dependency', () => {
  assert.equal(functionText(scripts[0]), functionText(scripts[1]));
  const embedding = readFileSync('installer/RabiRoute.iss', 'utf8');
  for (const file of scripts) assert.ok(embedding.includes(file));
});

// CreateProcessW receives an actual UTF-16 environment block. No JS env object,
// PowerShell Env: provider, or mocked Start-Process can reproduce this boundary.
const launcher = `using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RawEnvironmentChild {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Run(string exe,string command,string block) {
  IntPtr env=Marshal.StringToHGlobalUni(block); PI pi; SI si=new SI(); si.cb=Marshal.SizeOf(si);
  try {
   if(!CreateProcessW(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x400,env,null,ref si,out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   try { if(WaitForSingleObject(pi.process,30000)!=0) throw new Exception("Fixture child timeout"); uint code; if(!GetExitCodeProcess(pi.process,out code)) throw new Exception("Missing fixture exit code"); return (int)code; }
   finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  } finally { Marshal.FreeHGlobal(env); }
 }
}`;

test('native duplicate-case inheritance reproduces WinPS failure and preserves or rejects values before launch', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rabi env case '));
  try {
    const probe = path.join(root, 'probe.cjs');
    const marker = path.join(root, 'child-launched');
    writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched'); process.stdout.write(JSON.stringify({ok:true,proxy:process.env.NO_PROXY ?? process.env.no_proxy,keep:process.env.RABI_KEEP,empty:process.env.RABI_EMPTY,unicode:process.env.RABI_UNICODE}));`);
    const cases = ['same', 'conflict', 'plain', 'empty'];
    for (const script of scripts) for (const mode of cases) {
      rmSync(marker, { force: true });
      const resultFile = path.join(root, `${script}-${mode}.json`);
      const child = path.join(root, 'child.ps1');
      writeFileSync(child, `\ufeff$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${ps(path.resolve('scripts', script))},[ref]$null,[ref]$null)
foreach($name in @('Repair-ChildProcessEnvironment','ConvertTo-WindowsArgument','Invoke-Checked','Invoke-HostJson')) {
 $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($fn){ . ([scriptblock]::Create($fn.Extent.Text)) }
}
$before=@([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'NO_PROXY' }).Count
$baseline=''
try { Start-Process -FilePath ${ps(process.execPath)} -ArgumentList '--version' -Wait -PassThru -RedirectStandardOutput ${ps(path.join(root, 'baseline.txt'))} | Out-Null } catch { $baseline=$_.Exception.ToString() }
$transactionRoot=${ps(root)}
$errorText=''; $output=$null
try {
 if (${ps(script)} -like 'Install-*') {
  Invoke-Checked ${ps(process.execPath)} @(${ps(probe)}) 'environment fixture'
  $out=Get-ChildItem -LiteralPath $transactionRoot -Filter '*.stdout.txt' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $output=[IO.File]::ReadAllText($out.FullName) | ConvertFrom-Json
 } else { $output=Invoke-HostJson ${ps(process.execPath)} @(${ps('"' + probe + '"')}) $transactionRoot }
} catch { $errorText=$_.Exception.Message }
$after=@([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'NO_PROXY' }).Count
@{before=$before;after=$after;baseline=$baseline;error=$errorText;output=$output} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ${ps(resultFile)} -Encoding UTF8
`, 'utf8');
      const command = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ${ps(launcher)}
$entries=[Collections.Generic.List[string]]::new()
foreach($e in [Environment]::GetEnvironmentVariables().GetEnumerator()) { if ($e.Key -notmatch '^(NO_PROXY|RABI_KEEP|RABI_EMPTY|RABI_UNICODE)$') { $entries.Add(([string]$e.Key)+'='+([string]$e.Value)) } }
$entries.Add('RABI_KEEP=untouched');$entries.Add('RABI_EMPTY=');$entries.Add('RABI_UNICODE=中文=值')
$entries.Add(${ps('NO_PROXY=' + (mode === 'empty' ? '' : 'localhost,.example.test'))})
${mode === 'plain' ? '' : `$entries.Add(${ps('no_proxy=' + (mode === 'conflict' ? 'PRIVATE_CONFLICT' : mode === 'empty' ? '' : 'localhost,.example.test'))})`}
$entries.Sort([StringComparer]::OrdinalIgnoreCase)
$block=($entries -join "\x00")+"\x00\x00"
$exe=Join-Path $PSHOME 'powershell.exe'
$code=[RawEnvironmentChild]::Run($exe,('"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+${ps(child)}+'"'),$block)
if($code -ne 0){throw "Fixture exit $code"}
`;
      const parent = path.join(root, 'parent.ps1');
      writeFileSync(parent, '\ufeff' + command, 'utf8');
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', parent], { encoding: 'utf8', timeout: 45000 });
      assert.equal(run.error, undefined);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const result = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\ufeff/, ''));
      assert.equal(result.before, mode === 'plain' ? 1 : 2, `${script}/${mode}: raw duplicates required`);
      if (mode !== 'plain') assert.match(result.baseline, /ArgumentException[\s\S]*get_EnvironmentVariables/);
      if (mode === 'conflict') {
        assert.match(result.error, /failed before exit/);
        assert.equal(result.after, 2, 'conflicts must not mutate the environment');
        assert.equal(result.output, null);
        assert.equal(existsSync(marker), false, 'conflict must fail before executing the target');
        const errors = readdirSync(root).filter(name => name.endsWith('.launch-error.txt')).map(name => readFileSync(path.join(root, name), 'utf8')).join('\n');
        assert.match(errors, /Conflicting case-insensitive environment variable: NO_PROXY/i);
        assert.doesNotMatch(errors, /PRIVATE_CONFLICT|localhost,\.example\.test/);
      } else {
        assert.equal(result.error, '', `${script}/${mode}`);
        assert.equal(result.after, 1);
        assert.equal(result.output.ok, true);
        assert.equal(result.output.proxy, mode === 'empty' ? '' : 'localhost,.example.test');
        assert.equal(result.output.keep, 'untouched');
        assert.equal(result.output.empty, '');
        assert.equal(result.output.unicode, '中文=值');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
