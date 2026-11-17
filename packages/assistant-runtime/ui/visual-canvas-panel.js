import {paintVisualCanvas} from '../src/visual-canvas.js';

export const visualCanvasStyles=`
.va-canvas{border:1px solid var(--va-line,#31454f);background:#08151b;border-radius:8px;overflow:hidden;color:#b5efe1;min-width:0}
.va-canvas header{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #83ead226}
.va-canvas header strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.va-canvas header span{font-size:12px;color:#9fb3bd}
.va-canvas button{background:#14242d;color:inherit;border:1px solid #31454f;border-radius:5px;padding:5px 9px;cursor:pointer}
.va-canvas canvas{display:block;width:100%;aspect-ratio:16/9;height:auto}
.va-canvas p{font-size:12px!important;color:#9fb3bd;padding:0 12px;margin:8px 0;white-space:normal!important}
.va-canvas details{padding:6px 12px;font-size:12px}.va-canvas a{color:#83ead2;margin-right:12px}
.va-canvas-pinned{position:fixed;z-index:20;right:24px;top:96px;width:min(42vw,620px);box-shadow:0 8px 32px #0005}
.va-canvas-pinned header{cursor:move;touch-action:none}
.va-has-canvas .va-conversation{padding-right:min(44vw,644px)}
.va-canvas-expanded{position:fixed;z-index:1000;inset:5dvh 5vw;width:90vw;max-height:90dvh;overflow:auto}
.va-canvas-expanded canvas{max-height:72dvh;object-fit:contain}
.va-canvas-inline{margin:12px 0;max-width:900px}
@media(max-width:700px){.va-canvas-pinned{position:sticky;left:auto!important;right:auto;top:0!important;width:100%;order:-1}.va-has-canvas .va-conversation{padding-right:0}.va-canvas-expanded{inset:4dvh 2vw;width:96vw}.va-canvas header span{display:none}}
`;

export function createVisualCanvasView(React){
 const h=React.createElement;
 return function VisualCanvas({value,pinned=false,onClose}){
  const ref=React.useRef(null),drag=React.useRef(null),[expanded,setExpanded]=React.useState(false),[position,setPosition]=React.useState(null),[paintError,setPaintError]=React.useState(false);
  const document=value?.document;
  React.useEffect(()=>{if(!document||!ref.current)return;try{const ctx=ref.current.getContext('2d');if(ctx){paintVisualCanvas(ctx,document);setPaintError(false)}}catch{setPaintError(true)}},[document]);
  React.useEffect(()=>{if(!expanded)return;const close=event=>{if(event.key==='Escape')setExpanded(false)};globalThis.addEventListener?.('keydown',close);return()=>globalThis.removeEventListener?.('keydown',close)},[expanded]);
  if(!document)return null;
  const pointerDown=event=>{if(!pinned||expanded||event.target.closest('button'))return;const bounds=event.currentTarget.parentElement.getBoundingClientRect();drag.current={x:event.clientX-bounds.x,y:event.clientY-bounds.y};event.currentTarget.setPointerCapture(event.pointerId)};
  const pointerMove=event=>{if(!drag.current)return;const box=event.currentTarget.parentElement.getBoundingClientRect();setPosition({left:Math.max(0,Math.min(innerWidth-box.width,event.clientX-drag.current.x)),top:Math.max(0,Math.min(innerHeight-box.height,event.clientY-drag.current.y))})};
  return h('section',{className:'va-canvas '+(expanded?'va-canvas-expanded':pinned?'va-canvas-pinned':'va-canvas-inline'),'aria-label':document.title,...(expanded?{role:'dialog','aria-modal':true}:{}),style:pinned&&!expanded&&position?{...position,right:'auto'}:undefined},
   h('header',{onPointerDown:pointerDown,onPointerMove:pointerMove,onPointerUp:()=>{drag.current=null},onPointerCancel:()=>{drag.current=null}},h('strong',null,document.title),h('span',null,pinned?'常驻画布':'图表'),h('button',{onClick:()=>setExpanded(!expanded),'aria-label':expanded?'缩小画布':'放大画布'},expanded?'缩小':'放大'),onClose&&h('button',{onClick:onClose,'aria-label':'关闭画布'},'关闭')),
   paintError?h('p',{role:'alert'},'画布暂时无法绘制，请查看执行详情。'):h('canvas',{ref,width:960,height:540,role:'img','aria-label':document.title+(document.description?'：'+document.description:'')},document.description||document.title),
   document.description&&h('p',null,document.description),document.sources?.length>0&&h('details',null,h('summary',null,'数据来源 · '+document.sources.length),document.sources.map((source,index)=>h('a',{key:index,href:source.url,target:'_blank',rel:'noreferrer'},source.label))));
 };
}
