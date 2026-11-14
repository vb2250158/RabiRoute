using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using OpenCvSharp;
using OpenCvSharp.Tracking;

namespace RabiComputerTracking {
    /// <summary>CPU-only KCF and local TM_CCOEFF_NORMED. It never performs semantic detection.</summary>
    public sealed class Engine : IDisposable {
        sealed class Target : IDisposable {
            public string Id, Description, State; public Rect Bounds; public Mat Template; public TrackerKCF Kcf;
            public double? Similarity; public int Lost; public Rect LastObserved,Display;public double ObservedMs,VelocityX,VelocityY; public Dictionary<string,object> Style;
            public void Dispose(){if(Template!=null)Template.Dispose();if(Kcf!=null)Kcf.Dispose();}
        }
        public sealed class PreparedFrame : IDisposable {
            public int Width,Height; public readonly Mat Color,Gray;
            readonly Dictionary<int,Mat[]> sizes=new Dictionary<int,Mat[]>();readonly HashSet<int> currentSizes=new HashSet<int>();
            public PreparedFrame(byte[] pixels,int width,int height){Color=new Mat();Gray=new Mat();Reset(pixels,width,height);}
            public void Reset(byte[] pixels,int width,int height){
                Width=width;Height=height;currentSizes.Clear();
                using(var bgra=Mat.FromPixelData(height,width,MatType.CV_8UC4,pixels)){Cv2.CvtColor(bgra,Color,ColorConversionCodes.BGRA2BGR);Cv2.CvtColor(Color,Gray,ColorConversionCodes.BGR2GRAY);}
            }
            public Mat[] At(int maximum){int width=Math.Min(Width,maximum);if(width==Width)return new[]{Color,Gray};Mat[] value;if(sizes.TryGetValue(width,out value)&&currentSizes.Contains(width))return value;
                if(value==null){value=new[]{new Mat(),new Mat()};sizes.Add(width,value);}var size=new Size(width,Math.Max(1,Height*width/Width));Cv2.Resize(Color,value[0],size,0,0,InterpolationFlags.Area);Cv2.Resize(Gray,value[1],size,0,0,InterpolationFlags.Area);currentSizes.Add(width);return value;}
            public long KnownBytes { get { long total=(long)Width*Height*4+Color.Total()*Color.ElemSize()+Gray.Total()*Gray.ElemSize();foreach(var pair in sizes.Values)foreach(var mat in pair)total+=mat.Total()*mat.ElemSize();return total; } }
            public void Dispose(){Color.Dispose();Gray.Dispose();foreach(var pair in sizes.Values)foreach(var mat in pair)mat.Dispose();sizes.Clear();}
        }
        public static object Prepare(byte[] pixels,int width,int height){return new PreparedFrame(pixels,width,height);}
        static object Get(Dictionary<string,object> value,string key,object fallback=null){object result;return value!=null&&value.TryGetValue(key,out result)?result:fallback;}
        static string Str(Dictionary<string,object> value,string key,string fallback=""){return Convert.ToString(Get(value,key,fallback));}
        static double Num(Dictionary<string,object> value,string key,double fallback=0){return Convert.ToDouble(Get(value,key,fallback));}
        static bool Bool(Dictionary<string,object> value,string key,bool fallback=false){return Convert.ToBoolean(Get(value,key,fallback));}
        static Dictionary<string,object> Obj(object value){return value as Dictionary<string,object>??new Dictionary<string,object>();}
        static IEnumerable Items(object value){return value as IEnumerable??new object[0];}
        readonly List<Target> targets=new List<Target>();
        string id,layerId,backend,state="initializing";double expansion=2,threshold=.82,ambiguity=.05,rate=10,minRate=2,budget=20;
        int maximumWidth=1280,minWidth=320,verifyEvery=10,lostAfter=2,steps,overBudget,rawWidth,rawHeight;bool updateTemplate,automatic=true,disposed;double predictionMs,smoothing;long memoryBudget=536870912;
        readonly Stopwatch runtime=Stopwatch.StartNew();int measuredFrames,analysisWidth,configuredWidth,maxTargets=8;double configuredRate,requestedRate;string requestedBackend;bool overrideRate,overrideBackend;
        public Dictionary<string,object> Start(Dictionary<string,object> request,byte[] original,int width,int height,Dictionary<string,object> originalSource,byte[] current,int currentWidth,int currentHeight,Dictionary<string,object> currentSource){
            id=Str(request,"trackingId");layerId=Str(request,"layerId");backend=Str(request,"backend","kcf");if(backend!="kcf"&&backend!="template")throw new ArgumentException("Only kcf and template CPU backends are implemented.");
            var settings=Obj(Get(request,"settings"));var overrides=Obj(Get(request,"overrides"));
            overrideRate=Bool(overrides,"rateHz",request.ContainsKey("rateHz"));overrideBackend=Bool(overrides,"backend",request.ContainsKey("backend"));
            requestedRate=Num(request,"rateHz",10);requestedBackend=Str(request,"backend","kcf");Configure(settings);
            rawWidth=currentWidth;rawHeight=currentHeight;
            if(width!=currentWidth||height!=currentHeight)throw new InvalidOperationException("The source dimensions changed since observation; obtain a fresh source frame.");
            using(var oldFrame=new PreparedFrame(original,width,height))using(var frame=new PreparedFrame(current,currentWidth,currentHeight)){
                var oldImages=oldFrame.At(maximumWidth);var images=frame.At(maximumWidth);analysisWidth=images[0].Width;double scale=images[0].Width/(double)currentWidth;
                double sourceWidth=Num(originalSource,"width",width),sourceHeight=Num(originalSource,"height",height);
                foreach(var value in Items(Get(request,"targets"))){var spec=Obj(value);var bounds=Obj(Get(spec,"bounds"));var target=new Target{Id=Str(spec,"id"),Description=Str(spec,"description"),Style=Obj(Get(spec,"style"))};
                    var originalBounds=Clip(new Rect((int)(Num(bounds,"x")*width/sourceWidth*scale),(int)(Num(bounds,"y")*height/sourceHeight*scale),Math.Max(1,(int)(Num(bounds,"width")*width/sourceWidth*scale)),Math.Max(1,(int)(Num(bounds,"height")*height/sourceHeight*scale))),oldImages[1]);
                    if(originalBounds.Width<2||originalBounds.Height<2){target.State="lost";targets.Add(target);continue;}
                    target.Template=new Mat(oldImages[1],originalBounds).Clone();target.Bounds=originalBounds;
                    Cv2.MeanStdDev(target.Template,out Scalar mean,out Scalar deviation);
                    if(deviation.Val0<1){target.State="ambiguous";targets.Add(target);continue;}
                    Locate(target,images[1],originalBounds);
                    if(target.State=="located"&&backend=="kcf"){target.Kcf=TrackerKCF.Create();target.Kcf.Init(images[0],target.Bounds);target.State="tracking";}
                    if(target.State=="located"||target.State=="tracking")Observe(target);
                    targets.Add(target);
                }
                int maximumTargets=maxTargets;if(targets.Count>maximumTargets)throw new InvalidOperationException("Tracking target count exceeds the configured maxTargets budget.");
                state=Aggregate();return Result(currentSource,scale,0,0);
            }
        }
        public void Configure(Dictionary<string,object> settings){
            var annotation=Obj(Get(settings,"annotation"));var config=Obj(Get(annotation,"tracking"));var performance=Obj(Get(settings,"performance"));
            string nextBackend=overrideBackend?requestedBackend:Str(annotation,"backend","kcf");
            if(nextBackend!="kcf"&&nextBackend!="template")throw new ArgumentException("Only kcf and template CPU backends are implemented.");
            if(backend!=nextBackend){foreach(var target in targets){if(target.Kcf!=null){target.Kcf.Dispose();target.Kcf=null;}}backend=nextBackend;}
            double nextRate=overrideRate?requestedRate:Num(annotation,"rateHz",10);int nextWidth=(int)Num(config,"maxAnalysisWidth",1280);
            bool nextAutomatic=Str(performance,"mode","auto")=="auto";
            if(configuredRate!=nextRate||automatic!=nextAutomatic)rate=nextRate;
            if(configuredWidth!=nextWidth||automatic!=nextAutomatic)maximumWidth=nextWidth;
            configuredRate=nextRate;configuredWidth=nextWidth;automatic=nextAutomatic;
            expansion=Num(config,"searchExpansion",2);threshold=Num(config,"matchThreshold",.82);ambiguity=Num(config,"ambiguityMargin",.05);
            verifyEvery=(int)Num(config,"verifyEveryFrames",10);lostAfter=(int)Num(config,"lostAfterFrames",2);updateTemplate=Bool(config,"updateTemplate");
            predictionMs=Num(config,"predictionMs",0);smoothing=Num(config,"smoothing",0);memoryBudget=(long)Num(performance,"memoryBudgetBytes",536870912);
            minRate=Math.Min(rate,Num(performance,"minRateHz",2));minWidth=(int)Num(performance,"minAnalysisWidth",320);budget=Num(performance,"computeBudgetMs",20);maxTargets=(int)Num(performance,"maxTargets",8);
        }
        public Dictionary<string,object> ApplyBudget(string reason){
            string stage;
            if(!automatic){state="paused";stage="paused";}
            else if(rate>minRate){rate=Math.Max(minRate,rate*.75);stage="update-rate";}
            else if(maximumWidth>minWidth){maximumWidth=Math.Max(minWidth,(int)(maximumWidth*.75));stage="analysis-resolution";}
            else{state="paused";stage="paused";}
            degradation=reason+":"+stage;
            return new Dictionary<string,object>{{"state",state},{"effective",new Dictionary<string,object>{{"backend",backend},{"rateHz",rate},{"maxAnalysisWidth",maximumWidth},{"reason",degradation},{"memoryBudgetBytes",memoryBudget},{"predictionMs",predictionMs},{"smoothing",smoothing}}}};
        }
        void ResizeTargets(PreparedFrame frame,Mat[] images){
            var previous=frame.At(analysisWidth);double ratio=images[0].Width/(double)analysisWidth;
            foreach(var target in targets){
                bool verified=false;
                if(target.Template!=null&&target.State!="ambiguous"){Locate(target,previous[1],target.Bounds);verified=target.State=="located";}
                target.Bounds=Scale(target.Bounds,ratio);target.LastObserved=Scale(target.LastObserved,ratio);target.Display=Scale(target.Display,ratio);target.VelocityX*=ratio;target.VelocityY*=ratio;
                if(target.Kcf!=null){target.Kcf.Dispose();target.Kcf=null;}
                if(target.Template!=null){
                    Mat replacement;
                    if(verified){target.Bounds=Clip(target.Bounds,images[1]);replacement=new Mat(images[1],target.Bounds).Clone();}
                    else {replacement=new Mat();Cv2.Resize(target.Template,replacement,new Size(Math.Max(1,(int)(target.Template.Width*ratio)),Math.Max(1,(int)(target.Template.Height*ratio))),0,0,InterpolationFlags.Area);}
                    target.Template.Dispose();target.Template=replacement;
                }
                if(verified){if(backend=="kcf"){target.Kcf=TrackerKCF.Create();target.Kcf.Init(images[0],target.Bounds);target.State="tracking";}Observe(target);}
            }
            analysisWidth=images[0].Width;
        }
        static Rect Clip(Rect bounds,Mat image){return bounds.Intersect(new Rect(0,0,image.Width,image.Height));}
        void Locate(Target target,Mat gray,Rect around){
            if(target.Template==null){target.State="lost";return;}
            int expandX=(int)Math.Ceiling(around.Width*expansion),expandY=(int)Math.Ceiling(around.Height*expansion);
            Rect roi=Clip(new Rect(around.X-expandX,around.Y-expandY,around.Width+expandX*2,around.Height+expandY*2),gray);
            if(roi.Width<target.Template.Width||roi.Height<target.Template.Height){target.State="lost";return;}
            using(var search=new Mat(gray,roi))using(var result=new Mat()){
                Cv2.MatchTemplate(search,target.Template,result,TemplateMatchModes.CCoeffNormed);Cv2.MinMaxLoc(result,out double minimum,out double best,out Point minPoint,out Point bestPoint);
                target.Similarity=best;
                if(double.IsNaN(best)||best<threshold){target.State="lost";target.Lost++;return;}
                // Exclude the same peak's overlapping neighborhood before checking a competing target.
                using(var second=result.Clone()){
                    int dx=Math.Max(1,target.Template.Width/2),dy=Math.Max(1,target.Template.Height/2);
                    var peak=new Rect(bestPoint.X-dx,bestPoint.Y-dy,dx*2+1,dy*2+1).Intersect(new Rect(0,0,result.Width,result.Height));
                    using(var excluded=new Mat(second,peak))excluded.SetTo(-1);
                    Cv2.MinMaxLoc(second,out minimum,out double other);
                    if(other>=best-ambiguity){target.State="ambiguous";target.Lost++;return;}
                }
                target.Bounds=new Rect(roi.X+bestPoint.X,roi.Y+bestPoint.Y,target.Template.Width,target.Template.Height);target.State="located";target.Lost=0;
            }
        }
        public Dictionary<string,object> Step(object prepared,Dictionary<string,object> source,double captureMs){
            if(disposed)throw new ObjectDisposedException("Computer tracking");var frame=(PreparedFrame)prepared;
            if(state=="paused")return Result(source,Math.Min(frame.Width,maximumWidth)/(double)frame.Width,0,captureMs,frame.KnownBytes);
            if(frame.Width!=rawWidth||frame.Height!=rawHeight){state="lost";degradation="source-dimensions-changed";foreach(var target in targets)target.State="lost";return Result(source,1,0,captureMs);}
            var elapsed=Stopwatch.StartNew();var images=frame.At(maximumWidth);if(images[0].Width!=analysisWidth)ResizeTargets(frame,images);double scale=images[0].Width/(double)frame.Width;steps++;
            foreach(var target in targets){
                if(target.Template==null||target.State=="ambiguous")continue;
                if(backend=="template"||target.Kcf==null){Locate(target,images[1],target.Bounds);if(target.State=="located"){if(backend=="kcf"){target.Kcf=TrackerKCF.Create();target.Kcf.Init(images[0],target.Bounds);target.State="tracking";}Observe(target);}else Predict(target);continue;}
                var bounds=target.Bounds;bool ok=target.Kcf.Update(images[0],ref bounds);
                if(!ok){target.State="lost";if(++target.Lost>=lostAfter)Locate(target,images[1],target.Bounds);if(target.State=="located")Observe(target);else Predict(target);continue;}
                target.Bounds=Clip(bounds,images[0]);target.State="tracking";target.Similarity=null;target.Lost=0;
                if(steps%verifyEvery==0){Locate(target,images[1],target.Bounds);if(target.State!="located")continue;target.State="tracking";
                    if(updateTemplate&&target.Similarity.HasValue&&target.Similarity.Value>=threshold+ambiguity){target.Template.Dispose();target.Template=new Mat(images[1],target.Bounds).Clone();}}
                if(target.State=="tracking")Observe(target);else Predict(target);
            }
            measuredFrames++;state=Aggregate();if(targets.Count>maxTargets){state="paused";degradation="target-budget";return Result(source,scale,elapsed.Elapsed.TotalMilliseconds,captureMs,frame.KnownBytes);}double processing=elapsed.Elapsed.TotalMilliseconds;
            long knownBytes=frame.KnownBytes;foreach(var target in targets)if(target.Template!=null)knownBytes+=target.Template.Total()*target.Template.ElemSize();
            if(knownBytes>memoryBudget){state="paused";degradation="memory-budget";return Result(source,scale,processing,captureMs,knownBytes);}
            if(automatic&&processing+captureMs>budget){
                if(++overBudget>=3){overBudget=0;if(rate>minRate){rate=Math.Max(minRate,rate*.75);degradation="update-rate";}
                    else if(maximumWidth>minWidth){maximumWidth=Math.Max(minWidth,(int)(maximumWidth*.75));ResizeTargets(frame,frame.At(maximumWidth));degradation="analysis-resolution";}
                    else{state="paused";degradation="compute-budget";}}
            }else overBudget=0;
            scale=Math.Min(frame.Width,maximumWidth)/(double)frame.Width;
            return Result(source,scale,processing,captureMs,knownBytes);
        }
        void Observe(Target target){
            double now=runtime.Elapsed.TotalMilliseconds,dt=now-target.ObservedMs;
            if(target.ObservedMs>0&&dt>0){target.VelocityX=(target.Bounds.X-target.LastObserved.X)/dt;target.VelocityY=(target.Bounds.Y-target.LastObserved.Y)/dt;}
            target.LastObserved=target.Bounds;target.ObservedMs=now;
            double alpha=1/(1+9*smoothing);
            target.Display=target.Display.Width==0?target.Bounds:new Rect((int)Math.Round(target.Display.X+(target.Bounds.X-target.Display.X)*alpha),(int)Math.Round(target.Display.Y+(target.Bounds.Y-target.Display.Y)*alpha),target.Bounds.Width,target.Bounds.Height);
        }
        void Predict(Target target){
            double age=runtime.Elapsed.TotalMilliseconds-target.ObservedMs;
            if(target.State!="ambiguous"&&predictionMs>0&&target.ObservedMs>0&&age<=predictionMs){target.State="predicted";target.Display=new Rect(target.LastObserved.X+(int)Math.Round(target.VelocityX*age),target.LastObserved.Y+(int)Math.Round(target.VelocityY*age),target.LastObserved.Width,target.LastObserved.Height);}
        }
        static Rect Scale(Rect value,double ratio){return new Rect((int)(value.X*ratio),(int)(value.Y*ratio),Math.Max(1,(int)(value.Width*ratio)),Math.Max(1,(int)(value.Height*ratio)));}
        string degradation;
        string Aggregate(){if(targets.Count==0)return "lost";bool active=false,ambiguous=false,predicted=false;foreach(var target in targets){if(target.State=="tracking"||target.State=="located")active=true;if(target.State=="ambiguous")ambiguous=true;if(target.State=="predicted")predicted=true;}return active?"tracking":ambiguous?"ambiguous":predicted?"predicted":"lost";}
        Dictionary<string,object> Result(Dictionary<string,object> source,double scale,double processing,double capture,long knownBytes=0){
            var resultTargets=new List<object>();var objects=new List<object>();foreach(var target in targets){var bounds=new Dictionary<string,object>{{"x",target.Bounds.X/scale},{"y",target.Bounds.Y/scale},{"width",target.Bounds.Width/scale},{"height",target.Bounds.Height/scale}};
                var entry=new Dictionary<string,object>{{"id",target.Id},{"description",target.Description},{"state",target.State},{"bounds",bounds}};if(target.Similarity.HasValue)entry["similarity"]=target.Similarity.Value;resultTargets.Add(entry);
                if(state!="paused"&&(target.State=="located"||target.State=="tracking"||target.State=="predicted")){
                    var display=target.Display.Width>0?target.Display:target.Bounds;var style=new Dictionary<string,object>(target.Style);if(target.State=="predicted")style["dashed"]=true;
                    objects.Add(new Dictionary<string,object>{{"id",target.Id},{"type","rect"},{"bounds",new Dictionary<string,object>{{"x",display.X/scale},{"y",display.Y/scale},{"width",display.Width/scale},{"height",display.Height/scale}}},{"style",style}});
                }
            }
            return new Dictionary<string,object>{{"trackingId",id},{"layerId",layerId},{"state",state},{"targets",resultTargets},{"source",source},{"objects",objects},
                {"effective",new Dictionary<string,object>{{"backend",backend},{"rateHz",rate},{"maxAnalysisWidth",maximumWidth},{"reason",degradation},{"predictionMs",predictionMs},{"smoothing",smoothing},{"memoryBudgetBytes",memoryBudget}}},
                {"metrics",new Dictionary<string,object>{{"rateHz",runtime.Elapsed.TotalSeconds>0?measuredFrames/runtime.Elapsed.TotalSeconds:0},{"processingMs",processing},{"captureMs",capture},{"knownBufferBytes",knownBytes}}}};
        }
        public void Dispose(){if(disposed)return;disposed=true;foreach(var target in targets)target.Dispose();targets.Clear();}
    }
}
