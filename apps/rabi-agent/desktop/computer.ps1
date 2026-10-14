$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.Flush()
Add-Type -AssemblyName System.Web.Extensions,System.Drawing,System.Windows.Forms
$nativeSource = @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public static class RabiComputer {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
    delegate bool WindowCallback(IntPtr window,IntPtr context);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr context);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window,System.Text.StringBuilder title,int length);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    static uint Pid(IntPtr window){ uint pid; GetWindowThreadProcessId(window,out pid);return pid; }
    static object Bounds(Rect rect){return new{x=rect.left,y=rect.top,width=rect.right-rect.left,height=rect.bottom-rect.top};}
    public static void Run() {
        var json=new JavaScriptSerializer();json.MaxJsonLength=12000000;
        try {
            var request=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
            // EOF means the owning connector died. Never keep an orphan helper.
            var owner=new Thread(()=>{try{Console.ReadLine();}catch{} Environment.Exit(1);});owner.IsBackground=true;owner.Start();
            SetProcessDpiAwarenessContext((IntPtr)(-4));
            string action=Convert.ToString(request["action"]);
            if(action=="windows.list") {
                var windows=new List<object>();int limit=request.ContainsKey("limit")?Convert.ToInt32(request["limit"]):100;
                if(limit<1||limit>200)throw new ArgumentException("Window limit must be 1..200.");
                string query=request.ContainsKey("query")?Convert.ToString(request["query"]):"";
                if(query.Length>256)throw new ArgumentException("Window query is too long.");
                bool truncated=false;
                EnumWindows((window,context)=>{
                    if(!IsWindowVisible(window))return true;
                    var title=new System.Text.StringBuilder(1024);GetWindowTextW(window,title,title.Capacity);
                    if(title.Length==0||title.ToString().IndexOf(query,StringComparison.OrdinalIgnoreCase)<0)return true;
                    if(windows.Count==limit){truncated=true;return false;}
                    Rect rect;if(GetWindowRect(window,out rect))windows.Add(new{windowId=window.ToInt64().ToString("x"),pid=Pid(window),title=title.ToString(),minimized=IsIconic(window),bounds=Bounds(rect)});
                    return true;
                },IntPtr.Zero);
                Console.WriteLine(json.Serialize(new{windows,truncated}));return;
            }
            if(action!="screen.capture")throw new ArgumentException("Unsupported desktop operation.");
            int maxWidth=request.ContainsKey("maxWidth")?Convert.ToInt32(request["maxWidth"]):1920;
            if(maxWidth<320||maxWidth>3840)throw new ArgumentException("maxWidth must be 320..3840.");
            IntPtr target=IntPtr.Zero;uint expectedPid=0;Rect area;
            if(request.ContainsKey("windowId")) {
                string id=Convert.ToString(request["windowId"]);
                if(id.Length<1||id.Length>16)throw new ArgumentException("Invalid window ID.");
                target=new IntPtr(Convert.ToInt64(id,16));
                if(!request.ContainsKey("pid"))throw new ArgumentException("Window capture requires the queried pid.");
                expectedPid=Convert.ToUInt32(request["pid"]);
                if(!IsWindow(target)||Pid(target)!=expectedPid||IsIconic(target)||!GetWindowRect(target,out area))throw new ArgumentException("Window changed or is minimized; query its current identity.");
            } else {
                var screen=SystemInformation.VirtualScreen;
                area=new Rect{left=screen.Left,top=screen.Top,right=screen.Right,bottom=screen.Bottom};
            }
            int width=area.right-area.left,height=area.bottom-area.top;
            if(width<1||height<1||(long)width*height>33554432)throw new ArgumentException("Desktop dimensions are unavailable or exceed 32 megapixels.");
            using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
                using(var graphics=Graphics.FromImage(bitmap)) {
                    if(target==IntPtr.Zero)graphics.CopyFromScreen(area.left,area.top,0,0,new Size(width,height));
                    else { var dc=graphics.GetHdc();try{if(!PrintWindow(target,dc,2))throw new InvalidOperationException("This window does not support capture.");}finally{graphics.ReleaseHdc(dc);} }
                }
                if(target!=IntPtr.Zero&&(!IsWindow(target)||Pid(target)!=expectedPid))throw new InvalidOperationException("Window identity changed during capture.");
                int outputWidth=Math.Min(width,maxWidth),outputHeight=Math.Max(1,(int)((long)height*outputWidth/width));
                using(var scaled=new Bitmap(bitmap,new Size(outputWidth,outputHeight)))using(var bytes=new MemoryStream()) {
                    scaled.Save(bytes,ImageFormat.Png);
                    if(bytes.Length>8388608)throw new InvalidOperationException("Screenshot exceeds 8 MiB; reduce maxWidth.");
                    Console.WriteLine(json.Serialize(new{mimeType="image/png",width=outputWidth,height=outputHeight,bounds=Bounds(area),capturedAt=DateTime.UtcNow.ToString("o"),data=Convert.ToBase64String(bytes.ToArray())}));
                }
            }
        } catch(Exception error){Console.WriteLine(json.Serialize(new{error=error.Message}));}
    }
}
'@
$nativeHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeSource.Replace("`r`n", "`n")))).Replace('-', '').ToLowerInvariant()
$nativeAssembly = Join-Path $PSScriptRoot "../dist/native/computer-$nativeHash.dll"
if (Test-Path -LiteralPath $nativeAssembly) {
    Add-Type -Path $nativeAssembly
} else {
    Add-Type -ReferencedAssemblies System.Web.Extensions,System.Drawing,System.Windows.Forms -TypeDefinition $nativeSource
}
[RabiComputer]::Run()
