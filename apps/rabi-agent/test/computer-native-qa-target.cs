using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ComputerNativeQaTarget {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x,y;public uint data,flags,time;public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort key,scan;public uint flags,time;public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput mouse;[FieldOffset(0)] public KeyInput key; }
    [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public InputUnion value;}
    [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr window,int index);
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,WindowCallback callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window,System.Text.StringBuilder text,int length);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
    delegate bool WindowCallback(IntPtr window,IntPtr data);
    static readonly object output=new object();static Form form;static TextBox text;static Button button;static Panel panel;
    static int clicks,downs,ups,wheel;static int slowPrintMs,activePrints,totalPrints;static int markerX=40,markerY=20;static Bitmap marker;static Form auxiliary;static long downAt,upAt;static readonly Stopwatch clock=Stopwatch.StartNew();static Process helper;
    static readonly Dictionary<int,Process> observed=new Dictionary<int,Process>();static bool ownShift;
    static uint Shift(bool up){return SendInput(1,new[]{new Input{type=1,value=new InputUnion{key=new KeyInput{key=0x10,flags=up?2u:0u,extra=new UIntPtr(0x51415249)}}}},Marshal.SizeOf(typeof(Input)));}
    static readonly JavaScriptSerializer json=new JavaScriptSerializer();
    static uint Pid(IntPtr window){uint value;GetWindowThreadProcessId(window,out value);return value;}
    static void Emit(object value){lock(output){Console.WriteLine(json.Serialize(value));Console.Out.Flush();}}
    static object Position(Control control){var p=control.PointToScreen(new System.Drawing.Point(control.Width/2,control.Height/2));return new{x=p.X,y=p.Y};}
    sealed class FixtureForm:Form { protected override void WndProc(ref Message message){if(message.Msg==0x317||message.Msg==0x318){int delay=Interlocked.Exchange(ref slowPrintMs,0);Interlocked.Increment(ref totalPrints);if(delay>0){Interlocked.Increment(ref activePrints);try{Thread.Sleep(delay);}finally{Interlocked.Decrement(ref activePrints);}}}base.WndProc(ref message);} }
    [STAThread] static int Main(string[] args){
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new System.Text.UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new System.Text.UTF8Encoding(false)){AutoFlush=true});
        SetProcessDpiAwarenessContext((IntPtr)(-4));
        var previous=GetForegroundWindow();uint previousPid=Pid(previous);Point cursor;GetCursorPos(out cursor);
        form=new FixtureForm{TopMost=true,Text="RabiComputerQA-"+Guid.NewGuid(),Width=640,Height=480,StartPosition=FormStartPosition.Manual,Location=new System.Drawing.Point(80,80)};
        text=new TextBox{Left=20,Top=20,Width=560,Height=100,Multiline=true};button=new Button{Left=20,Top=150,Width=200,Height=40,Text="Fixture click"};panel=new Panel{Left=20,Top=220,Width=550,Height=160,BackColor=Color.CornflowerBlue};
        button.Click+=(s,e)=>clicks++;panel.MouseDown+=(s,e)=>{downs++;downAt=clock.ElapsedMilliseconds;};panel.MouseUp+=(s,e)=>{ups++;upAt=clock.ElapsedMilliseconds;};panel.MouseWheel+=(s,e)=>wheel+=e.Delta;
        marker=new Bitmap(32,24);var pixels=new Random(341);for(int y=0;y<24;y++)for(int x=0;x<32;x++)marker.SetPixel(x,y,Color.FromArgb(pixels.Next(20,240),pixels.Next(20,240),pixels.Next(20,240)));
        panel.Paint+=(sender,eventArgs)=>eventArgs.Graphics.DrawImageUnscaled(marker,markerX,markerY);
        form.Controls.Add(text);form.Controls.Add(button);form.Controls.Add(panel);
        form.Shown+=(s,e)=>{ShowWindow(form.Handle,5);form.Activate();SetForegroundWindow(form.Handle);Emit(new{eventType="ready",visible=IsWindowVisible(form.Handle),windowId=form.Handle.ToInt64().ToString("x"),pid=Process.GetCurrentProcess().Id,title=form.Text,text=Position(text),button=Position(button),panel=Position(panel),previousWindow=previous.ToInt64().ToString("x"),previousPid=previousPid});};
        var reader=new Thread(()=>{try{string line;while((line=Console.ReadLine())!=null){var request=json.Deserialize<Dictionary<string,object>>(line);string action=Convert.ToString(request["action"]);
            if(action=="slow-print"){Interlocked.Exchange(ref slowPrintMs,Convert.ToInt32(request["ms"]));Emit(new{action=action});continue;}
            if(action=="async-state"){Emit(new{action=action,leftDown=GetAsyncKeyState(1)<0,activePrints=Interlocked.CompareExchange(ref activePrints,0,0),totalPrints=Interlocked.CompareExchange(ref totalPrints,0,0)});continue;}
            form.Invoke((Action)(()=>{
            try{
                if(action=="activation-point"){var p=text.PointToScreen(new System.Drawing.Point(text.Width/2,text.Height/2));var hit=WindowFromPoint(new Point{x=p.X,y=p.Y});Rect hitBounds;GetWindowRect(hit,out hitBounds);int style=GetWindowLongW(hit,-20);IntPtr underlying=hit;bool through=false;
                    if(request.ContainsKey("helperPid")&&Pid(hit)==Convert.ToUInt32(request["helperPid"])&&(GetWindowLongW(hit,-20)&0x80020)==0x80020){
                        through=true;underlying=GetWindow(hit,2);while(underlying!=IntPtr.Zero){Rect rect;if(IsWindowVisible(underlying)&&GetWindowRect(underlying,out rect)&&p.X>=rect.left&&p.X<rect.right&&p.Y>=rect.top&&p.Y<rect.bottom)break;underlying=GetWindow(underlying,2);}
                    }
                    Emit(new{action=action,owned=Pid(underlying)==(uint)Process.GetCurrentProcess().Id,hitPid=Pid(hit),hitWindow=hit.ToInt64().ToString("x"),hitStyle=style.ToString("x"),hitBounds=new{x=hitBounds.left,y=hitBounds.top,width=hitBounds.right-hitBounds.left,height=hitBounds.bottom-hitBounds.top},throughOwnedOverlay=through,underlyingPid=Pid(underlying),underlyingWindow=underlying.ToInt64().ToString("x"),x=p.X,y=p.Y});}
                else if(action=="focus"){form.Activate();SetForegroundWindow(form.Handle);text.Focus();Emit(new{action=action,foreground=GetForegroundWindow()==form.Handle});}
                else if(action=="marker"){var p=panel.PointToScreen(new System.Drawing.Point(markerX,markerY));Emit(new{action=action,x=p.X,y=p.Y,width=32,height=24});}
                else if(action=="move-marker"){markerX+=8;panel.Invalidate();panel.Update();Emit(new{action=action});}
                else if(action=="move-window"){form.Location=new System.Drawing.Point(form.Left+25,form.Top+15);Emit(new{action=action,x=form.Left,y=form.Top});}
                else if(action=="aux-open"){auxiliary=new Form{Width=400,Height=200,Text="Rabi QA source",ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Location=new System.Drawing.Point(150,200)};auxiliary.Show();ShowWindow(auxiliary.Handle,4);Emit(new{action=action,windowId=auxiliary.Handle.ToInt64().ToString("x"),pid=Process.GetCurrentProcess().Id});}
                else if(action=="aux-close"){if(auxiliary!=null)auxiliary.Close();Emit(new{action=action});}
                else if(action=="status")Emit(new{action=action,text=text.Text,clicks=clicks,downs=downs,ups=ups,downAt=downAt,upAt=upAt,wheel=wheel,heldShift=GetAsyncKeyState(0x10)<0,foreground=GetForegroundWindow()==form.Handle});
                else if(action=="watch"){helper=Process.GetProcessById(Convert.ToInt32(request["pid"]));observed.Add(helper.Id,helper);var handle=helper.Handle;Emit(new{action=action,pid=helper.Id,startedAt=helper.StartTime.ToUniversalTime().ToString("o"),image=helper.MainModule.FileName,wait=WaitForSingleObject(handle,0)});}
                else if(action=="wait"){var process=request.ContainsKey("pid")?observed[Convert.ToInt32(request["pid"])]:helper;Emit(new{action=action,pid=process.Id,wait=WaitForSingleObject(process.Handle,0)});}
                else if(action=="hold-shift"){bool existing=GetAsyncKeyState(0x10)<0;uint count=existing?0:Shift(false);ownShift=count==1;Emit(new{action=action,alreadyHeld=existing,injectedEvents=count});}
                else if(action=="release-shift"){uint count=ownShift?Shift(true):0;ownShift=false;Emit(new{action=action,injectedEvents=count});}
                else if(action=="exit-button"){
                    IntPtr selected=IntPtr.Zero;int pid=Convert.ToInt32(request["pid"]);
                    EnumWindows((window,data)=>{if(Pid(window)!=(uint)pid)return true;EnumChildWindows(window,(child,unused)=>{var title=new System.Text.StringBuilder(100);GetWindowTextW(child,title,title.Capacity);if(title.ToString()=="退出控制")selected=child;return true;},IntPtr.Zero);return true;},IntPtr.Zero);
                    if(selected==IntPtr.Zero)throw new Exception("Owned helper exit button was not found.");SendMessageW(selected,0xf5,IntPtr.Zero,IntPtr.Zero);Emit(new{action=action,invoked=true});
                }
                else if(action=="close"){Emit(new{action=action});form.Close();}
            }catch(Exception error){Emit(new{action=action,error=error.Message});}
        }));}}
        finally{if(!form.IsDisposed)form.BeginInvoke((Action)(()=>form.Close()));}});reader.IsBackground=true;reader.Start();
        Application.Run(form);
        if(previous!=IntPtr.Zero&&IsWindow(previous)&&Pid(previous)==previousPid)SetForegroundWindow(previous);SetCursorPos(cursor.x,cursor.y);
        if(ownShift)Shift(true);if(marker!=null)marker.Dispose();foreach(var process in observed.Values)process.Dispose();return 0;
    }
}
