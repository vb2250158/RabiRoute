using System.Dynamic;
using System.Security.Principal;
namespace RabiRoute.WindowsBootstrap;
internal static class Program {
 public static int Main(string[] args) {
  if(args.Length==3 && args[1]=="--host") { Fixture.Reset(args[2],true,false,false,false);try { using var owner=new WindowsHostElevationDriver(args[2]);owner.SetAutostart(args[0]=="true");Console.WriteLine("{\"ok\":true}");return 0;}catch(Exception e){Console.Error.WriteLine(e);return 80;} }
  int failed=0,checks=0;
  void Case(string label,bool exists,bool enabled,bool desired,bool elevated,bool foreign,bool rejects,int writes){checks++;Fixture.Reset(Path.Combine(Path.GetTempPath(),"RabiRoute-owner-synthetic","RabiRouteHost.exe"),exists,enabled,elevated,foreign);Exception? error=null;try{using var owner=new WindowsHostElevationDriver(Fixture.Executable);owner.SetAutostart(desired);}catch(Exception e){error=e;}bool pass=(rejects?error is UnauthorizedAccessException:error is null)&&Fixture.Writes==writes&&(writes==0?Fixture.Trigger.Enabled==enabled:Fixture.Trigger.Enabled==desired);if(!pass){failed++;Console.Error.WriteLine($"FAIL {label}: {error}; writes={Fixture.Writes}");}else Console.WriteLine("PASS "+label);}
  Case("ownedfalse samefalse unprivileged is read-only",true,false,false,false,false,false,0);
  Case("ownedtrue sametrue unprivileged is read-only",true,true,true,false,false,false,0);
  Case("ownedfalse samefalse privileged does not rewrite",true,false,false,true,false,false,0);
  Case("owned change unprivileged retains original OS requirement",true,false,true,false,false,true,0);
  Case("owned change privileged uses original registration once",true,false,true,true,false,false,1);
  Case("foreign samefalse is rejected before no-op",true,false,false,false,true,true,0);
  Case("foreign privileged samefalse remains rejected",true,false,false,true,true,true,0);
  Case("missing retains original no-op",false,false,true,false,false,false,0);
  Console.WriteLine($"checks={checks} failed={failed}; exact linked owner, test-only OS boundary; no real tasks touched");return failed==0?0:1;
 }
}
internal static class Fixture {
 public const string Sid="S-1-5-18"; public static bool Exists,Elevated;public static int Writes;public static string Executable=""; public static dynamic Definition=null!,Trigger=null!;
 public static void Reset(string executable,bool exists,bool enabled,bool elevated,bool foreign){Executable=Path.GetFullPath(executable);Exists=exists;Elevated=elevated;Writes=0;dynamic d=new ExpandoObject();dynamic info=new ExpandoObject();info.Description=$"RabiRoute elevated Host; {Sid}; {Path.GetDirectoryName(Executable)}";d.RegistrationInfo=info;dynamic p=new ExpandoObject();p.RunLevel=1;p.LogonType=3;p.UserId=Sid;d.Principal=p;dynamic s=new ExpandoObject();s.MultipleInstances=2;d.Settings=s;dynamic trigger=new ExpandoObject();trigger.Type=9;trigger.UserId=Sid;trigger.Enabled=enabled;Trigger=trigger;d.Triggers=new Collection(trigger);dynamic action=new ExpandoObject();action.Type=0;action.Path=foreign?Executable+".foreign":Executable;action.Arguments="--elevated-task";action.WorkingDirectory=Path.GetDirectoryName(Executable);d.Actions=new Collection(action);Definition=d;}
}
internal sealed class Collection(object item){public int Count=>1;public dynamic Item(int i)=>item;}
internal sealed class TaskObject {public bool Enabled=>true;public dynamic Definition=>Fixture.Definition;}
internal sealed class Folder {public dynamic GetTask(string name){if(!Fixture.Exists)throw new FileNotFoundException();return new TaskObject();}public dynamic RegisterTaskDefinition(string name,object definition,int flags,string sid,object? password,int logon,object? sddl){Fixture.Writes++;return new TaskObject();}}
internal sealed class Service {public void Connect(){}public dynamic GetFolder(string path)=>new Folder();public dynamic NewTask(int flags)=>throw new NotSupportedException();}
// Test-only platform adapter; these classes never compile into the real Bootstrap or utility.
internal static class Type {public static System.Type GetTypeFromProgID(string id)=>typeof(Service);}
internal static class Activator {public static object CreateInstance(System.Type type)=>new Service();}
internal static class Marshal {public static int FinalReleaseComObject(object value)=>0;}
internal sealed class WindowsIdentity {public SecurityIdentifier User=>new(Fixture.Sid);public static WindowsIdentity GetCurrent()=>new();}
internal sealed class WindowsPrincipal(WindowsIdentity identity) {public bool IsInRole(WindowsBuiltInRole role)=>Fixture.Elevated;}
