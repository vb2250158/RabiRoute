using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class ComputerNativeBrokerFixture {
    sealed class DeferredUi : SynchronizationContext {
        public readonly ManualResetEvent Queued=new ManualResetEvent(false),Continue=new ManualResetEvent(false);
        public override void Send(SendOrPostCallback callback,object state){Queued.Set();if(!Continue.WaitOne(5000))throw new Exception("fixture UI deadline");callback(state);}
    }
    static Type native;
    static object Call(string method,params object[] args){try{return native.GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}catch(TargetInvocationException error){throw error.InnerException;}}
    static FieldInfo Field(string name){return native.GetField(name,BindingFlags.Static|BindingFlags.NonPublic);}
    static Dictionary<string,object> Request(string action,string id){return new Dictionary<string,object>{{"action",action},{"controlSessionId",id},{"id",action+"-fixture"}};}
    static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
    static int Count(string field){var value=Field(field).GetValue(null);return Convert.ToInt32(value.GetType().GetProperty("Count").GetValue(value,null));}
    public static int Main(string[] args){
        try{
            native=Assembly.LoadFrom(args[0]).GetType("RabiComputer",true);
            var ui=new DeferredUi();Field("ui").SetValue(null,ui);
            var begin=Request("control.begin","session-A");Call("ReserveControlBegin",begin);
            Exception failure=null;var worker=new Thread(()=>{try{Call("Handle",begin);}catch(Exception error){failure=error;}});worker.Start();Require(ui.Queued.WaitOne(5000),"begin was not queued");
            var end=Request("control.end","session-A");Call("MarkControlEnded",end);Call("Handle",end);
            ui.Continue.Set();Require(worker.Join(5000),"late begin did not finish");if(failure!=null)throw failure;
            Require(Field("session").GetValue(null)==null,"ended pending begin resurrected control");
            Require(Count("pendingControlBegins")==0&&Count("endingControlSessions")==0,"pending lifecycle fences were retained after completion");
            Field("session").SetValue(null,"session-B");Call("MarkControlEnded",end);
            Require(Convert.ToString(Field("session").GetValue(null))=="session-B","old end cleared a new session");
            Field("session").SetValue(null,"same-literal");var cancelled=Field("cancelledRequests").GetValue(null);cancelled.GetType().GetMethod("Add").Invoke(cancelled,new object[]{"same-literal"});
            Call("CheckInput","same-literal","another-request");
            Console.WriteLine("{\"passed\":true,\"cases\":[\"slow-begin-end-late-begin-no-resurrection\",\"pending-fence-reclaimed\",\"old-end-keeps-new-session\",\"request-and-session-namespaces-separated\"]}");
            return 0;
        }catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
