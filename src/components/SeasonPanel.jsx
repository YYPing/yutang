import {Flower2,Leaf,Sun,Snowflake,RefreshCw,Check,CalendarDays,Play,Pause} from 'lucide-react';
import {Panel} from './Panel.jsx';
import {SOLAR_TERMS,ALMANAC_MODES,CYCLE_STEP_MS} from '../engine/almanac.js';
export const SEASONS={spring:{name:'春',label:'春日',title:'花落知春',description:'花瓣轻落，游鱼染上春色。',Icon:Flower2},summer:{name:'夏',label:'夏日',title:'荷风送凉',description:'荷叶田田，蜻蜓点水而过。',Icon:Sun},autumn:{name:'秋',label:'秋日',title:'一池知秋',description:'金叶随波，把日子放慢。',Icon:Leaf},winter:{name:'冬',label:'冬日',title:'听雪入梦',description:'薄冰藏鱼，静候一场初雪。',Icon:Snowflake}};
/** 三个时令模式的说明文案。⚠️ 「季节由节气决定」这句必须写在界面上 ——
 *  手动/演示模式下季节滑杆会不生效（见 useEnvironment 的优先级），不写出来就成了静默覆盖。*/
const MODES={
 follow:{name:'跟随节气',desc:'按真实黄经推进，节气之间平滑过渡',Icon:RefreshCw},
 manual:{name:'手动指定',desc:'钉住一个节气不动，用来反复看同一张画面',Icon:CalendarDays},
 cycle:{name:'演示轮转',desc:`每 ${CYCLE_STEP_MS/1000} 秒推进一季，自动看遍二十四节气`,Icon:Play},
};
export default function SeasonPanel({mode,current,onChange,solarTerm,almanacMode,almanacTerm,onAlmanac,onClose}){
 const am=ALMANAC_MODES.includes(almanacMode)?almanacMode:'follow';
 // 手动模式下标题要显示**用户钉住的那个**，而不是 env 解析出来的 ——
 // 两者在 almanacTerm 非法时才会不同，那时宁可显示"未选"也不要显示一个不相干的节气。
 const term=(am==='manual'&&SOLAR_TERMS.includes(almanacTerm))?almanacTerm:solarTerm;
 return <Panel title="四时有景，日日有欢" subtitle={`此刻 · ${term || SEASONS[current].label}，让池塘陪你走过四季。`} onClose={onClose}>
 <button className={`auto-choice ${mode==='auto'?'selected':''}`} onClick={()=>onChange('auto')}><span><RefreshCw size={17}/>跟随当地四季</span>{mode==='auto'&&<Check size={17}/>}</button>
 <div className="season-grid">{Object.entries(SEASONS).map(([key,{name,title,description,Icon}])=><button aria-pressed={mode===key} className={`season-card ${key} ${mode===key?'selected':''} ${am!=='follow'?'dimmed':''}`} key={key} onClick={()=>onChange(key)}><span className="season-symbol"><Icon size={25}/><b>{name}</b></span><strong>{title}</strong><small>{description}</small>{mode===key&&<Check className="season-check" size={16}/>}</button>)}</div>
 {am!=='follow'&&<p className="inline-note">时令模式接管中：季节已改由节气决定，上面的季节选择暂不生效。</p>}
 <div className="section-divider"/>
 <p className="almanac-title"><CalendarDays size={15}/>二十四节气<small>{am==='follow'?'随真实日期流转':am==='manual'?`已钉住「${term||'—'}」`:'演示轮转中'}</small></p>
 <div className="mode-choices" role="group" aria-label="时令模式">{ALMANAC_MODES.map(id=>{const{name,desc,Icon}=MODES[id];return <button key={id} className={am===id?'selected':''} aria-pressed={am===id} onClick={()=>onAlmanac('almanacMode',id)}><span><Icon size={17}/>{name}</span><small>{desc}</small>{am===id&&<Check size={15}/>}</button>})}</div>
 {am==='manual'&&<div className="term-grid" role="group" aria-label="选择节气">{SOLAR_TERMS.map(t=><button key={t} className={almanacTerm===t?'selected':''} aria-pressed={almanacTerm===t} onClick={()=>onAlmanac('almanacTerm',t)}>{t}</button>)}</div>}
 {am==='manual'&&!SOLAR_TERMS.includes(almanacTerm)&&<p className="inline-note">还没选节气 —— 先挑一个，画面会立刻走过去。</p>}
 {am==='cycle'&&<p className="inline-note">演示会跟着当下的真实节气起步，然后每{CYCLE_STEP_MS/1000} 秒推进一档；每档前 55% 稳停、后 45% 渐变到下一档。</p>}
 <p className="inline-note">节气切换用渐变而非跳变 —— 真实节气之间还有大半个月，不该"啪"地变一次。</p>
 </Panel>
}