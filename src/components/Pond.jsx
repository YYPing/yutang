import {forwardRef,useEffect,useImperativeHandle,useRef} from 'react';
import {PondEngine} from '../engine/pond.js';
const Pond=forwardRef(function Pond({options,fish,onFeed,desktop},ref){
 const canvas=useRef(null),landscape=useRef(null),engine=useRef(null);const initial=useRef({options,fish});
 useEffect(()=>{const instance=new PondEngine(canvas.current,initial.current.options,landscape.current);engine.current=instance;instance.setCustomFish(initial.current.fish);instance.start();
  // 仅开发期：把引擎挂到 window，供 tools/check-light-ui.cjs 把 §10.5 光照场
  // 钉到确定状态（放/收指定光柱、把某条鱼挪到光池心）再截图量像素。
  // ⚠️ `import.meta.env.DEV` 在 `vite build` 里被替换成 `false` ⇒ 整块被 tree-shake 掉。
  //    生产包里既没有这个全局变量，也不存在"忘关的调试开关"。
  if(import.meta.env.DEV)window.__pondEngine=instance;
  return()=>{instance.destroy();engine.current=null;if(import.meta.env.DEV)delete window.__pondEngine}},[]);
 useEffect(()=>engine.current?.updateOptions(options),[options]);useEffect(()=>engine.current?.setCustomFish(fish),[fish]);
useEffect(()=>engine.current?.updateOptions({displayPixelRatio:desktop?.display?.scaleFactor||0}),[desktop?.display?.scaleFactor]);
useImperativeHandle(ref,()=>({feed:(x,y)=>engine.current?.feed(x??canvas.current.clientWidth*.52,y??canvas.current.clientHeight*.5),stats:()=>engine.current?.getStats(),resetPopulation:n=>engine.current?.resetPopulation(n),resetEcoFully:n=>engine.current?.resetEcoFully(n),snapshot:()=>engine.current?.getSnapshot(),takeAwayReport:()=>engine.current?.takeAwayReport()}),[]);
 // F-2.6：feed() 返回 {ok, capped}，把结果交给上层决定提示什么（撒不下时"这一把够了"）。
 useEffect(()=>{if(!window.pondDesktop)return;return window.pondDesktop.onPointer(event=>{if(event.type==='feed')onFeed?.(engine.current?.feed(event.x,event.y));else engine.current?.pointer(event.x,event.y,true)})},[onFeed]);
 return <><canvas ref={landscape} className="living-background" aria-hidden="true"/><canvas ref={canvas} className="pond-canvas" aria-label="互动锦鲤池塘，轻点水面投食" onPointerMove={e=>engine.current?.pointer(e.clientX,e.clientY,true)} onPointerLeave={()=>engine.current?.pointer(0,0,false)} onPointerDown={e=>{if(e.button!==0)return;onFeed?.(engine.current?.feed(e.clientX,e.clientY))}}/></>;
});export default Pond;
