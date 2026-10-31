$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.Flush()
Add-Type -AssemblyName System.Web.Extensions
$nativeSource = @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class RabiTerminalHost {
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X,Y; public Coord(int x,int y){X=(short)x;Y=(short)y;} }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show,reservedSize; public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint processes; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Counters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,uint size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console,Coord size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref ExtendedStartup startup,out ProcessInfo info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] buffer,uint count,out uint read,IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetStdHandle(int kind,IntPtr value);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool ignore);
    static readonly object outputLock = new object();
    static void Emit(object value) { lock(outputLock){ Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); } }
    static void Check(bool ok){ if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void Run() {
        IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,pc=IntPtr.Zero,job=IntPtr.Zero,attributes=IntPtr.Zero;
        ProcessInfo process=new ProcessInfo(); StreamWriter writer=null;
        try {
            var json=new JavaScriptSerializer();
            var open=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
            string shell=Convert.ToString(open["shell"]),cwd=Convert.ToString(open["cwd"]);
            if((shell!="cmd"&&shell!="powershell")||!Path.IsPathRooted(cwd)||!Directory.Exists(cwd))throw new ArgumentException();
            Check(CreatePipe(out inputRead,out inputWrite,IntPtr.Zero,0)); Check(CreatePipe(out outputRead,out outputWrite,IntPtr.Zero,0));
            Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord(100,28),inputRead,outputWrite,0,out pc));
            job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
            var limits=new ExtendedLimit();limits.basic.flags=0x2000;
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))));
            IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
            Check(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20016,pc,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
            var startup=new ExtendedStartup();startup.info.cb=Marshal.SizeOf(typeof(ExtendedStartup));startup.attributes=attributes;
            string executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),shell=="cmd"?"cmd.exe":"WindowsPowerShell\\v1.0\\powershell.exe");
            // ConsoleHost's built-in editing works for both browser terminals
            // and headless Agents; PSReadLine requires a terminal cursor reply.
            string args=shell=="cmd"?" /D /Q":" -NoLogo -NoProfile -NoExit -Command \"Remove-Module PSReadLine -ErrorAction SilentlyContinue\"";
            if(shell=="cmd")Environment.SetEnvironmentVariable("PROMPT","$P$G");
            // Console handles are inherited separately from inheritable kernel
            // handles. Suppress this dedicated host's redirected stdio during
            // creation so the shell receives ConPTY handles, then restore it.
            var originalIn=GetStdHandle(-10);var originalOut=GetStdHandle(-11);var originalErr=GetStdHandle(-12);
            try {
                // A noninteractive parent can ignore Ctrl+C; do not pass that
                // inherited disposition to an interactive terminal shell.
                SetConsoleCtrlHandler(IntPtr.Zero,false);
                Check(SetStdHandle(-10,IntPtr.Zero));Check(SetStdHandle(-11,IntPtr.Zero));Check(SetStdHandle(-12,IntPtr.Zero));
                Check(CreateProcessW(executable,new StringBuilder("\""+executable+"\""+args),IntPtr.Zero,IntPtr.Zero,false,0x80004,IntPtr.Zero,cwd,ref startup,out process));
            } finally {SetStdHandle(-10,originalIn);SetStdHandle(-11,originalOut);SetStdHandle(-12,originalErr);}
            CloseHandle(inputRead);inputRead=IntPtr.Zero;CloseHandle(outputWrite);outputWrite=IntPtr.Zero;
            // The shell is suspended until assigned. No command or descendant can
            // run outside the parent's kill-on-close Job Object.
            if(!AssignProcessToJobObject(job,process.process)){TerminateProcess(process.process,1);throw new Win32Exception(Marshal.GetLastWin32Error());}
            writer=new StreamWriter(new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write),new UTF8Encoding(false));inputWrite=IntPtr.Zero;writer.AutoFlush=true;
            var outputHandle=outputRead;
            var shellPid=process.pid;
            // A resumed process can still flush queued input during startup.
            // Both profile-free shells use a '>' prompt: admit input only after
            // that prompt arrives, rather than merely after CreateProcess.
            var outputThread=new Thread(()=>{try{byte[] bytes=new byte[4096];char[] chars=new char[4096];uint count;bool ready=false;var decoder=new UTF8Encoding(false).GetDecoder();while(ReadFile(outputHandle,bytes,4096,out count,IntPtr.Zero)&&count>0){int length=decoder.GetChars(bytes,0,(int)count,chars,0,false);if(length>0){string data=new string(chars,0,length);Emit(new{type="output",data});if(!ready&&data.IndexOf('>')>=0){ready=true;Emit(new{type="ready",pid=shellPid});}}}}catch{}});
            outputThread.IsBackground=true;outputThread.Start();
            var processHandle=process.process;
            var waitThread=new Thread(()=>{WaitForSingleObject(processHandle,0xffffffff);uint code;GetExitCodeProcess(processHandle,out code);try{Emit(new{type="exit",code});}catch{}});
            waitThread.IsBackground=true;waitThread.Start();
            Check(ResumeThread(process.thread)!=0xffffffff);
            string line;
            while((line=Console.ReadLine())!=null){
                if(line.Length>65536)break;
                var message=json.Deserialize<Dictionary<string,object>>(line);
                var action=Convert.ToString(message["action"]);
                if(action=="input")writer.Write(Convert.ToString(message["data"]));
                else if(action=="resize")Marshal.ThrowExceptionForHR(ResizePseudoConsole(pc,new Coord(Convert.ToInt32(message["cols"]),Convert.ToInt32(message["rows"]))));
            }
        } finally {
            if(job!=IntPtr.Zero){TerminateJobObject(job,1);CloseHandle(job);}
            uint stopMs; if(!UInt32.TryParse(Environment.GetEnvironmentVariable("RABI_TERMINAL_NATIVE_STOP_MS"),out stopMs)||stopMs<1||stopMs>2147483647)stopMs=5000;
            if(process.process!=IntPtr.Zero)WaitForSingleObject(process.process,stopMs);
            if(pc!=IntPtr.Zero)ClosePseudoConsole(pc);
            if(writer!=null)writer.Dispose();
            foreach(var handle in new[]{inputRead,inputWrite,outputRead,outputWrite,process.process,process.thread})if(handle!=IntPtr.Zero)CloseHandle(handle);
            if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}
        }
    }
}
'@
$nativeHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeSource.Replace("`r`n", "`n")))).Replace('-', '').ToLowerInvariant()
$nativeAssembly = Join-Path $PSScriptRoot "../dist/native/terminal-$nativeHash.dll"
if (Test-Path -LiteralPath $nativeAssembly) {
    Add-Type -Path $nativeAssembly
} else {
    Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $nativeSource
}
[RabiTerminalHost]::Run()
