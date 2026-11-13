using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using DesktopScreen=System.Windows.Forms.Screen;

public static class RabiComputer {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x,y; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyInput key; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion value; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHookData { public int x,y; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyHookData { public uint key,scan,flags,time; public UIntPtr extra; }
    delegate bool WindowCallback(IntPtr window,IntPtr context);
    delegate IntPtr HookCallback(int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr context);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window,System.Text.StringBuilder title,int length);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll",SetLastError=true)] static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window,int id);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookExW(int kind,HookCallback callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point,uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor,int kind,out uint x,out uint y);

    static long physicalInputEpoch,physicalMouseEpoch,activePhysicalEpoch,activeDeadlineUtcMs,batchGeneration;
    static string presentationPhase="ready",presentationRequestId;static bool nativeBarMode=true;
    static object presentationReturnState,presentationDisplay,presentationRegion,presentationStopAction;
    static readonly object outputLock=new object(), stateLock=new object(), inputGate=new object(), frameLock=new object();
    static readonly UIntPtr injectionMarker=new UIntPtr(0x52414249);
    static readonly HashSet<int> ownedKeys=new HashSet<int>(), ownedButtons=new HashSet<int>();
    static readonly HashSet<ushort> ownedUnicode=new HashSet<ushort>();
    static string activeInputRequest,activeInputSession; static IntPtr inputWindow; static uint inputPid;
    static readonly Dictionary<string,int> retiredLayers=new Dictionary<string,int>();
    public static string NativeDirectory=AppDomain.CurrentDomain.BaseDirectory;
    static readonly HashSet<string> cancelledRequests=new HashSet<string>();
    static readonly Dictionary<string,int> pendingControlBegins=new Dictionary<string,int>();
    static readonly HashSet<string> endingControlSessions=new HashSet<string>();
    static readonly Dictionary<string,int> pendingInputCounts=new Dictionary<string,int>();
    static readonly Dictionary<string,string> pendingInputSessions=new Dictionary<string,string>();
    static readonly HashSet<uint> initialPhysicalKeys=new HashSet<uint>();
    static readonly Dictionary<string,Dictionary<string,object>> layers=new Dictionary<string,Dictionary<string,object>>();
    static readonly Dictionary<string,Frame> frames=new Dictionary<string,Frame>();
    static readonly List<string> frameOrder=new List<string>();
    static readonly Dictionary<string,Tracking> tracking=new Dictionary<string,Tracking>();
    static readonly AutoResetEvent trackingWake=new AutoResetEvent(false);
    static int budgetOverruns;static long memorySampleAt,sampledNativePrivateBytes;static DateTime memorySampleUtc;
    static readonly BlockingCollection<Dictionary<string,object>> inputRequests=new BlockingCollection<Dictionary<string,object>>();
    static readonly BlockingCollection<Dictionary<string,object>> recoveryReplies=new BlockingCollection<Dictionary<string,object>>();
    static Overlay overlay; static ControlBar bar; static SynchronizationContext ui; static Dictionary<string,object> settings=new Dictionary<string,object>();
    static string session=null; static bool stopping=false, exitOnLocal=false, showPointer=true, pointerVisible=false, externalQt=false;
    static Point pointer; static Stopwatch lastActivity=new Stopwatch(); static double idleSeconds=120,countdown=10; static bool idleEnabled=true;
    static HookCallback keyboardHook,mouseHook; static IntPtr keyboardHandle,mouseHandle; static bool hotkeyRegistered=false; static string hotkeyError=null;
    static int presentationRevision; static int lastPhysicalX=int.MinValue,lastPhysicalY=int.MinValue; static uint exitKey; static bool physicalExitPending; static Thread trackingWorker;
    class Frame : IDisposable { public string id;public Bitmap bitmap;public Rectangle bounds;public Dictionary<string,object> source;public DateTime created;public bool shared;public Dictionary<string,Size> imageItems=new Dictionary<string,Size>(); public void Dispose(){if(!shared)bitmap.Dispose();} }
    class Tracking { public string id,layerId,sourceKey;public int version,targetCount;public long created=Stopwatch.GetTimestamp();public double lastCostMs;public object engine;public MethodInfo step;public Dictionary<string,object> request,status;public volatile bool stopped;public volatile bool inFlight;public volatile bool initialized;public bool finalized;public string stopReason;public Dictionary<string,object> pendingSettings;public DateTime? expires;public double rate;public long due; }
    static object Get(Dictionary<string,object> value,string key,object fallback=null){object result;return value!=null&&value.TryGetValue(key,out result)?result:fallback;}
    static string Str(Dictionary<string,object> value,string key,string fallback=""){return Convert.ToString(Get(value,key,fallback));}
    static double Num(Dictionary<string,object> value,string key,double fallback=0){return Convert.ToDouble(Get(value,key,fallback));}
    static bool Bool(Dictionary<string,object> value,string key,bool fallback=false){return Convert.ToBoolean(Get(value,key,fallback));}
    static Dictionary<string,object> Obj(object value){return value as Dictionary<string,object>??new Dictionary<string,object>();}
    static List<object> Items(object value){var result=new List<object>();var enumerable=value as IEnumerable;if(enumerable!=null)foreach(var item in enumerable)result.Add(item);return result;}
    static void Emit(object value){lock(outputLock){Console.WriteLine(new JavaScriptSerializer{MaxJsonLength=20000000}.Serialize(value));Console.Out.Flush();}}
    static void Event(string name,object value){Emit(new{ @event=name,data=value});}
    static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
    static Dictionary<string,object> Bounds(Rectangle area){return new Dictionary<string,object>{{"x",area.X},{"y",area.Y},{"width",area.Width},{"height",area.Height}};}
    static void UI(Action action){if(ui==null)throw new InvalidOperationException("Desktop presentation is not ready.");ui.Send(_=>action(),null);}
    static void Redraw(){if(ui!=null)ui.Post(_=>{overlay.Invalidate();bar.RefreshStatus();PublishPresentation();},null);}
    static void PublishPresentation(){Event("presentation",new{phase=presentationPhase,requestId=presentationRequestId,returnState=presentationReturnState,stopAction=presentationStopAction,sourceDisplay=presentationDisplay,observedRegion=presentationRegion,presentationSettings=Obj(Get(settings,"presentation")),revision=++presentationRevision,controlSessionId=session,source=bar.Source,remainingMs=Remaining(),pointer=pointerVisible?new{x=pointer.X,y=pointer.Y}:null,exitShortcut=Str(Obj(Get(settings,"control")),"exitShortcut","Ctrl+Alt+Esc"),countdownSeconds=countdown,layers=layers.Values});}
    static double? Remaining(){return session==null||!idleEnabled?(double?)null:Math.Max(0,idleSeconds*1000-lastActivity.Elapsed.TotalMilliseconds);}
    static Dictionary<string,object> MergeSettings(Dictionary<string,object> original,Dictionary<string,object> patch){
        var result=new Dictionary<string,object>(original);
        foreach(var pair in patch){
            var nested=pair.Value as Dictionary<string,object>;
            result[pair.Key]=nested==null?pair.Value:MergeSettings(Obj(Get(original,pair.Key)),nested);
        }
        return result;
    }
    static Dictionary<string,object> RequestSettings(Dictionary<string,object> request){
        var supplied=Get(request,"settings");
        return supplied==null?settings:Obj(supplied);
    }
    static Dictionary<string,object> SelectSettingsDomains(Dictionary<string,object> value,params string[] domains){
        var selected=new Dictionary<string,object>();
        foreach(string domain in domains)if(value.ContainsKey(domain))selected[domain]=value[domain];
        return selected;
    }
    static void ApplyControlSettings(Dictionary<string,object> value){
        var control=Obj(Get(value,"control"));
        idleEnabled=Bool(control,"idleExitEnabled",true);idleSeconds=Num(control,"idleTimeoutSeconds",120);
        countdown=Num(control,"countdownSeconds",10);exitOnLocal=Bool(control,"exitOnLocalInput",false);showPointer=Bool(control,"showPointer",true);
        if(session!=null)RegisterExit(Str(control,"exitShortcut","Ctrl+Alt+Esc"));
    }
    static void ApplyControlRequestSettings(Dictionary<string,object> request){
        var value=RequestSettings(request);
        var patch=SelectSettingsDomains(value,"control","enabled");
        var features=Obj(Get(value,"features"));
        if(features.ContainsKey("input"))patch["features"]=new Dictionary<string,object>{{"input",features["input"]}};
        settings=MergeSettings(settings,patch);
        ApplyControlSettings(settings);
    }
    static void ApplyTrackingBudget(Dictionary<string,object> value){
        // Aggregate native-process budgets have one owner. New tracker admission
        // updates that budget without reconfiguring existing tracker engines.
        if(value.ContainsKey("performance"))settings=MergeSettings(settings,SelectSettingsDomains(value,"performance"));
    }
    static void ApplySettingsPatch(Dictionary<string,object> patch){ApplySettings(MergeSettings(settings,patch),patch);}
    static void ApplySettings(Dictionary<string,object> value){ApplySettings(value,null);}
    static void ApplySettings(Dictionary<string,object> value,Dictionary<string,object> patch){
        settings=value;
        if(patch==null||patch.ContainsKey("control"))ApplyControlSettings(value);
        bool policyChanged=patch==null||patch.ContainsKey("enabled")||patch.ContainsKey("features")||patch.ContainsKey("annotation");
        if(policyChanged&&session!=null&&(!Bool(value,"enabled",true)||!Bool(Obj(Get(value,"features")),"input",true)))EndControl(session,"settings-disabled");
        bool annotations=Bool(value,"enabled",true)&&Bool(Obj(Get(value,"features")),"annotation",true);
        List<Tracking> jobs;lock(tracking)jobs=new List<Tracking>(tracking.Values);
        foreach(var item in jobs){
            if(policyChanged&&!annotations)StopTracking(item,true,"settings-disabled");
            else if(policyChanged&&(!Bool(Obj(Get(value,"features")),"observation",true)||!Bool(Obj(Get(value,"annotation")),"dynamicEnabled")))StopTracking(item,false,"dynamic-disabled");
            else {
                var selected=patch==null?value:MergeSettings(RequestSettings(item.request),patch);
                item.request["settings"]=selected;item.pendingSettings=selected;
            }
        }
        if(policyChanged&&!annotations)foreach(string id in new List<string>(layers.Keys))Annotation(new Dictionary<string,object>{{"action","annotation.clear"},{"layerId",id},{"version",Num(layers[id],"version",1)}});
        trackingWake.Set();
    }
    static uint KeyCode(string key){
        switch(key.ToUpperInvariant()){case "CTRL":case "CONTROL":return 0x11;case "ALT":return 0x12;case "SHIFT":return 0x10;case "WIN":case "META":return 0x5b;case "ESC":case "ESCAPE":return 0x1b;case "ENTER":case "RETURN":return 0x0d;case "TAB":return 9;case "SPACE":return 0x20;case "BACKSPACE":return 8;case "DELETE":return 0x2e;case "LEFT":return 0x25;case "UP":return 0x26;case "RIGHT":return 0x27;case "DOWN":return 0x28;case "HOME":return 0x24;case "END":return 0x23;case "PAGEUP":return 0x21;case "PAGEDOWN":return 0x22;}
        if(key.Length==1)return (uint)char.ToUpperInvariant(key[0]);uint number;if(key.Length>1&&key[0]=='F'&&uint.TryParse(key.Substring(1),out number)&&number>=1&&number<=24)return 0x70+number-1;throw new ArgumentException("Unknown native key: "+key);
    }
    static void RegisterExit(string shortcut){
        UnregisterHotKey(bar.Handle,1);hotkeyRegistered=false;hotkeyError=null;uint modifiers=0,key=0;
        try{foreach(var name in shortcut.Split('+')){switch(name.Trim().ToUpperInvariant()){case "CTRL":case "CONTROL":modifiers|=2;break;case "ALT":modifiers|=1;break;case "SHIFT":modifiers|=4;break;case "WIN":modifiers|=8;break;default:key=KeyCode(name.Trim());break;}}
            if(key==0)throw new ArgumentException("The exit shortcut needs a non-modifier key.");exitKey=key;physicalExitPending=false;hotkeyRegistered=RegisterHotKey(bar.Handle,1,modifiers|0x4000,key);if(!hotkeyRegistered)hotkeyError=new Win32Exception(Marshal.GetLastWin32Error()).Message;
        }catch(Exception error){hotkeyError=error.Message;}
    }
    static uint Inject(Input value,bool cleanup=false){lock(stateLock){if(!cleanup)CheckInput(activeInputSession,activeInputRequest);uint count=SendInput(1,new[]{value},Marshal.SizeOf(typeof(Input)));if(count!=1)throw new InvalidOperationException("SendInput inserted "+count+" of 1 events. The target desktop or OS integrity level may block injection.");return count;}}
    static uint Key(ushort key,ushort scan,uint flags,bool cleanup=false){return Inject(new Input{type=1,value=new InputUnion{key=new KeyInput{key=key,scan=scan,flags=flags,extra=injectionMarker}}},cleanup);}
    static uint Mouse(int x,int y,uint flags,uint data=0,bool cleanup=false){return Inject(new Input{type=0,value=new InputUnion{mouse=new MouseInput{x=x,y=y,flags=flags,data=data,extra=injectionMarker}}},cleanup);}
    static void ReleaseOwned(){lock(stateLock){foreach(ushort scan in new List<ushort>(ownedUnicode)){Key(0,scan,6,true);ownedUnicode.Remove(scan);}foreach(int key in new List<int>(ownedKeys)){Key((ushort)key,0,2,true);ownedKeys.Remove(key);}foreach(int button in new List<int>(ownedButtons)){Mouse(0,0,(uint)button,0,true);ownedButtons.Remove(button);}}}
    static void EndControl(string id,string reason,bool announce=true){
        lock(stateLock){if(session==null||session!=id)return;ReleaseOwned();session=null;pointerVisible=false;lastActivity.Reset();UnregisterHotKey(bar.Handle,1);hotkeyRegistered=false;}
        if(ui!=null)ui.Post(_=>{presentationPhase="stopped";presentationStopAction=null;bar.RefreshStatus();overlay.Invalidate();PublishPresentation();},null);if(announce)Event("control-ended",new{controlSessionId=id,reason=reason});
    }
    static void CheckInput(string id,string request){lock(stateLock){
        if(activeInputRequest!=null&&activeInputRequest==request){
            if(!Bool(settings,"enabled",true)||!Bool(Obj(Get(settings,"features")),"input",true))throw new OperationCanceledException("native-input-settings-disabled");
            if(Interlocked.Read(ref physicalInputEpoch)!=activePhysicalEpoch)throw new OperationCanceledException("physical-input-takeover");
            if(activeDeadlineUtcMs>0&&UtcMilliseconds()>=activeDeadlineUtcMs)throw new OperationCanceledException("native-input-deadline");
        }if(stopping||session==null||session!=id||cancelledRequests.Contains(request))throw new OperationCanceledException("The native input intent ended.");if(inputWindow!=IntPtr.Zero&&(!IsWindow(inputWindow)||Pid(inputWindow)!=inputPid||GetForegroundWindow()!=inputWindow))throw new InvalidOperationException("The original window or foreground target changed.");}}
    static Dictionary<string,object> ValidateSource(Dictionary<string,object> request,Dictionary<string,object> source){
        string target=Str(request,"instanceId");
        if(target!=""&&Str(source,"instanceId")!=""&&Str(source,"instanceId")!=target)throw new InvalidOperationException("The source belongs to a different computer instance.");
        string layout=Str(source,"layoutRevision");if(layout!=""&&layout!=LayoutRevision())throw new InvalidOperationException("The source display layout changed; observe again.");
        string frameId=Str(source,"frameId");if(frameId==""){if(source.ContainsKey("imageView"))throw new ArgumentException("imageView requires a cached capture source frame.");return source;}
        Dictionary<string,object> original;
        lock(frameLock){Frame frame;if(!frames.TryGetValue(frameId,out frame))throw new InvalidOperationException("The referenced original source frame is no longer cached; observe the target again.");original=new Dictionary<string,object>(frame.source);}
        if(Str(original,"instanceId")!=Str(source,"instanceId")||target!=""&&Str(original,"instanceId")!=target||Str(original,"kind")!=Str(source,"kind")||Str(original,"windowId")!=Str(source,"windowId")||Str(original,"pid")!=Str(source,"pid"))throw new InvalidOperationException("The source frame does not match the target computer/window identity.");
        if(SourceKey(original)!=SourceKey(source))throw new InvalidOperationException("The source frame scope/display/region/layout identity changed.");
        string imageItemId=Str(source,"imageItemId"),variant=Str(source,"coordinateVariant","image");
        Size expectedSize;
        lock(frameLock){Frame frame;if(!frames.TryGetValue(frameId,out frame))throw new InvalidOperationException("The source frame expired during validation.");
            if(imageItemId!=""){
                if(!frame.imageItems.TryGetValue(imageItemId,out expectedSize))throw new InvalidOperationException("The delivered imageItemId does not belong to this source frame.");
            }else{
                if(frame.imageItems.Count>0)throw new InvalidOperationException("The cached delivered frame requires its original imageItemId.");
                expectedSize=frame.bitmap.Size;
            }
            if(variant=="raw")expectedSize=frame.bitmap.Size;else if(variant!="image")throw new ArgumentException("Unknown source coordinateVariant.");
        }
        if(Num(source,"width")!=expectedSize.Width||Num(source,"height")!=expectedSize.Height)throw new InvalidOperationException("Coordinate source dimensions do not match its cached image variant.");
        original["width"]=expectedSize.Width;original["height"]=expectedSize.Height;original["coordinateVariant"]=variant;
        if(imageItemId!="")original["imageItemId"]=imageItemId;
        if(source.ContainsKey("imageView")){
            var view=Obj(Get(source,"imageView"));
            double viewWidth=Num(view,"width"),viewHeight=Num(view,"height");
            if(Str(original,"coordinateSpace")!="capture"||imageItemId==""||!PixelDimension(Get(view,"width"))||!PixelDimension(Get(view,"height"))||view.Count!=2||!view.ContainsKey("width")||!view.ContainsKey("height")||
                Double.IsNaN(viewWidth)||Double.IsInfinity(viewWidth)||viewWidth<1||viewWidth>Int32.MaxValue||viewWidth!=Math.Truncate(viewWidth)||
                Double.IsNaN(viewHeight)||Double.IsInfinity(viewHeight)||viewHeight<1||viewHeight>Int32.MaxValue||viewHeight!=Math.Truncate(viewHeight))
                throw new ArgumentException("imageView needs positive integer width/height and its original capture imageItemId.");
            original["imageView"]=new Dictionary<string,object>{{"width",(int)viewWidth},{"height",(int)viewHeight}};
        }
        if(Str(original,"kind")=="window"){
            IntPtr window=new IntPtr(Convert.ToInt64(Str(original,"windowId"),16));Rect rect;uint pid=Convert.ToUInt32(Get(original,"pid"));
            if(!IsWindow(window)||Pid(window)!=pid||!GetWindowRect(window,out rect))throw new InvalidOperationException("The original window no longer exists.");
            var before=Obj(Get(original,"bounds"));if(rect.right-rect.left!=Num(before,"width")||rect.bottom-rect.top!=Num(before,"height"))throw new InvalidOperationException("The original window layout changed; observe its new frame before coordinate input.");
            original["bounds"]=Bounds(new Rectangle(rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top));
        }
        return original;
    }
    // Frame dimensions identify the cached image. imageView describes the whole image presented to the agent.
    static bool PixelDimension(object value){return value is int||value is long||value is double||value is decimal||value is float;}
    static Dictionary<string,object> TrackingCoordinateSource(Dictionary<string,object> source,Dictionary<string,object> rawSource){
        var projected=new Dictionary<string,object>(rawSource);var dimensions=CoordinateDimensions(source);
        projected["width"]=dimensions.Width;projected["height"]=dimensions.Height;
        return projected;
    }
    static SizeF CoordinateDimensions(Dictionary<string,object> source){
        var dimensions=source.ContainsKey("imageView")?Obj(Get(source,"imageView")):source;
        return new SizeF((float)Num(dimensions,"width"),(float)Num(dimensions,"height"));
    }
    static Point Position(Dictionary<string,object> action,Dictionary<string,object> source,string xKey,string yKey){
        double x=Num(action,xKey),y=Num(action,yKey);
        if(Str(source,"coordinateSpace")=="capture"){
            var bounds=Obj(Get(source,"bounds"));var dimensions=CoordinateDimensions(source);double width=dimensions.Width,height=dimensions.Height;if(width<=0||height<=0)throw new ArgumentException("Capture coordinates need original dimensions.");
            x=Num(bounds,"x")+x*Num(bounds,"width")/width;y=Num(bounds,"y")+y*Num(bounds,"height")/height;
        }
        return new Point((int)Math.Round(x),(int)Math.Round(y));
    }
    static uint Move(Point point){lock(stateLock){var screen=SystemInformation.VirtualScreen;uint inserted=Mouse((int)Math.Round((point.X-screen.Left)*65535.0/Math.Max(1,screen.Width-1)),(int)Math.Round((point.Y-screen.Top)*65535.0/Math.Max(1,screen.Height-1)),0x0001|0x8000|0x4000);pointer=point;pointerVisible=showPointer;Redraw();return inserted;}}
    static Dictionary<string,object> ExecuteInputAction(Dictionary<string,object> action,Dictionary<string,object> source,string id,string requestId,int segment){
        uint inserted=0;
        try{
            string type=Str(action,"type");
            if(type=="move"||type=="click"||type=="drag"||type=="scroll"&&action.ContainsKey("x")&&action.ContainsKey("y"))inserted+=Move(Position(action,source,"x","y"));
            if(type=="click"||type=="drag"){
                string button=Str(action,"button","left");uint down=button=="right"?8u:button=="middle"?32u:2u;uint up=down*2;int count=type=="drag"?1:(int)Num(action,"count",1);
                if(count<1||count>2)throw new ArgumentException("Click count must be one or two.");
                for(int c=0;c<count;c++){
                    CheckInput(id,requestId);lock(stateLock){if(GetAsyncKeyState(button=="right"?2:button=="middle"?4:1)<0)throw new InvalidOperationException("The physical mouse button is already held.");CheckInput(id,requestId);inserted+=Mouse(0,0,down);ownedButtons.Add((int)up);}
                    if(type=="drag"){
                        Point from=Position(action,source,"x","y"),to=Position(action,source,"toX","toY");int duration=Math.Max(segment,(int)Num(action,"durationMs",250));
                        for(int elapsed=segment;elapsed<duration;elapsed+=segment){Thread.Sleep(segment);CheckInput(id,requestId);inserted+=Move(new Point(from.X+(to.X-from.X)*elapsed/duration,from.Y+(to.Y-from.Y)*elapsed/duration));}CheckInput(id,requestId);inserted+=Move(to);
                    }
                    lock(stateLock){inserted+=Mouse(0,0,up);ownedButtons.Remove((int)up);}if(c+1<count)Thread.Sleep(Math.Min(segment,16));
                }
            }else if(type=="scroll"){
                double dy=Num(action,"deltaY"),dx=Num(action,"deltaX");if(dy!=0)inserted+=Mouse(0,0,0x0800,unchecked((uint)(int)(dy*120)));if(dx!=0)inserted+=Mouse(0,0,0x1000,unchecked((uint)(int)(dx*120)));
            }else if(type=="text"){
                string text=Str(action,"text");int n=0;foreach(char ch in text){CheckInput(id,requestId);lock(stateLock){CheckInput(id,requestId);if(ch=='\n'){if(GetAsyncKeyState(0x0d)<0)throw new InvalidOperationException("The physical Enter key is already held.");inserted+=Key(0x0d,0,0);ownedKeys.Add(0x0d);inserted+=Key(0x0d,0,2);ownedKeys.Remove(0x0d);}else{inserted+=Key(0,(ushort)ch,4);ownedUnicode.Add((ushort)ch);inserted+=Key(0,(ushort)ch,6);ownedUnicode.Remove((ushort)ch);}}if(++n%32==0)Thread.Sleep(1);}
            }else if(type=="key"){
                var keys=Items(Get(action,"keys"));foreach(var name in keys){CheckInput(id,requestId);int key=(int)KeyCode(Convert.ToString(name));lock(stateLock){if(GetAsyncKeyState(key)<0)continue;CheckInput(id,requestId);inserted+=Key((ushort)key,0,0);ownedKeys.Add(key);}}
                ReleaseOwned();
            }else if(type!="move"&&type!="click"&&type!="drag")throw new ArgumentException("Unsupported input action type.");
            return new Dictionary<string,object>{{"state","injected"},{"injectedEvents",inserted}};
        }catch(OperationCanceledException error){return new Dictionary<string,object>{{"state","cancelled"},{"injectedEvents",inserted},{"reason",error.Message}};}
        catch(Exception error){return new Dictionary<string,object>{{"state","failed"},{"injectedEvents",inserted},{"reason",error.Message}};}
    }
    class InputAnchor {
        public long generation,physicalEpoch,mouseEpoch;public Point cursor;public IntPtr foreground;public uint pid;
        public string batchId,sessionId,layoutRevision;public bool returnCursor,returnForeground;public double returnForegroundTimeoutMs;
    }
    static long UtcMilliseconds(){return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;}
    static bool ReturnAnchorCurrent(InputAnchor anchor){
        return anchor.generation==Interlocked.Read(ref batchGeneration)&&anchor.physicalEpoch==Interlocked.Read(ref physicalInputEpoch);
    }
    static bool ReturnCursorAnchorCurrent(InputAnchor anchor){
        return anchor.generation==Interlocked.Read(ref batchGeneration)&&anchor.mouseEpoch==Interlocked.Read(ref physicalMouseEpoch);
    }
    static void YieldInputReturn(InputAnchor anchor,Dictionary<string,object> result){
        if(!ReturnCursorAnchorCurrent(anchor))result["cursor"]="yielded";
        if(!ReturnAnchorCurrent(anchor))result["foreground"]="yielded";
        result["reason"]="physical-input-takeover";
    }
    static void RestoreInputAnchor(InputAnchor anchor,Dictionary<string,object> result,bool layoutCurrent,Rectangle area){
        // Runs on the hook owner. Mouse activity owns cursor takeover; all physical input owns foreground takeover.
        if(!ReturnCursorAnchorCurrent(anchor))YieldInputReturn(anchor,result);
        else if(!anchor.returnCursor)result["cursor"]="disabled";
        else if(!layoutCurrent)result["cursor"]="unavailable";
        else try{
            int x=(int)Math.Round((anchor.cursor.X-area.Left)*65535.0/Math.Max(1,area.Width-1));
            int y=(int)Math.Round((anchor.cursor.Y-area.Top)*65535.0/Math.Max(1,area.Height-1));
            if(ReturnCursorAnchorCurrent(anchor)){
                Mouse(x,y,0x0001|0x8000|0x4000,0,true);
                if(ReturnCursorAnchorCurrent(anchor))result["cursor"]=Cursor.Position==anchor.cursor?"restored":"partial";
                else YieldInputReturn(anchor,result);
            }else YieldInputReturn(anchor,result);
        }catch(Exception error){result["cursor"]="partial";result["cursorReason"]=error.Message;}
        if(!ReturnAnchorCurrent(anchor)){YieldInputReturn(anchor,result);return;}
        if(!anchor.returnForeground)result["foreground"]="disabled";
        else try{
            if(anchor.foreground!=IntPtr.Zero&&IsWindow(anchor.foreground)&&Pid(anchor.foreground)==anchor.pid){
                bool alreadyForeground=GetForegroundWindow()==anchor.foreground;
                if(!ReturnAnchorCurrent(anchor)){YieldInputReturn(anchor,result);return;}
                if(!alreadyForeground)SetForegroundWindow(anchor.foreground);
                if(!ReturnAnchorCurrent(anchor)){YieldInputReturn(anchor,result);return;}
                result["foreground"]=GetForegroundWindow()==anchor.foreground&&Pid(anchor.foreground)==anchor.pid?"restored":"pending";
            }
        }catch(Exception error){result["foreground"]="partial";result["foregroundReason"]=error.Message;}
        if(!ReturnAnchorCurrent(anchor))YieldInputReturn(anchor,result);
    }
    static void ConfirmForegroundReturn(InputAnchor anchor,Dictionary<string,object> result){
        if(Str(result,"foreground")!="pending")return;
        // The input worker confirms asynchronous focus changes. The hook/UI dispatcher remains free to process physical input.
        var wait=Stopwatch.StartNew();
        try{
            for(;;){
                if(!ReturnAnchorCurrent(anchor)){YieldInputReturn(anchor,result);return;}
                if(!IsWindow(anchor.foreground)||Pid(anchor.foreground)!=anchor.pid){
                    result["foreground"]="unavailable";result["foregroundReason"]="original-window-unavailable";return;
                }
                bool restored=GetForegroundWindow()==anchor.foreground;
                if(!ReturnAnchorCurrent(anchor)){YieldInputReturn(anchor,result);return;}
                if(restored){result["foreground"]="restored";return;}
                double remaining=anchor.returnForegroundTimeoutMs-wait.Elapsed.TotalMilliseconds;
                if(remaining<=0){result["foreground"]="partial";result["foregroundReason"]="foreground-return-timeout";return;}
                Thread.Sleep((int)Math.Ceiling(Math.Min(5,remaining)));
            }
        }finally{result["foregroundWaitMs"]=Math.Round(wait.Elapsed.TotalMilliseconds,2);}
    }
    static Dictionary<string,object> ReturnInput(InputAnchor anchor,string reason,bool released){
        var result=new Dictionary<string,object>{{"keys",released?"restored":"partial"},{"cursor","unavailable"},{"foreground","unavailable"},{"reason",reason}};
        if(anchor==null){result["state"]="unavailable";return result;}
        result["batchId"]=anchor.batchId;result["controlSessionId"]=anchor.sessionId;result["layoutRevision"]=anchor.layoutRevision;
        if(!anchor.returnCursor)result["cursor"]="disabled";
        if(!anchor.returnForeground)result["foreground"]="disabled";
        if(!ReturnCursorAnchorCurrent(anchor)&&!ReturnAnchorCurrent(anchor))YieldInputReturn(anchor,result);
        else if(!anchor.returnCursor&&!anchor.returnForeground){result["cursor"]="disabled";result["foreground"]="disabled";}
        else try{
            // Display enumeration stays outside the UI callback. Recheck evidence after dispatch and immediately before each write.
            bool layoutCurrent=!anchor.returnCursor||anchor.layoutRevision==LayoutRevision();
            Rectangle area=anchor.returnCursor?SystemInformation.VirtualScreen:Rectangle.Empty;
            UI(()=>RestoreInputAnchor(anchor,result,layoutCurrent,area));
            ConfirmForegroundReturn(anchor,result);
        }catch(Exception error){result["returnReason"]=error.Message;}
        bool cursorOk=Str(result,"cursor")=="restored"||Str(result,"cursor")=="disabled";
        bool foregroundOk=Str(result,"foreground")=="restored"||Str(result,"foreground")=="disabled";
        result["state"]=Str(result,"cursor")=="yielded"||Str(result,"foreground")=="yielded"?"yielded":released&&cursorOk&&foregroundOk?"restored":"partial";
        return result;
    }
    static void Phase(string phase,Dictionary<string,object> request=null,Dictionary<string,object> source=null,object returned=null){
        try{
        presentationPhase=phase;presentationStopAction=null;
        if(request!=null&&phase=="operating")presentationStopAction=new{action="input.cancel",requestId=Str(request,"requestId"),controlSessionId=Str(request,"controlSessionId")};
        if(request!=null&&phase=="tracking")presentationStopAction=new{action="annotation.track.stop",trackingId=Str(request,"trackingId")};
        if(request!=null){presentationRequestId=Str(request,"requestId",Str(request,"id"));nativeBarMode=Str(request,"controlRenderer","native")!="qt";}
        if(source!=null){presentationRegion=Get(source,"bounds");string displayId=Str(source,"displayId");DesktopScreen selected=null;
            foreach(var item in DesktopScreen.AllScreens)if(item.DeviceName==displayId)selected=item;
            if(selected==null){long handle;bool hasWindow=Int64.TryParse(Str(source,"windowId"),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out handle);selected=DesktopScreen.FromHandle(hasWindow?new IntPtr(handle):GetForegroundWindow());}
            presentationDisplay=new{displayId=selected.DeviceName,nativeBounds=Bounds(selected.Bounds),workArea=Bounds(selected.WorkingArea)};
        }
        presentationReturnState=returned;Redraw();
        }catch(Exception error){try{Event("diagnostic",new{code="COMPUTER_PRESENTATION_FAILED",message=error.Message});}catch(IOException){}}
    }
    static object ExecuteInputBatch(Dictionary<string,object> request){
        string id=Str(request,"controlSessionId"),requestId=Str(request,"requestId");
        var results=new List<object>();var source=Obj(Get(request,"source"));var actions=Items(Get(request,"actions"));
        // Installed pre-batch clients keep focus across their individual action calls.
        bool legacyInput=actions.Count==0&&Get(request,"input")!=null;
        if(legacyInput)actions.Add(Get(request,"input"));
        var result=new Dictionary<string,object>{{"batchId",requestId},{"state","injected"},{"results",results},{"completedActions",0},{"injectedEvents",0u}};
        Frame captured=null;InputAnchor anchor=null;bool released=false;uint total=0;int completed=0;
        int segment=Math.Max(1,(int)Num(Obj(Get(RequestSettings(request),"input")),"nativeSegmentMs",16));
        lock(inputGate){
            try{
                lock(stateLock){inputWindow=IntPtr.Zero;CheckInput(id,requestId);activeInputRequest=requestId;activeInputSession=id;activePhysicalEpoch=Interlocked.Read(ref physicalInputEpoch);activeDeadlineUtcMs=(long)Num(request,"deadlineUtcMs");}
                source=ValidateSource(request,source);
                if(Get(source,"windowId")!=null){lock(stateLock){inputWindow=new IntPtr(Convert.ToInt64(Str(source,"windowId"),16));inputPid=Convert.ToUInt32(Get(source,"pid"));}}
                var control=Obj(Get(RequestSettings(request),"control"));
                anchor=new InputAnchor{batchId=requestId,sessionId=id,generation=Interlocked.Increment(ref batchGeneration),physicalEpoch=activePhysicalEpoch,mouseEpoch=Interlocked.Read(ref physicalMouseEpoch),cursor=Cursor.Position,foreground=GetForegroundWindow(),layoutRevision=LayoutRevision(),returnCursor=!legacyInput&&Bool(control,"returnCursor",true),returnForeground=!legacyInput&&Bool(control,"returnForeground",true),returnForegroundTimeoutMs=Num(control,"returnForegroundTimeoutMs",120)};
                anchor.pid=Pid(anchor.foreground);Phase("operating",request,source);
                if(actions.Count==0)throw new ArgumentException("Input actions must not be empty.");
                for(int index=0;index<actions.Count;index++){
                    CheckInput(id,requestId);
                    var item=ExecuteInputAction(Obj(actions[index]),source,id,requestId,segment);item["index"]=index;results.Add(item);total+=Convert.ToUInt32(Get(item,"injectedEvents",0));
                    if(Str(item,"state")!="injected"){result["state"]=Get(item,"state");result["reason"]=Get(item,"reason");break;}
                    completed++;lastActivity.Restart();
                }
                if(Str(result,"state")=="injected"){
                    CheckInput(id,requestId);ReleaseOwned();released=true;
                    if(Bool(request,"captureAfter")){
                        // Result capture uses the visible raw desktop rectangle. PrintWindow is never called while holding the user's cursor.
                        try{CheckInput(id,requestId);captured=Capture(request,null,true);CheckInput(id,requestId);}
                        catch(Exception error){if(captured!=null){captured.Dispose();captured=null;}result["capture"]=new{state="unavailable",reason=error.Message};CheckInput(id,requestId);}
                    }
                }
            }catch(OperationCanceledException error){result["state"]="cancelled";result["reason"]=error.Message;}
            catch(Exception error){result["state"]="failed";result["reason"]=error.Message;}
            finally{
                Phase("returning",request,source);
                try{if(!released){ReleaseOwned();released=true;}}catch(Exception error){result["releaseReason"]=error.Message;}
                var returned=ReturnInput(anchor,Str(result,"reason",Str(result,"state")),released);result["returnState"]=returned;
                if(Str(returned,"state")=="yielded"){result["state"]="yielded";result["reason"]="physical-input-takeover";}
                result["releaseState"]=released?"released":"uncertain";result["completedActions"]=completed;result["injectedEvents"]=total;
                if(Str(result,"state")!="injected"&&captured!=null){captured.Dispose();captured=null;}
                lock(stateLock){activeInputRequest=null;activeInputSession=null;inputWindow=IntPtr.Zero;activeDeadlineUtcMs=0;}
                Phase("returned",request,source,returned);
            }
        }
        // Encoding follows native return, outside inputGate. Input success survives encoding failure.
        if(captured!=null){try{result["capture"]=EncodeFrame(captured,request);}catch(Exception error){result["capture"]=new{state="unavailable",reason=error.Message};}}
        if(Bool(request,"captureAfter")&&!result.ContainsKey("capture"))result["capture"]=new{state="unavailable",reason="input-"+Str(result,"state")};
        return result;
    }
    static object Windows(Dictionary<string,object> request){
        var windows=new List<object>();int limit=(int)Num(request,"limit",100);if(limit<1||limit>200)throw new ArgumentException("Window limit must be 1..200.");string query=Str(request,"query");if(query.Length>256)throw new ArgumentException("Window query is too long.");bool truncated=false;
        EnumWindows((window,context)=>{if(!IsWindowVisible(window)||window==overlay.Handle||window==bar.Handle)return true;var title=new System.Text.StringBuilder(1024);GetWindowTextW(window,title,title.Capacity);if(title.Length==0||title.ToString().IndexOf(query,StringComparison.OrdinalIgnoreCase)<0)return true;if(windows.Count==limit){truncated=true;return false;}Rect rect;if(GetWindowRect(window,out rect))windows.Add(new{windowId=window.ToInt64().ToString("x"),pid=Pid(window),title=title.ToString(),minimized=IsIconic(window),bounds=Bounds(new Rectangle(rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top))});return true;},IntPtr.Zero);return new{windows=windows,truncated=truncated};
    }
    static double DisplayScale(DesktopScreen display){
        try{uint x,y;if(GetDpiForMonitor(MonitorFromPoint(new Point(display.Bounds.Left+1,display.Bounds.Top+1),2),0,out x,out y)==0)return x/96.0;}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}
        return 1;
    }
    static string LayoutRevision(){
        var entries=new List<string>();foreach(var display in DesktopScreen.AllScreens)entries.Add(display.DeviceName+":"+display.Bounds+":"+display.WorkingArea+":"+DisplayScale(display).ToString(System.Globalization.CultureInfo.InvariantCulture));entries.Sort(StringComparer.Ordinal);
        using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(String.Join("|",entries.ToArray())))).Replace("-","").ToLowerInvariant();
    }
    static object Displays(){
        var displays=new List<object>();foreach(var display in DesktopScreen.AllScreens)displays.Add(new{displayId=display.DeviceName,name=display.DeviceName,primary=display.Primary,nativeBounds=Bounds(display.Bounds),workArea=Bounds(display.WorkingArea),scale=DisplayScale(display)});
        return new{layoutRevision=LayoutRevision(),displays=displays,foregroundDisplayId=DesktopScreen.FromHandle(GetForegroundWindow()).DeviceName};
    }
    static bool CaptureValuesEqual(string key,object left,object right){
        if(key!="region")return Convert.ToString(left)==Convert.ToString(right);
        var a=Obj(left);var b=Obj(right);if(a.Count!=b.Count)return false;
        foreach(var pair in a)if(!b.ContainsKey(pair.Key)||Convert.ToString(pair.Value)!=Convert.ToString(b[pair.Key]))return false;
        return true;
    }
    static Dictionary<string,object> CaptureSpec(Dictionary<string,object> request){
        var result=new Dictionary<string,object>();
        foreach(var owner in new[]{Obj(Get(request,"source")),request,Obj(Get(request,"captureSpec"))})foreach(string key in new[]{"scope","displayId","region","windowId","pid","layoutRevision"}){
            object value;if(!owner.TryGetValue(key,out value))continue;if(value==null)throw new ArgumentException("Invalid capture field "+key+".");
            if(result.ContainsKey(key)&&!CaptureValuesEqual(key,result[key],value))throw new ArgumentException("Conflicting capture field "+key+".");result[key]=value;
        }
        if(!result.ContainsKey("scope"))result["scope"]=result.ContainsKey("windowId")?"window":"virtual";
        string scope=Str(result,"scope");if(scope!="display"&&scope!="region"&&scope!="window"&&scope!="virtual")throw new ArgumentException("Invalid capture field scope.");
        if(scope!="region"&&result.ContainsKey("region"))throw new ArgumentException("Capture region requires region scope.");
        if(scope!="window"&&(result.ContainsKey("windowId")||result.ContainsKey("pid")))throw new ArgumentException("Capture windowId/pid require window scope.");
        if(scope!="display"&&scope!="region"&&result.ContainsKey("displayId"))throw new ArgumentException("Capture displayId requires display or region scope.");
        return result;
    }
    static Rectangle ResolveCaptureArea(Dictionary<string,object> spec,out IntPtr target,out uint expected){
        target=IntPtr.Zero;expected=0;string scope=Str(spec,"scope"),revision=Str(spec,"layoutRevision");
        if(revision!=""&&revision!=LayoutRevision())throw new InvalidOperationException("Display layout changed; query displays.list and observe again.");
        if(scope=="window"){
            if(Str(spec,"windowId")==""||Get(spec,"pid")==null)throw new ArgumentException("Window capture needs windowId and pid.");
            target=new IntPtr(Convert.ToInt64(Str(spec,"windowId"),16));expected=Convert.ToUInt32(Get(spec,"pid"));Rect rect;
            if(!IsWindow(target)||Pid(target)!=expected||IsIconic(target)||!GetWindowRect(target,out rect))throw new InvalidOperationException("Window changed or is minimized; query its current identity.");
            return new Rectangle(rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top);
        }
        if(scope=="virtual")return SystemInformation.VirtualScreen;
        DesktopScreen selected=null;foreach(var display in DesktopScreen.AllScreens)if(display.DeviceName==Str(spec,"displayId"))selected=display;
        if(selected==null)throw new ArgumentException("Capture displayId is absent from the current layout.");
        if(scope=="display")return selected.Bounds;
        var region=Obj(Get(spec,"region"));foreach(string field in region.Keys)if(field!="x"&&field!="y"&&field!="width"&&field!="height")throw new ArgumentException("Unknown capture region field "+field+".");foreach(string key in new[]{"x","y","width","height"})if(!region.ContainsKey(key)||Num(region,key)!=Math.Truncate(Num(region,key)))throw new ArgumentException("Region "+key+" must be a native-pixel integer.");
        double x=Num(region,"x"),y=Num(region,"y"),width=Num(region,"width"),height=Num(region,"height");
        if(x<0||y<0||width<1||height<1||x+width>selected.Bounds.Width||y+height>selected.Bounds.Height)throw new ArgumentException("Region must fit within displayId nativeBounds.");
        return new Rectangle(selected.Bounds.Left+(int)x,selected.Bounds.Top+(int)y,(int)width,(int)height);
    }
    static string SourceKey(Dictionary<string,object> source){
        var spec=CaptureSpec(new Dictionary<string,object>{{"source",source}});var region=Obj(Get(spec,"region"));
        return Str(spec,"scope")+":"+Str(spec,"displayId")+":"+Str(spec,"windowId")+":"+Str(spec,"pid")+":"+Str(spec,"layoutRevision")+":"+Num(region,"x")+","+Num(region,"y")+","+Num(region,"width")+","+Num(region,"height");
    }
    static Frame Capture(Dictionary<string,object> request,Bitmap reusable=null,bool visibleOnly=false){
        var spec=CaptureSpec(request);var supplied=Obj(Get(request,"source"));IntPtr target;uint expected;
        Rectangle bounds=ResolveCaptureArea(spec,out target,out expected);string layoutRevision=LayoutRevision();
        if(bounds.Width<1||bounds.Height<1||(long)bounds.Width*bounds.Height>33554432)throw new InvalidOperationException("Raw capture exceeds 32 megapixels; select a display or smaller region.");
        Bitmap bitmap=reusable!=null&&reusable.Width==bounds.Width&&reusable.Height==bounds.Height?reusable:new Bitmap(bounds.Width,bounds.Height,PixelFormat.Format32bppArgb);
        try{using(var graphics=Graphics.FromImage(bitmap)){if(target==IntPtr.Zero||visibleOnly)graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size);else{var dc=graphics.GetHdc();try{if(!PrintWindow(target,dc,2))throw new InvalidOperationException("This window does not support capture.");}finally{graphics.ReleaseHdc(dc);}}}
            if(target!=IntPtr.Zero&&(!IsWindow(target)||Pid(target)!=expected))throw new InvalidOperationException("Window identity changed during capture.");
            if(layoutRevision!=LayoutRevision())throw new InvalidOperationException("Display layout changed during capture; query displays.list again.");
            var result=new Frame{id=Guid.NewGuid().ToString(),bitmap=bitmap,bounds=bounds,created=DateTime.UtcNow,source=new Dictionary<string,object>(spec)};
            result.source["kind"]=target==IntPtr.Zero?"desktop":"window";result.source["coordinateSpace"]="capture";result.source["coordinateVariant"]="raw";result.source["bounds"]=Bounds(bounds);result.source["rawBounds"]=Bounds(bounds);result.source["layoutRevision"]=layoutRevision;
            result.source["instanceId"]=Get(supplied,"instanceId",Get(request,"instanceId"));result.source["frameId"]=result.id;result.source["capturedAt"]=result.created.ToString("o");result.source["width"]=bitmap.Width;result.source["height"]=bitmap.Height;
            if(visibleOnly)result.source["captureMethod"]="visible-desktop";return result;
        }catch{bitmap.Dispose();throw;}
    }
    static byte[] Pixels(Bitmap bitmap,byte[] reusable=null){var area=new Rectangle(0,0,bitmap.Width,bitmap.Height);var bits=bitmap.LockBits(area,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{var bytes=reusable!=null&&reusable.Length==bitmap.Width*bitmap.Height*4?reusable:new byte[bitmap.Width*bitmap.Height*4];for(int y=0;y<bitmap.Height;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),bytes,y*bitmap.Width*4,bitmap.Width*4);return bytes;}finally{bitmap.UnlockBits(bits);}}
    static void ApplyObservationRequestSettings(Dictionary<string,object> request){
        var selected=RequestSettings(request);lock(stateLock)settings=MergeSettings(settings,SelectSettingsDomains(selected,"presentation"));
    }
    static object Screen(Dictionary<string,object> request){
        ApplyObservationRequestSettings(request);Phase("capturing",request);
        try{var frame=Capture(request);var result=EncodeFrame(frame,request);Phase("prepared",request,frame.source);return result;}
        catch{Phase("failed",request);throw;}
    }
    static object EncodeFrame(Frame frame,Dictionary<string,object> request){
        bool cached=false;
        try{
            bool explicitScope=Get(request,"scope")!=null||Get(Obj(Get(request,"captureSpec")),"scope")!=null||Get(Obj(Get(request,"source")),"scope")!=null;
            int maximum=(int)Num(request,"maxWidth",explicitScope?frame.bitmap.Width:Math.Min(1920,frame.bitmap.Width));if(maximum<1||maximum>3840&&request.ContainsKey("maxWidth"))throw new ArgumentException("maxWidth must be 1..3840.");
            int width=Math.Min(maximum,frame.bitmap.Width),height=Math.Max(1,(int)((long)frame.bitmap.Height*width/frame.bitmap.Width));
            using(var output=new Bitmap(frame.bitmap,new Size(width,height)))using(var bytes=new MemoryStream()){
                output.Save(bytes,ImageFormat.Png);if(bytes.Length>8388608)throw new InvalidOperationException("Screenshot PNG exceeds 8 MiB; select maxWidth or a smaller display region.");
                var source=new Dictionary<string,object>(frame.source);source["width"]=width;source["height"]=height;
                string imageItemId=Guid.NewGuid().ToString();source["imageItemId"]=imageItemId;source["coordinateVariant"]="image";frame.imageItems[imageItemId]=new Size(width,height);
                lock(frameLock){frames.Add(frame.id,frame);frameOrder.Add(frame.id);EvictFrames(RequestSettings(request));cached=frames.ContainsKey(frame.id);}
                if(!cached)throw new InvalidOperationException("Raw frame exceeds the configured frame cache budget; select a smaller region or increase the saved cache budget.");
                return new{mimeType="image/png",width=width,height=height,bounds=Bounds(frame.bounds),rawBounds=Bounds(frame.bounds),layoutRevision=Get(source,"layoutRevision"),capturedAt=frame.created.ToString("o"),frameId=frame.id,imageItemId=imageItemId,source=source,
                    transform=new{viewport=new{x=0,y=0,width=frame.bitmap.Width,height=frame.bitmap.Height},scaleX=(double)width/frame.bitmap.Width,scaleY=(double)height/frame.bitmap.Height},data=Convert.ToBase64String(bytes.ToArray())};
            }
        }finally{if(!cached)frame.Dispose();}
    }
    static void EvictFrames(Dictionary<string,object> snapshot=null){var config=Obj(Get(Obj(Get(snapshot??settings,"annotation")),"tracking"));int count=(int)Num(config,"frameCacheFrames",6);double bytes=Num(config,"frameCacheBytes",134217728),age=Num(config,"frameCacheAgeMs",30000);long total=0;foreach(var item in frames.Values)total+=(long)item.bitmap.Width*item.bitmap.Height*4;while(frameOrder.Count>0){var frame=frames[frameOrder[0]];if(frameOrder.Count<=count&&total<=bytes&&(DateTime.UtcNow-frame.created).TotalMilliseconds<=age)break;total-=(long)frame.bitmap.Width*frame.bitmap.Height*4;frames.Remove(frame.id);frameOrder.RemoveAt(0);frame.Dispose();}}
    class CaptureBuffer:IDisposable {
        public Frame frame;public byte[] pixels;public object prepared;public double captureMs,preprocessMs;
        public void Read(Dictionary<string,object> request,Type engineType){
            if(frame!=null)lock(frameLock){frames.Remove(frame.id);frameOrder.Remove(frame.id);}
            var watch=Stopwatch.StartNew();var previous=frame;frame=Capture(new Dictionary<string,object>{{"source",Get(request,"source")}},previous==null?null:previous.bitmap);
            if(previous!=null&&!Object.ReferenceEquals(previous.bitmap,frame.bitmap))previous.bitmap.Dispose();
            captureMs=watch.Elapsed.TotalMilliseconds;watch.Restart();frame.shared=true;pixels=Pixels(frame.bitmap,pixels);
            if(prepared==null)prepared=engineType.GetMethod("Prepare").Invoke(null,new object[]{pixels,frame.bitmap.Width,frame.bitmap.Height});
            else prepared.GetType().GetMethod("Reset").Invoke(prepared,new object[]{pixels,frame.bitmap.Width,frame.bitmap.Height});
            preprocessMs=watch.Elapsed.TotalMilliseconds;lock(frameLock){frames[frame.id]=frame;frameOrder.Add(frame.id);EvictFrames();}
        }
        public void Dispose(){if(frame!=null){lock(frameLock){frames.Remove(frame.id);frameOrder.Remove(frame.id);}frame.bitmap.Dispose();frame=null;}if(prepared!=null){((IDisposable)prepared).Dispose();prepared=null;}pixels=null;}
    }
    static object Annotation(Dictionary<string,object> request){
        string action=Str(request,"action"),id=Str(request,"layerId");int version=(int)Num(request,"version",1),retired;retiredLayers.TryGetValue(id,out retired);
        if(action=="annotation.clear"){
            retiredLayers[id]=Math.Max(retired,version);Dictionary<string,object> current;if(layers.TryGetValue(id,out current)&&(int)Num(current,"version",1)<=version)layers.Remove(id);
            List<Tracking> ended=new List<Tracking>();lock(tracking)foreach(var job in tracking.Values)if(job.layerId==id&&job.version<=version){job.stopped=true;job.stopReason="layer-cleared";ended.Add(job);}
            foreach(var job in ended)FinalizeTracking(job);
            Event("annotation-ended",new{layerId=id,version=version,reason=Str(request,"reason","cleared")});
            Redraw();return new{state="cleared",layerId=id,version=version};
        }
        if(retired>=version)return new{state="cleared",layerId=id,version=retired};
        if(!Bool(settings,"enabled",true)||!Bool(Obj(Get(settings,"features")),"annotation",true))throw new InvalidOperationException("Screen annotation was disabled before drawing.");
        request["source"]=ValidateSource(request,Obj(Get(request,"source")));
        Dictionary<string,object> previous;if(layers.TryGetValue(id,out previous)&&(int)Num(previous,"version",1)>version)return new{state="stale",layerId=id,version=Num(previous,"version")};
        object duration=Get(request,"durationMs");if(duration!=null)request["expiresMono"]=Stopwatch.GetTimestamp()+Convert.ToDouble(duration)*Stopwatch.Frequency/1000;
        layers[id]=request;overlay.Invalidate();PublishPresentation();return new{state=externalQt||IsWindowVisible(overlay.Handle)?"visible":"unavailable",layerId=id,version=version,renderRevision=presentationRevision};
    }
    static object StartTracking(Dictionary<string,object> request){
        var selectedSettings=RequestSettings(request);
        string id=Str(request,"trackingId"),layerId=Str(request,"layerId");var source=ValidateSource(request,Obj(Get(request,"source")));
        string frameId=Str(source,"frameId");int proposed=Items(Get(request,"targets")).Count;
        var item=new Tracking{id=id,layerId=layerId,version=(int)Num(request,"version",1),targetCount=proposed,sourceKey=SourceKey(source),request=request,
            status=new Dictionary<string,object>{{"trackingId",id},{"layerId",layerId},{"state","initializing"}},rate=Num(request,"rateHz",10)};
        if(Get(request,"expiresAt")!=null)item.expires=DateTime.Parse(Str(request,"expiresAt")).ToUniversalTime();
        bool admitted=false,paused=false;
        UI(()=>{
            int retired;retiredLayers.TryGetValue(layerId,out retired);
            if(retired>=item.version||!Bool(selectedSettings,"enabled",true)||!Bool(Obj(Get(selectedSettings,"features")),"annotation",true)||!Bool(Obj(Get(selectedSettings,"features")),"observation",true)||!Bool(Obj(Get(selectedSettings,"annotation")),"dynamicEnabled"))return;
            lock(tracking){int active=0;foreach(var job in tracking.Values)if(!job.stopped)active+=job.targetCount;
                int maximum=(int)Num(Obj(Get(selectedSettings,"performance")),"maxTargets",8);paused=active+proposed>maximum;
                if(paused){var kept=new List<object>();foreach(var target in Items(Get(request,"targets"))){var value=new Dictionary<string,object>(Obj(target));value["state"]="paused";kept.Add(value);}
                    item.stopped=true;item.finalized=true;item.status=new Dictionary<string,object>{{"trackingId",id},{"layerId",layerId},{"state","paused"},{"stopped",true},{"targets",kept},{"objects",new object[0]},{"source",source},{"effective",new{reason="computer-target-budget",maxTargets=maximum,totalTargets=active+proposed}}};
                }else item.inFlight=true;
                tracking.Add(id,item);
            }
            layers[layerId]=new Dictionary<string,object>{{"layerId",layerId},{"version",item.version},{"trackingId",id},{"source",source},{"objects",new object[0]}};admitted=true;
            if(paused)FreezeLayer(item);
        });
        if(!admitted)return new{trackingId=id,layerId=layerId,state="stopped"};if(paused)return item.status;Phase("tracking",request,source);
        try{
            byte[] oldPixels;Dictionary<string,object> oldSource;int width,height;
            lock(frameLock){EvictFrames(selectedSettings);Frame original;if(!frames.TryGetValue(frameId,out original))throw new InvalidOperationException("Source frame expired; obtain a fresh screen.capture before tracking.");oldPixels=Pixels(original.bitmap);oldSource=TrackingCoordinateSource(source,original.source);width=original.bitmap.Width;height=original.bitmap.Height;}
            if(item.stopped)throw new OperationCanceledException("The original tracking source ended before initialization.");
            string assemblyPath=Path.Combine(NativeDirectory,"RabiAgent.Computer.Tracking.dll");if(!File.Exists(assemblyPath))throw new InvalidOperationException("The CPU KCF/template tracking component is missing from this package.");
            var type=Assembly.LoadFrom(assemblyPath).GetType("RabiComputerTracking.Engine",true);item.engine=Activator.CreateInstance(type);item.step=type.GetMethod("Step");
            using(var current=Capture(new Dictionary<string,object>{{"source",source}})){
                item.status=Obj(type.GetMethod("Start").Invoke(item.engine,new object[]{request,oldPixels,width,height,oldSource,Pixels(current.bitmap),current.bitmap.Width,current.bitmap.Height,current.source}));
            }
            item.inFlight=false;
            UI(()=>{
                int retired;retiredLayers.TryGetValue(layerId,out retired);if(item.stopped||retired>=item.version){item.stopped=true;item.stopReason="layer-cleared";return;}
                ApplyTrackingBudget(selectedSettings);
                item.initialized=true;
                layers[layerId]=new Dictionary<string,object>{{"layerId",layerId},{"version",item.version},{"trackingId",id},{"source",Get(item.status,"source",source)},{"objects",Get(item.status,"objects",new object[0])}};
                lock(tracking){if(trackingWorker==null||!trackingWorker.IsAlive){trackingWorker=new Thread(TrackLoop);trackingWorker.IsBackground=true;trackingWorker.Start();}}
                trackingWake.Set();Redraw();
            });
            if(!item.initialized){FinalizeTracking(item);return new{trackingId=id,layerId=layerId,state="stopped"};}
            return item.status;
        }catch{item.stopped=true;item.stopReason="initialization-failed";item.inFlight=false;UI(()=>Annotation(new Dictionary<string,object>{{"action","annotation.clear"},{"layerId",layerId},{"version",item.version},{"reason","initialization-failed"}}));FinalizeTracking(item);throw;}
    }
    static void FinalizeTracking(Tracking item){
        lock(tracking){if(!item.stopped||item.inFlight||item.finalized)return;item.finalized=true;}
        if(item.engine!=null)lock(item.engine){var disposable=item.engine as IDisposable;if(disposable!=null)disposable.Dispose();}
        var status=new Dictionary<string,object>(item.status);status["trackingId"]=item.id;status["stopped"]=true;
        status["state"]=item.stopReason=="source-unavailable"||item.stopReason=="source-changed"?"lost":Str(status,"state")=="paused"?"paused":"stopped";
        status["reason"]=item.stopReason;item.status=status;Event("tracking",status);
    }
    static void FreezeLayer(Tracking item){
        Dictionary<string,object> layer;int retired;retiredLayers.TryGetValue(item.layerId,out retired);
        if(retired>=item.version||!layers.TryGetValue(item.layerId,out layer)||(int)Num(layer,"version",1)!=item.version)return;
        object duration=Get(Obj(Get(RequestSettings(item.request),"annotation")),"staticDurationMs",10000);
        string expires=duration==null?null:DateTime.UtcNow.AddMilliseconds(Convert.ToDouble(duration)).ToString("o");
        if(duration!=null)layer["expiresMono"]=Stopwatch.GetTimestamp()+Convert.ToDouble(duration)*Stopwatch.Frequency/1000;
        layer["expiresAt"]=expires;layer["trackingState"]="stopped";
        var objects=Items(Get(layer,"objects"));objects.RemoveAll(value=>Str(Obj(value),"id")=="rabi-tracking-stopped");
        if(objects.Count>0){var bounds=Obj(Get(Obj(objects[0]),"bounds"));objects.Add(new Dictionary<string,object>{{"id","rabi-tracking-stopped"},{"type","text"},{"text","已停止跟踪"},{"bounds",new Dictionary<string,object>{{"x",Num(bounds,"x")},{"y",Math.Max(16,Num(bounds,"y")-18)},{"width",160},{"height",18}}},{"style",new Dictionary<string,object>{{"fontSize",12}}}});}
        layer["objects"]=objects;
        Event("annotation-static",new{layerId=item.layerId,version=item.version,source=Get(layer,"source"),objects=objects,expiresAt=expires,trackingId=item.id,trackingState="stopped"});Redraw();
    }
    static object StopTracking(Tracking item,bool clear,string reason){
        bool wasStopped;lock(tracking){wasStopped=item.stopped;item.stopped=true;item.stopReason=reason;}
        UI(()=>{if(clear)Annotation(new Dictionary<string,object>{{"action","annotation.clear"},{"layerId",item.layerId},{"version",item.version},{"reason",reason}});else if(!wasStopped)FreezeLayer(item);});
        trackingWake.Set();FinalizeTracking(item);
        Dictionary<string,object> layer=null;UI(()=>layers.TryGetValue(item.layerId,out layer));
        return new{trackingId=item.id,state=item.inFlight?"stopping":"stopped",expiresAt=Get(layer,"expiresAt")};
    }
    static void UpdateWindowLayers(){
        var geometry=new Dictionary<string,object>();
        foreach(string id in new List<string>(layers.Keys)){
            Dictionary<string,object> layer;if(!layers.TryGetValue(id,out layer))continue;var source=Obj(Get(layer,"source"));if(Str(source,"kind")!="window")continue;
            string key=Str(source,"windowId")+":"+Str(source,"pid");object found;
            if(!geometry.TryGetValue(key,out found)){
                IntPtr window=new IntPtr(Convert.ToInt64(Str(source,"windowId"),16));Rect rect;
                found=IsWindow(window)&&Pid(window)==Convert.ToUInt32(Get(source,"pid"))&&GetWindowRect(window,out rect)?Bounds(new Rectangle(rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top)):null;geometry[key]=found;
            }
            if(found==null){Annotation(new Dictionary<string,object>{{"action","annotation.clear"},{"layerId",id},{"version",Num(layer,"version",1)},{"reason","source-unavailable"}});continue;}
            var current=Obj(found);var before=Obj(Get(source,"bounds"));
            if(Num(current,"x")!=Num(before,"x")||Num(current,"y")!=Num(before,"y")||Num(current,"width")!=Num(before,"width")||Num(current,"height")!=Num(before,"height")){
                if(Get(layer,"trackingId")!=null&&(Num(current,"width")!=Num(before,"width")||Num(current,"height")!=Num(before,"height"))){Tracking job;lock(tracking)tracking.TryGetValue(Str(layer,"trackingId"),out job);if(job!=null){StopTracking(job,true,"source-changed");continue;}}
                var next=new Dictionary<string,object>(source);next["bounds"]=current;layer["source"]=next;
                Event("annotation-source",new{layerId=id,version=Num(layer,"version",1),source=next});Redraw();
            }
        }
    }
    static void ApplyComputerBudgets(double cycleMs){
        List<Tracking> active;lock(tracking){active=new List<Tracking>(tracking.Values);active.RemoveAll(item=>item.stopped||!item.initialized);}
        var performance=Obj(Get(settings,"performance"));int maximum=(int)Num(performance,"maxTargets",8);int total=0;foreach(var item in active)total+=item.targetCount;
        active.Sort((a,b)=>b.created.CompareTo(a.created));
        foreach(var item in active){if(total<=maximum)break;item.status["state"]="paused";item.status["effective"]=new{reason="computer-target-budget",maxTargets=maximum,totalTargets=total};StopTracking(item,false,"computer-target-budget");total-=item.targetCount;}
        active.RemoveAll(item=>item.stopped||!item.initialized);if(active.Count==0)return;
        long now=Stopwatch.GetTimestamp();if(memorySampleAt==0||now-memorySampleAt>=Stopwatch.Frequency){using(var process=Process.GetCurrentProcess())sampledNativePrivateBytes=process.PrivateMemorySize64;memorySampleAt=now;memorySampleUtc=DateTime.UtcNow;}
        bool memory=sampledNativePrivateBytes>Num(performance,"memoryBudgetBytes",536870912),compute=cycleMs>Num(performance,"computeBudgetMs",20);
        foreach(var item in active)item.status["computerBudget"]=new{scope="native-helper-process",totalTargets=total,cycleMs=cycleMs,nativePrivateBytes=sampledNativePrivateBytes,memorySampledAt=memorySampleUtc.ToString("o")};
        if(!memory&&!compute){budgetOverruns=0;return;}if(++budgetOverruns<3)return;budgetOverruns=0;
        active.Sort((a,b)=>b.lastCostMs.CompareTo(a.lastCostMs));var selected=active[0];
        Dictionary<string,object> adjustment;lock(selected.engine)adjustment=Obj(selected.engine.GetType().GetMethod("ApplyBudget").Invoke(selected.engine,new object[]{memory?"computer-memory-budget":"computer-compute-budget"}));
        selected.status["state"]=Get(adjustment,"state");selected.status["effective"]=Get(adjustment,"effective");selected.rate=Num(Obj(Get(adjustment,"effective")),"rateHz",selected.rate);
        Event("tracking",selected.status);if(Str(adjustment,"state")=="paused")StopTracking(selected,false,memory?"computer-memory-budget":"computer-compute-budget");
    }
    static void TrackLoop(){
        var clock=Stopwatch.StartNew();var buffers=new Dictionary<string,CaptureBuffer>();
        try{for(;;){List<Tracking> jobs;lock(tracking){jobs=new List<Tracking>(tracking.Values);jobs.RemoveAll(x=>x.stopped||!x.initialized);if(jobs.Count==0){trackingWorker=null;return;}}
            var wanted=new HashSet<string>();foreach(var item in jobs)wanted.Add(item.sourceKey);foreach(string key in new List<string>(buffers.Keys))if(!wanted.Contains(key)){buffers[key].Dispose();buffers.Remove(key);}
            var grouped=new Dictionary<string,List<Tracking>>();long wait=100;
            foreach(var item in jobs){if(item.expires.HasValue&&DateTime.UtcNow>=item.expires.Value){StopTracking(item,false,"expired");continue;}if(item.pendingSettings!=null)item.due=0;if(item.due>clock.ElapsedMilliseconds){wait=Math.Min(wait,item.due-clock.ElapsedMilliseconds);continue;}if(!grouped.ContainsKey(item.sourceKey))grouped[item.sourceKey]=new List<Tracking>();grouped[item.sourceKey].Add(item);}
            var cycle=Stopwatch.StartNew();
            foreach(var planned in grouped.Values){var group=new List<Tracking>();lock(tracking)foreach(var item in planned)if(!item.stopped){item.inFlight=true;group.Add(item);}if(group.Count==0)continue;
                try{
                    CaptureBuffer buffer;if(!buffers.TryGetValue(group[0].sourceKey,out buffer)){buffer=new CaptureBuffer();buffers.Add(group[0].sourceKey,buffer);}
                    var elapsed=Stopwatch.StartNew();buffer.Read(group[0].request,group[0].engine.GetType());double captureMs=buffer.captureMs;var current=buffer.frame;var prepared=buffer.prepared;
                    foreach(var item in group){if(item.stopped)continue;Dictionary<string,object> result;
                        lock(item.engine){if(item.stopped)continue;var pending=Interlocked.Exchange(ref item.pendingSettings,null);if(pending!=null){item.engine.GetType().GetMethod("Configure").Invoke(item.engine,new object[]{pending});}var cost=Stopwatch.StartNew();result=Obj(item.step.Invoke(item.engine,new object[]{prepared,current.source,captureMs}));item.lastCostMs=cost.Elapsed.TotalMilliseconds+captureMs/group.Count;}
                        Obj(Get(result,"metrics"))["preprocessMs"]=buffer.preprocessMs;item.status=result;item.rate=Num(Obj(Get(result,"effective")),"rateHz",item.rate);item.due=clock.ElapsedMilliseconds+(long)(1000/Math.Max(.001,item.rate));
                        if(Str(Obj(Get(result,"effective")),"reason")=="source-dimensions-changed"){StopTracking(item,true,"source-changed");continue;}
                        UI(()=>{if(item.stopped)return;int retired;retiredLayers.TryGetValue(item.layerId,out retired);if(retired>=item.version)return;layers[item.layerId]=new Dictionary<string,object>{{"layerId",item.layerId},{"version",item.version},{"trackingId",item.id},{"source",Get(result,"source",Get(item.request,"source"))},{"objects",Get(result,"objects",new object[0])}};overlay.Invalidate();PublishPresentation();});Event("tracking",result);
                        if(Str(result,"state")=="paused")StopTracking(item,false,"budget-paused");
                    }
                }catch(Exception error){foreach(var item in group){item.status=new Dictionary<string,object>{{"trackingId",item.id},{"state","lost"},{"reason",error.GetBaseException().Message}};StopTracking(item,true,"source-unavailable");}}
                finally{foreach(var item in group){item.inFlight=false;FinalizeTracking(item);}}
            }
            if(grouped.Count>0)ApplyComputerBudgets(cycle.Elapsed.TotalMilliseconds);
            trackingWake.WaitOne((int)Math.Max(1,Math.Min(wait,100)));
        }}finally{foreach(var buffer in buffers.Values)buffer.Dispose();}
    }
    static object Dispatch(Dictionary<string,object> request){
        string action=Str(request,"action");if(Str(request,"renderer")=="qt")externalQt=true;

        if(action=="displays.list")return Displays();
        if(action=="windows.list")return Windows(request);
        if(action=="screen.capture")return Screen(request);
        if(action=="input.execute")return ExecuteInputBatch(request);
        if(action=="input.cancel"){MarkInputCancelled(request);lock(inputGate)return new{state="cancelled",releaseState="released",workState="settled"};}
        if(action=="control.activity"){if(session==Str(request,"controlSessionId"))lastActivity.Restart();return new{state=session==null?"absent":"active"};}
        if(action=="control.end"){EndControl(Str(request,"controlSessionId"),Str(request,"reason","requested"));lock(inputGate)return new{state="ended",releaseState="released",workState="settled"};}
        if(action=="control.begin"){
            object result=null;UI(()=>{lock(stateLock){if(endingControlSessions.Contains(Str(request,"controlSessionId"))){result=new{state="ended",visible=false,reason="ended-before-native-enter"};return;}}
                ApplyControlRequestSettings(request);
                if(!Bool(settings,"enabled",true)||!Bool(Obj(Get(settings,"features")),"input",true))throw new InvalidOperationException("Native input was disabled before control began.");session=Str(request,"controlSessionId");presentationPhase="ready";presentationRequestId=Str(request,"requestId",session);nativeBarMode=Str(request,"controlRenderer","native")!="qt";initialPhysicalKeys.Clear();for(uint key=1;key<256;key++)if(GetAsyncKeyState((int)key)<0)initialPhysicalKeys.Add(key);lastActivity.Restart();bar.Source=Obj(Get(request,"source"));externalQt=Str(request,"renderer")=="qt";RegisterExit(Str(Obj(Get(settings,"control")),"exitShortcut","Ctrl+Alt+Esc"));if(Str(request,"controlRenderer")!="qt"){bar.Show();ShowWindow(bar.Handle,4);}PublishPresentation();result=new{state="active",visible=Str(request,"controlRenderer")=="qt"||IsWindowVisible(bar.Handle),pointer=showPointer,hotkey=new{registered=hotkeyRegistered,error=hotkeyError},renderRevision=externalQt?presentationRevision:0};});return result;
        }
        if(action=="settings.patch"){UI(()=>ApplySettingsPatch(Obj(Get(request,"patch"))));return new{state="applied"};}
        if(action=="settings.update"){UI(()=>ApplySettings(Obj(Get(request,"settings"))));return new{state="applied"};}
        if(action=="annotation.track.start")return StartTracking(request);
        if(action=="annotation.track.status"){lock(tracking){Tracking item;return tracking.TryGetValue(Str(request,"trackingId"),out item)?item.status:new Dictionary<string,object>{{"state","absent"}};}}
        if(action=="annotation.track.stop"){Tracking item;lock(tracking)tracking.TryGetValue(Str(request,"trackingId"),out item);return item==null?(object)new{state="absent"}:StopTracking(item,Bool(request,"clear"),"requested");}
        if(action.StartsWith("annotation.")){object result=null;UI(()=>result=Annotation(request));return result;}
        if(Str(request,"renderer")=="qt")externalQt=true;
        if(action=="capabilities"){bool inJob;IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inJob);return new{protocolVersion=2,settingsPatchVersion=1,captureSpecVersion=1,inputBatchVersion=1,imageViewVersion=1,inheritedJob=inJob,features=new[]{"input","annotation","tracking"},trackingAvailable=File.Exists(Path.Combine(NativeDirectory,"RabiAgent.Computer.Tracking.dll"))};}
        throw new ArgumentException("Unsupported desktop operation.");
    }
    static void Handle(Dictionary<string,object> request){try{Emit(new{id=Get(request,"id"),result=Dispatch(request)});}catch(Exception error){var cause=error.GetBaseException();bool uncertain=false;lock(stateLock)uncertain=Str(request,"action")=="input.execute"&&(ownedKeys.Count>0||ownedButtons.Count>0||ownedUnicode.Count>0);Emit(new{id=Get(request,"id"),error=new{code="COMPUTER_NATIVE_FAILED",message=cause.Message,uncertain=uncertain}});}finally{if(Str(request,"action")=="input.execute")lock(stateLock){string id=Str(request,"requestId");int count;if(pendingInputCounts.TryGetValue(id,out count)){if(count<=1){pendingInputCounts.Remove(id);pendingInputSessions.Remove(id);cancelledRequests.Remove(id);}else pendingInputCounts[id]=count-1;}}if(Str(request,"action")=="control.begin")lock(stateLock){string id=Str(request,"controlSessionId");int count;if(pendingControlBegins.TryGetValue(id,out count)){if(count<=1){pendingControlBegins.Remove(id);endingControlSessions.Remove(id);}else pendingControlBegins[id]=count-1;}}}}
    static void MarkInputCancelled(Dictionary<string,object> request){lock(stateLock){string original=Str(request,"requestId"),owner=Str(request,"controlSessionId"),pending;bool queued=pendingInputSessions.TryGetValue(original,out pending)&&pending==owner;
        if(queued||activeInputRequest==original&&activeInputSession==owner)cancelledRequests.Add(original);
        if(activeInputRequest==original&&activeInputSession==owner)ReleaseOwned();
    }}
    static void ReserveControlBegin(Dictionary<string,object> request){lock(stateLock){string id=Str(request,"controlSessionId");int count;pendingControlBegins.TryGetValue(id,out count);pendingControlBegins[id]=count+1;}}
    static void MarkControlEnded(Dictionary<string,object> request){string id=Str(request,"controlSessionId");lock(stateLock){if(pendingControlBegins.ContainsKey(id)||session==id)endingControlSessions.Add(id);}EndControl(id,Str(request,"reason","requested"),false);}
    public static void Run(){
        SetProcessDpiAwarenessContext((IntPtr)(-4));var ready=new ManualResetEvent(false);
        var gui=new Thread(()=>{Application.EnableVisualStyles();overlay=new Overlay();bar=new ControlBar();var ignored=overlay.Handle;ignored=bar.Handle;ui=new WindowsFormsSynchronizationContext();overlay.Show();ShowWindow(overlay.Handle,4);
            keyboardHook=(code,message,data)=>{if(code>=0){var value=(KeyHookData)Marshal.PtrToStructure(data,typeof(KeyHookData));if((value.flags&0x10)==0&&value.extra!=injectionMarker){Interlocked.Increment(ref physicalInputEpoch);if(session==null)return CallNextHookEx(keyboardHandle,code,message,data);if((value.flags&0x80)!=0){initialPhysicalKeys.Remove(value.key);physicalExitPending=false;}else if(initialPhysicalKeys.Contains(value.key))return CallNextHookEx(keyboardHandle,code,message,data);if(value.key==exitKey&&(message.ToInt32()==0x100||message.ToInt32()==0x104))physicalExitPending=true;if(exitOnLocal)EndControl(session,"local-input");}}return CallNextHookEx(keyboardHandle,code,message,data);};
            mouseHook=(code,message,data)=>{if(code>=0){var value=(MouseHookData)Marshal.PtrToStructure(data,typeof(MouseHookData));if((value.flags&1)==0&&value.extra!=injectionMarker){bool moved=lastPhysicalX==int.MinValue||value.x!=lastPhysicalX||value.y!=lastPhysicalY;lastPhysicalX=value.x;lastPhysicalY=value.y;if(moved||message.ToInt32()!=0x200){Interlocked.Increment(ref physicalInputEpoch);Interlocked.Increment(ref physicalMouseEpoch);if(session!=null&&exitOnLocal)EndControl(session,"local-input");}}}return CallNextHookEx(mouseHandle,code,message,data);};
            keyboardHandle=SetWindowsHookExW(13,keyboardHook,GetModuleHandleW(null),0);mouseHandle=SetWindowsHookExW(14,mouseHook,GetModuleHandleW(null),0);
            var timer=new System.Windows.Forms.Timer();timer.Interval=100;timer.Tick+=(sender,args)=>{
                UpdateWindowLayers();
                foreach(string layerId in new List<string>(layers.Keys)){var layer=layers[layerId];if(Get(layer,"expiresMono")!=null&&Convert.ToDouble(Get(layer,"expiresMono"))<=Stopwatch.GetTimestamp())Annotation(new Dictionary<string,object>{{"action","annotation.clear"},{"layerId",layerId},{"version",Num(layer,"version",1)}});}
                if(session!=null&&idleEnabled&&lastActivity.Elapsed.TotalSeconds>=idleSeconds)EndControl(session,"idle");bar.RefreshStatus();};timer.Start();ready.Set();Application.Run();timer.Stop();if(keyboardHandle!=IntPtr.Zero)UnhookWindowsHookEx(keyboardHandle);if(mouseHandle!=IntPtr.Zero)UnhookWindowsHookEx(mouseHandle);overlay.Dispose();bar.Dispose();});
        gui.SetApartmentState(ApartmentState.STA);gui.Start();ready.WaitOne();
        var inputWorker=new Thread(()=>{foreach(var request in inputRequests.GetConsumingEnumerable())Handle(request);});inputWorker.IsBackground=true;inputWorker.Start();
        var recoveryWorker=new Thread(()=>{foreach(var request in recoveryReplies.GetConsumingEnumerable())Handle(request);});recoveryWorker.IsBackground=true;recoveryWorker.Start();
        try{string line;while((line=Console.ReadLine())!=null){var request=new JavaScriptSerializer{MaxJsonLength=20000000}.Deserialize<Dictionary<string,object>>(line);if(Str(request,"action")=="input.execute")lock(stateLock){string id=Str(request,"requestId");int count;pendingInputCounts.TryGetValue(id,out count);pendingInputCounts[id]=count+1;if(count==0)pendingInputSessions[id]=Str(request,"controlSessionId");}string action=Str(request,"action");
            if(action=="input.execute")inputRequests.Add(request);
            else if(action=="input.cancel"){MarkInputCancelled(request);recoveryReplies.Add(request);}
            else if(action=="control.end"){MarkControlEnded(request);recoveryReplies.Add(request);}
            else if(action=="control.begin"){ReserveControlBegin(request);ui.Post(_=>Handle(request),null);}
            else if(action=="control.end"||action=="control.activity"||action=="settings.update"||action=="annotation.show"||action=="annotation.update"||action=="annotation.clear"||action=="annotation.track.stop")ui.Post(_=>Handle(request),null);
            else ThreadPool.QueueUserWorkItem(_=>Handle(request));}}
        finally{stopping=true;inputRequests.CompleteAdding();recoveryReplies.CompleteAdding();try{EndControl(session,"owner-disconnected");ReleaseOwned();}finally{lock(tracking)foreach(var item in tracking.Values)item.stopped=true;if(ui!=null)ui.Post(_=>{layers.Clear();Application.ExitThread();},null);gui.Join(5000);lock(frameLock){foreach(var frame in frames.Values)frame.Dispose();frames.Clear();}}}
    }
    class ControlBar:Form {
        public Dictionary<string,object> Source=new Dictionary<string,object>();Label label;Button close;
        string noticeKey,dismissedKey;readonly Stopwatch noticeClock=new Stopwatch();
        public ControlBar(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;Size=new Size(410,70);Location=new Point(SystemInformation.VirtualScreen.Right-430,SystemInformation.VirtualScreen.Top+20);BackColor=Color.FromArgb(26,39,49);ForeColor=Color.White;
            label=new Label{Left=12,Top=10,Width=300,Height=52};Controls.Add(label);close=new Button{Text="退出控制",Left=314,Top=14,Width=86,Height=40};close.Click+=(s,e)=>{if(activeInputRequest!=null)MarkInputCancelled(new Dictionary<string,object>{{"requestId",activeInputRequest},{"controlSessionId",activeInputSession}});else if(session!=null)EndControl(session,"user-exit");else{dismissedKey=presentationRequestId+":"+presentationPhase;Hide();}};Controls.Add(close);
            Point start=Point.Empty;label.MouseDown+=(s,e)=>{if(e.Button==MouseButtons.Left)start=e.Location;};label.MouseMove+=(s,e)=>{if(e.Button==MouseButtons.Left)Location=new Point(Left+e.X-start.X,Top+e.Y-start.Y);};}
        protected override bool ShowWithoutActivation{get{return true;}}
        protected override CreateParams CreateParams{get{var value=base.CreateParams;value.ExStyle|=0x08000000|0x80;return value;}}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);SetWindowDisplayAffinity(Handle,0x11);}
        public void RefreshStatus(){
            if(!nativeBarMode){Hide();return;}
            string currentKey=presentationRequestId+":"+presentationPhase;
            if(currentKey==dismissedKey){Hide();return;}
            bool notice=presentationPhase=="returned"||presentationPhase=="stopped"||presentationPhase=="failed";
            var config=Obj(Get(settings,"presentation"));
            if(notice){
                if(noticeKey!=currentKey){noticeKey=currentKey;noticeClock.Restart();}
                if(noticeClock.Elapsed.TotalMilliseconds>=Num(config,"noticeDurationMs",2500)){Hide();return;}
            }else{noticeKey=null;noticeClock.Reset();}
            if(session==null&&presentationPhase=="ready"){Hide();return;}
            if(!Visible){Show();ShowWindow(Handle,4);}
            var display=Obj(presentationDisplay);var area=Obj(Get(display,"workArea"));Rectangle work=area.Count==0?DesktopScreen.FromHandle(GetForegroundWindow()).WorkingArea:new Rectangle((int)Num(area,"x"),(int)Num(area,"y"),(int)Num(area,"width"),(int)Num(area,"height"));
            bool large=Str(config,"textSize","standard")=="large";int desiredHeight=large?90:70;if(Height!=desiredHeight){Height=desiredHeight;label.Height=Height-20;close.Top=(Height-close.Height)/2;var previousFont=label.Font;label.Font=new Font(SystemFonts.DefaultFont.FontFamily,large?13:10);if(previousFont!=SystemFonts.DefaultFont)previousFont.Dispose();}
            Location=new Point(work.Left+(work.Width-Width)/2,Str(config,"barPlacement","top-center")=="bottom-center"?work.Bottom-Height-20:work.Top+20);
            double? remaining=Remaining();string returned=Str(Obj(presentationReturnState),"state");string status=presentationPhase=="returning"?"正在归还":presentationPhase=="returned"?(returned=="restored"?"已归还":returned=="yielded"?"已让出控制":returned=="partial"?"部分归还":"归还状态未知"):presentationPhase=="capturing"?"正在观察":presentationPhase=="prepared"?"图像已准备":"正在操作";
            label.Text="Rabi · "+status+" · "+Str(Source,"label",Str(Source,"id"))+"\n"+(remaining.HasValue&&remaining.Value<=countdown*1000?"剩余 "+Math.Ceiling(remaining.Value/1000)+" 秒 · ":"")+Str(Obj(Get(settings,"control")),"exitShortcut","Ctrl+Alt+Esc")+" 退出";
        }
        protected override void WndProc(ref Message message){if(message.Msg==0x312&&message.WParam.ToInt32()==1&&physicalExitPending){physicalExitPending=false;EndControl(session,"user-shortcut");}base.WndProc(ref message);}
    }
    class Overlay:Form {
        public Overlay(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;Bounds=SystemInformation.VirtualScreen;BackColor=Color.Magenta;TransparencyKey=Color.Magenta;DoubleBuffered=true;}
        protected override bool ShowWithoutActivation{get{return true;}}
        protected override CreateParams CreateParams{get{var value=base.CreateParams;value.ExStyle|=0x80000|0x20|0x08000000|0x80;return value;}}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);SetWindowDisplayAffinity(Handle,0x11);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(externalQt)return;e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            foreach(var layer in layers.Values)foreach(var entry in Items(Get(layer,"objects"))){var shape=Obj(entry);var source=Obj(Get(layer,"source"));var style=Obj(Get(shape,"style"));string type=Str(shape,"type");Color color;try{color=ColorTranslator.FromHtml(Str(style,"color","#3de0cf"));}catch{color=Color.Cyan;}color=Color.FromArgb((int)(255*Math.Max(0,Math.Min(1,Num(style,"opacity",1)))),color);
                using(var pen=new Pen(color,(float)Num(style,"lineWidth",2)))using(var brush=new SolidBrush(color)){
                    var bounds=Obj(Get(shape,"bounds"));Point a=Position(new Dictionary<string,object>{{"x",Num(bounds,"x")},{"y",Num(bounds,"y")}},source,"x","y"),b=Position(new Dictionary<string,object>{{"x",Num(bounds,"x")+Num(bounds,"width")},{"y",Num(bounds,"y")+Num(bounds,"height")}},source,"x","y");var rect=new Rectangle(a.X-Left,a.Y-Top,b.X-a.X,b.Y-a.Y);
                    if(Bool(style,"dashed"))pen.DashStyle=System.Drawing.Drawing2D.DashStyle.Dash;
                    if(type=="rect")e.Graphics.DrawRectangle(pen,rect);else if(type=="ellipse")e.Graphics.DrawEllipse(pen,rect);else if(type=="highlight"){using(var translucent=new SolidBrush(Color.FromArgb(Math.Min(90,(int)color.A),color)))e.Graphics.FillRectangle(translucent,rect);}else if(type=="text"){using(var font=new Font(SystemFonts.DefaultFont.FontFamily,(float)Num(style,"fontSize",14)))e.Graphics.DrawString(Str(shape,"text"),font,brush,rect.Location);}
                    else{var points=new List<Point>();foreach(var point in Items(Get(shape,"points"))){var q=Position(Obj(point),source,"x","y");points.Add(new Point(q.X-Left,q.Y-Top));}if(points.Count>=2){if(type=="arrow")pen.CustomEndCap=new System.Drawing.Drawing2D.AdjustableArrowCap(4,5);e.Graphics.DrawLines(pen,points.ToArray());}}
                }
            }
            if(pointerVisible&&session!=null){var q=new Point(pointer.X-Left,pointer.Y-Top);using(var pen=new Pen(Color.Cyan,3))e.Graphics.DrawEllipse(pen,q.X-7,q.Y-7,14,14);e.Graphics.DrawString("Rabi",SystemFonts.DefaultFont,Brushes.White,q.X+12,q.Y);}
        }
    }
}
