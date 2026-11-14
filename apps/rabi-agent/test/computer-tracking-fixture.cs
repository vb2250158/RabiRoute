using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using RabiComputerTracking;

internal static class ComputerTrackingFixture {
    static Dictionary<string,object> Map(params object[] values){var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)result.Add((string)values[i],values[i+1]);return result;}
    static byte[] Frame(int x,int y,bool duplicate=false,bool hidden=false){
        var bytes=new byte[320*240*4];for(int i=0;i<bytes.Length;i+=4){bytes[i]=12;bytes[i+1]=17;bytes[i+2]=23;bytes[i+3]=255;}
        if(hidden)return bytes;
        int[] locations=duplicate?new[]{x,x+50}:new[]{x};
        foreach(int left in locations){var random=new Random(341);for(int row=0;row<24;row++)for(int col=0;col<32;col++){
            int index=((y+row)*320+left+col)*4;bytes[index]=(byte)random.Next(20,240);bytes[index+1]=(byte)random.Next(20,240);bytes[index+2]=(byte)random.Next(20,240);
        }}return bytes;
    }
    static Dictionary<string,object> Source(){return Map("instanceId","fixture","kind","window","windowId","fixture","pid",1,"width",320,"height",240,"coordinateSpace","capture","bounds",Map("x",0,"y",0,"width",320,"height",240));}
    static byte[] Larger(byte[] pixels){var result=new byte[640*480*4];for(int y=0;y<240;y++)Buffer.BlockCopy(pixels,y*320*4,result,y*640*4,320*4);return result;}
    static Dictionary<string,object> Request(string backend,bool lowBudget=false,double prediction=0,double smoothing=0){return Map(
        "trackingId",Guid.NewGuid().ToString(),"layerId","fixture","backend",backend,"rateHz",10,
        "targets",new[]{Map("id","moving","bounds",Map("x",40,"y",50,"width",32,"height",24))},
        "settings",Map("annotation",Map("tracking",Map("maxAnalysisWidth",320,"searchExpansion",3,"matchThreshold",.82,"ambiguityMargin",.05,"verifyEveryFrames",10,"lostAfterFrames",2,"predictionMs",prediction,"smoothing",smoothing)),
            "performance",Map("mode","auto","computeBudgetMs",lowBudget ? 0.000001 : 1000,"minRateHz",10,"minAnalysisWidth",320,"maxTargets",8,"memoryBudgetBytes",268435456)));}
    static Dictionary<string,object> FirstTarget(Dictionary<string,object> result){return (Dictionary<string,object>)((List<object>)result["targets"])[0];}
    static double X(Dictionary<string,object> result){return Convert.ToDouble(((Dictionary<string,object>)FirstTarget(result)["bounds"])["x"]);}
    static void Require(bool value,string message){if(!value)throw new Exception(message);}
    static Dictionary<string,object> Init(Engine engine,Dictionary<string,object> request,bool duplicate=false){return engine.Start(request,Frame(40,50),320,240,Source(),Frame(52,56,duplicate),320,240,Source());}
    static Dictionary<string,object> Step(Engine engine,byte[] pixels){using(var prepared=(IDisposable)Engine.Prepare(pixels,320,240))return engine.Step(prepared,Source(),0);}
    public static int Main(string[] args){
        var cases=new List<object>();var timing=new List<object>();
        try{
            foreach(string backend in new[]{"kcf","template"})using(var engine=new Engine()){
                var start=Init(engine,Request(backend));Require(Convert.ToString(start["state"])=="tracking","startup not tracking: "+backend);Require(Math.Abs(X(start)-52)<=1,"startup used old coordinates: "+backend);
                var result=Step(engine,Frame(55,58));Require(Convert.ToString(result["state"])=="tracking","step failed: "+backend);Require(Math.Abs(X(result)-55)<=8,"moving target error: "+backend);
                cases.Add(new{test="old-frame-relocation-and-update",backend=backend,passed=true,startX=X(start),nextX=X(result)});
            }
            using(var engine=new Engine()){
                var result=Init(engine,Request("template"),true);Require(Convert.ToString(result["state"])=="ambiguous","identical nearby targets were silently merged");cases.Add(new{test="similar-target-ambiguity",passed=true});
            }
            using(var engine=new Engine()){
                Init(engine,Request("template"));var result=Step(engine,Frame(0,0,false,true));Require(Convert.ToString(result["state"])=="lost","occlusion remained tracking");cases.Add(new{test="lost-target-is-not-confident",passed=true});
            }
            using(var engine=new Engine()){
                var request=Request("template",false,1000,.7);Init(engine,request);var result=Step(engine,Frame(0,0,false,true));Require(Convert.ToString(result["state"])=="predicted","configured short prediction was unused");
                System.Threading.Thread.Sleep(1050);result=Step(engine,Frame(0,0,false,true));Require(Convert.ToString(result["state"])=="lost","prediction continued beyond its configured time");cases.Add(new{test="bounded-prediction",passed=true});
            }
            using(var engine=new Engine()){
                Init(engine,Request("kcf",true));Dictionary<string,object> result=null;for(int n=0;n<4;n++)result=Step(engine,Frame(52,56));Require(Convert.ToString(result["state"])=="paused","compute budget did not pause at its final degradation stage");cases.Add(new{test="automatic-compute-budget-pause",passed=true});
            }
            using(var engine=new Engine()){
                var request=Request("template");var settings=(Dictionary<string,object>)request["settings"];((Dictionary<string,object>)settings["performance"])["memoryBudgetBytes"]=1;
                Init(engine,request);var result=Step(engine,Frame(52,56));Require(Convert.ToString(result["state"])=="paused","memory budget is unused");cases.Add(new{test="memory-budget-pause",passed=true});
            }
            using(var engine=new Engine()){
                var request=Request("template");request["overrides"]=Map("backend",false,"rateHz",false);
                var settings=(Dictionary<string,object>)request["settings"];var annotation=(Dictionary<string,object>)settings["annotation"];annotation["backend"]="template";annotation["rateHz"]=10;
                Init(engine,request);annotation["rateHz"]=5;annotation["backend"]="kcf";((Dictionary<string,object>)annotation["tracking"])["smoothing"]=.6;
                engine.Configure(settings);var result=Step(engine,Frame(55,58));var effective=(Dictionary<string,object>)result["effective"];
                Require(Convert.ToString(effective["backend"])=="kcf"&&Convert.ToDouble(effective["rateHz"])==5&&Convert.ToDouble(effective["smoothing"])==.6,"live parameters were only stored, not consumed");cases.Add(new{test="live-default-configuration",passed=true});
            }
            using(var prepared=(Engine.PreparedFrame)Engine.Prepare(Frame(40,50),320,240)){
                var color=prepared.Color;var gray=prepared.Gray;prepared.At(160);prepared.Reset(Frame(44,52),320,240);var resized=prepared.At(160);
                Require(Object.ReferenceEquals(color,prepared.Color)&&Object.ReferenceEquals(gray,prepared.Gray),"frame preprocessing storage was replaced");Require(resized[0].Width==160,"cached analysis size was lost");cases.Add(new{test="shared-preprocessing-buffer-reuse",passed=true});
            }
            using(var engine=new Engine()){
                var request=Request("template");var settings=(Dictionary<string,object>)request["settings"];var config=(Dictionary<string,object>)((Dictionary<string,object>)settings["annotation"])["tracking"];config["maxAnalysisWidth"]=640;
                var source=Source();source["width"]=640;source["height"]=480;source["bounds"]=Map("x",0,"y",0,"width",640,"height",480);
                engine.Start(request,Larger(Frame(40,50)),640,480,source,Larger(Frame(53,57)),640,480,source);
                config["maxAnalysisWidth"]=320;engine.Configure(settings);Dictionary<string,object> result;
                using(var prepared=(IDisposable)Engine.Prepare(Larger(Frame(53,57)),640,480))result=engine.Step(prepared,source,0);
                Require(Convert.ToString(result["state"])=="tracking"&&Math.Abs(X(result)-53)<=2,"odd-phase template migration lost the verified current target");cases.Add(new{test="analysis-resolution-preserves-verified-target",passed=true});
            }
            foreach(string backend in new[]{"template","kcf"})using(var engine=new Engine()){
                Init(engine,Request(backend));var process=Process.GetCurrentProcess();TimeSpan before=process.TotalProcessorTime;var clock=Stopwatch.StartNew();
                const int count=100;for(int n=0;n<count;n++)Step(engine,Frame(52+n%4,56));clock.Stop();
                timing.Add(new{backend=backend,frames=count,elapsedMs=clock.Elapsed.TotalMilliseconds,cpuSeconds=(process.TotalProcessorTime-before).TotalSeconds,resolution="320x240",scope="synthetic algorithm fixture; not game fps or desktop latency"});
            }
            var proof=new{passed=true,cases=cases,timing=timing};string json=new JavaScriptSerializer().Serialize(proof);Console.WriteLine(json);if(args.Length>0)File.WriteAllText(args[0],json);return 0;
        }catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
