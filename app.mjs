import * as Model from './modules/state.mjs';
import { createGitHubSync } from './modules/sync.mjs';
import * as AudioEngine from './modules/audio.mjs';
import * as Calendar from './modules/calendar.mjs';

let S=null,syncClient=null,storageBlocked=false,startupWarning='',lastRenderedDay='',heatPositioned=false,persistedRaw=null;
let syncStat='',syncKind='idle';
/* URL 标志位也用于无写入的演示模式。 */
function queryFlag(name,search){
  const s=(search!==undefined)?search:((typeof location!=='undefined'&&location.search)||'');
  return new RegExp('[?&]'+name+'(=1)?(&|$)').test(s);
}
/* 演示模式:?demo=1 用一份假数据,存到另一个键、且完全不落盘,把手机递给别人点也不会污染记录。
   ?demo=1&lock=1 是"锁住的演示":不显示退出入口,而且进入时用 location.replace
   把真实 App 的历史记录顶掉,连返回键都回不到真实数据。 */
const DEMO=queryFlag('demo');
const DEMO_LOCK=DEMO&&queryFlag('lock');
const KEY=DEMO?'liferpg.demo':'liferpg.v1';
const UIKEY=DEMO?'liferpg.demo.ui':'liferpg.ui';

/* ===== 同步:打卡后把存档推到 GitHub 私有仓库 =====
   存档只在这台设备的 localStorage 里,电脑上的定时任务读不到。
   所以每次 save() 把整份存档 PUT 到 guangcat/life-rpg-data。
   token 单独存在 liferpg.sync,不进 S,所以导出备份里不会带着它。 */
const SYNC_REPO='guangcat/life-rpg-data';
const SYNC_PATH='backup.json';
const SYNC_KEY='liferpg.sync';
const syncCfg=function(){try{return JSON.parse(localStorage.getItem(SYNC_KEY)||'{}');}catch(e){return {};}};

const CATS=[
  {k:'math', n:'数学', c:'#4f8cff', g:'∑'},
  {k:'eng',  n:'英语', c:'#37d6a0', g:'A'},
  {k:'cs',   n:'专业', c:'#b783ff', g:'{}'},
  {k:'grad', n:'毕业', c:'#ff6b7a', g:'!'},
  {k:'vit',  n:'体力', c:'#ffa94d', g:'♥'},
  {k:'intel',n:'情报', c:'#5ec8ff', g:'?'}
];

/* 任务表版本号。改了下面这张表就要 +1,老存档会走一次 upgrade(),
   把旧默认任务换成新的,但打卡历史(log / days / attr)一条都不动。 */
const TASK_SET=3;

/* 任务按真实课表排的时间。t 是开始时间,wd 是星期(1=周一 … 7=周日),
   不写 wd 就是每天;写了的导出日历时只在那几天重复。 */
const DEFAULT_TASKS=[
  {id:'eng_main',  n:'背词 25 分钟',  c:'eng',  xp:25, d:'醒来第一件事', t:'07:00'},
  {id:'eng_drill', n:'精听一篇',      c:'eng',  xp:30, d:'35 分钟,精听或四级阅读', t:'07:25'},
  {id:'eng_words', n:'只背词',        c:'eng',  xp:12, d:'5 分钟也算,重要的是不断', t:''},
  {id:'prob_video',n:'概率论看课',    c:'math', xp:25, d:'1.9 倍速,约 1.5 集', t:'20:25'},
  {id:'math_block',n:'数学看课',      c:'math', xp:40, d:'35 分钟,记下一个知识点', t:'21:00'},
  {id:'math_do',   n:'数学做题',      c:'math', xp:35, d:'35 分钟,独立作答再订正', t:'21:45'},
  {id:'math_fix',  n:'翻昨天错题',    c:'math', xp:15, d:'不想开始就先做这个', t:''},
  {id:'prob_makeup',n:'概率论补欠',   c:'math', xp:25, d:'补这周欠的集', t:'09:00', wd:[6]},
  {id:'prob_quiz', n:'概率论课后题',  c:'math', xp:50, d:'课后题 + 订正', t:'09:00', wd:[7]},
  {id:'grad_class',n:'上课全勤',      c:'grad', xp:20, d:'一节不逃,平时分是免费分', t:''},
  {id:'grad_hw',   n:'交作业',        c:'grad', xp:15, d:'平时分是白给的', t:''},
  {id:'grad_intel',n:'要考纲/往年题', c:'intel',xp:35, d:'确认考试范围后即可结项', t:'',repeat:'once'},
  {id:'cs_practice',n:'408 一道题',   c:'cs',   xp:25, d:'独立作答，再核对一个知识点', t:''},
  {id:'vit_sleep', n:'23:30 关手机',  c:'vit',  xp:20, d:'作息是体力的唯一来源', t:'23:30'},
  {id:'vit_sport', n:'运动 20 分钟',  c:'vit',  xp:25, d:'体质测试也是学分', t:''},
  {id:'weekly',    n:'周复盘',        c:'intel',xp:15, d:'填路线图第 9 节', t:'21:30', wd:[7]},
  {id:'min_open',  n:'打开计划看一眼',c:'intel',xp:8,  d:'最低成本入口,用来续连击', t:''}
];

/* 第一版那 11 条的 id。升级时整批换掉,不在这个名单里的(用户自己加的)保留。 */
const V1_IDS=['eng_drill','eng_words','math_block','math_fix','cs_block',
              'grad_class','grad_hw','grad_intel','vit_sleep','vit_sport','min_open'];

/* 演示模式专用的任务表:去掉带「重修 / 免听」字样的两条。
   把手机递给朋友看时,这两条一眼就能看出私事,不该出现在演示里。 */
const DEMO_HIDE=['grad_class','grad_intel'];
const DEMO_TASKS=DEFAULT_TASKS.filter(t=>DEMO_HIDE.indexOf(t.id)<0);

/* 备考覆盖量 / 章节打点。这两个是「走到哪了」,不是任务,所以不计经验——
   否则会和「英语一局」「数学一节」重复计分。 */
const TRACKS=[
  {k:'vocab', n:'四级词汇', goal:2000, unit:'词', step:50, kind:'count'},
  {k:'paper', n:'四级真题', goal:5,    unit:'套', step:1,  kind:'count'},
  {k:'math',  n:'高数章节', goal:5,    unit:'章', step:1,  kind:'list',
   items:['极限与连续','导数与微分','中值定理与应用','不定积分','定积分及应用']},
  {k:'cs',    n:'408 四门', goal:4,    unit:'门', step:1,  kind:'list',
   items:['数据结构','计算机组成','计算机网络','操作系统']}
];
const freshTracks=function(){
  const o={};
  TRACKS.forEach(function(t){o[t.k]=0;});
  return o;
};

const need=lv=>100+(lv-1)*60;
function lvOf(xp){let lv=1,r=xp;while(r>=need(lv)){r-=need(lv);lv++;}return{lv,rem:r,need:need(lv)};}
const cat=k=>CATS.find(c=>c.k===k)||CATS[0];
const pad2=n=>String(n).padStart(2,'0');
function dayOf(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
const day=(date=new Date())=>Model.businessDay(date,S?.settings?.dayStart??0);
const hm=ts=>{const d=new Date(ts);return pad2(d.getHours())+':'+pad2(d.getMinutes());};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function defaultCds(){
  const t=new Date();t.setHours(0,0,0,0);
  let e=nthSat(t.getFullYear(),12,3);
  if(!e||e<t)e=nthSat(t.getFullYear()+1,12,3);
  return [{id:'cet4',n:'四级（待核对）',date:dayOf(e),provisional:true}];
}

/* 新建任务时带上 added:算「多久没做」要用它,不能拿整个 App 的年龄当基准 */
const freshTasks=function(){
  const d=Model.businessDay(new Date(),S?.settings?.dayStart??4);
  return DEFAULT_TASKS.map(t=>({...t,added:d,repeat:t.repeat||(t.wd?'weekly':'daily'),paused:false}));
};

function blank(){
  const a={};
  CATS.forEach(c=>{a[c.k]=0;});
  return {attr:a,log:[],days:{},tasks:freshTasks(),
          cds:defaultCds(),focus:{},sound:true,tracks:freshTracks(),created:Date.now(),tv:TASK_SET,
          settings:{name:'',dayStart:4},restDays:[]};
}

/* 老存档升级。只动任务表:旧默认任务整批换成新版,用户自己加的那些留下,
   打卡历史(log / days / attr)一条不改。升级前把原始 JSON 存一份到
   liferpg.v1.bak,只存第一次的,后面再升级不会覆盖它。 */
function normalize(raw){
  return Model.normalizeState(raw,{cats:CATS,defaultTasks:freshTasks(),tracks:TRACKS,
    defaultCds:defaultCds(),taskVersion:TASK_SET});
}

/* 造一份可看的假数据:近 40 天里留两段空档,今天已经打了 5 条卡。
   完全是确定性的,所以每次进演示模式看到的样子一样。 */
function demoState(){
  const s=blank();
  const now=new Date();now.setHours(0,0,0,0);
  const skip=[3,4,5,6,17];
  const T=DEMO_TASKS.slice().sort((a,b)=>b.xp-a.xp);   // 经验高的排前面,每天轮着取
  const HOLD={math_block:[0,1,2,3]};                    // 这几天故意不做数学,好让「今日主线」有话说
  s.tasks=DEMO_TASKS.map(function(t){
    return Object.assign({},t,{added:dayOf(new Date(now.getTime()-40*86400000))});
  });
  for(let i=39;i>=0;i--){
    if(skip.indexOf(i)>=0)continue;
    const d=new Date(now.getTime());d.setDate(now.getDate()-i);
    const k=dayOf(d);
    const n=(i%3===0)?6:((i%3===1)?4:5);
    s.days[k]={n:0,xp:0};
    for(let j=0;j<n;j++){
      const t=T[(i*2+j+2)%T.length];
      if(HOLD[t.id]&&HOLD[t.id].indexOf(i)>=0)continue;
      s.days[k].n++;
      s.days[k].xp+=t.xp;
      s.attr[t.c]+=t.xp;
      const hh=6+j*2;
      s.log.push({d:k,tm:pad2(hh)+':'+pad2((i*7+j*13)%60),
                  id:t.id,n:t.n,c:t.c,xp:t.xp,ts:d.getTime()+hh*3600000});
    }
  }
  s.created=now.getTime()-40*86400000;
  s.tracks={vocab:1240,paper:2,math:3,cs:1};
  return s;
}

S=(function(){
  try{
    if(DEMO)return normalize(demoState());
    const r=localStorage.getItem(KEY);
    persistedRaw=r;
    if(!r)return normalize(blank());
    const o=normalize(JSON.parse(r));
    // Preserve the original bytes before persisting any migration, without uploading.
    try{
      if(!localStorage.getItem(KEY+'.migration-v3'))localStorage.setItem(KEY+'.migration-v3',r);
      persistedRaw=JSON.stringify(o);localStorage.setItem(KEY,persistedRaw);
    }catch{persistedRaw=r;startupWarning='存储不可用：迁移结果尚未保存，请先导出备份。';}
    return o;
  }catch(e){storageBlocked=true;startupWarning='原存档无法读取，原始内容已保留。请导入有效备份或恢复上一次存档；当前操作不会覆盖它。';return normalize(blank());}
})();

function setSaveWarning(message){
  const el=document.getElementById('saveWarning');el.textContent=message||'';el.hidden=!message;
  document.getElementById('storageState').textContent=message?'有未保存或待恢复的数据':'本机存档正常';
}
function save({sync=true}={}){
  Model.rebuildStats(S,CATS);
  if(DEMO)return true;
  if(storageBlocked){setSaveWarning(startupWarning);return false;}
  try{
    if(localStorage.getItem(KEY)!==persistedRaw){
      storageBlocked=true;startupWarning='另一页面已经更新存档。为保护新记录，当前页面已停止写入；请刷新后继续。';
      syncClient?.stop();setSaveWarning(startupWarning);return false;
    }
    const raw=JSON.stringify(S);localStorage.setItem(KEY,raw);persistedRaw=raw;startupWarning='';setSaveWarning('');if(sync)scheduleSync();return true;
  }
  catch{setSaveWarning('本机保存失败，当前改动尚未保存。请导出备份，再检查浏览器存储空间。');return false;}
}
function installState(raw,label='导入',{keepSync=false}={}){
  if(DEMO)return false;
  try{
    const candidate=normalize(raw),text=JSON.stringify(candidate),current=localStorage.getItem(KEY);
    if(current){let valid=true;try{normalize(JSON.parse(current));}catch{valid=false;}
      localStorage.setItem(KEY+(valid?'.recovery':'.corrupt'),current);}
    localStorage.setItem(KEY,text);
    persistedRaw=text;
    S=candidate;storageBlocked=false;startupWarning='';setSaveWarning('');render();
    if(!keepSync){syncClient?.stop();setupSync();}
    toast(label+'成功，原存档已保留恢复点','#37d6a0');return true;
  }catch(e){toast(label+'失败：'+e.message,'#ff6b7a');return false;}
}
const total=()=>CATS.reduce((s,c)=>s+S.attr[c.k],0);
const taskById=id=>S.tasks.find(t=>t.id===id);

function streakOf(){
  return Model.streakCount(S.days,S.restDays,day());
}

function nthSat(y,mo,n){
  let c=0;
  for(let i=1;i<=31;i++){
    const t=new Date(y,mo-1,i);
    if(t.getMonth()!==mo-1)break;
    if(t.getDay()===6&&++c===n)return t;
  }
  return null;
}
function dday(){
  const t=new Date();t.setHours(0,0,0,0);
  let e=nthSat(t.getFullYear(),12,3);
  if(!e||e<t)e=nthSat(t.getFullYear()+1,12,3);
  return Math.max(0,Math.round((e-t)/86400000));
}

function toast(txt,color,action){
  const box=document.getElementById('toast');
  const el=document.createElement('div');
  for(const child of Array.from(box.children))child.remove();
  const text=document.createElement('span');text.textContent=txt;el.appendChild(text);
  if(action){const b=document.createElement('button');b.type='button';b.textContent=action.label||'撤销';b.addEventListener('click',()=>{action.run();el.remove();});el.appendChild(b);}
  if(color)el.style.color=color;
  box.appendChild(el);
  setTimeout(()=>el.remove(),action?6000:3200);
}

/* ---------- 页面切换 ---------- */
const PAGES=['panel','tasks','today','setup'];
let page='today';
function showPage(p){
  page=p;
  PAGES.forEach(k=>{
    const el=document.getElementById('p-'+k);
    if(el)el.classList.toggle('on',k===p);
  });
  document.querySelectorAll('.tabbar button').forEach(b=>{b.classList.toggle('on',b.dataset.p===p);b.setAttribute('aria-current',b.dataset.p===p?'page':'false');});
  window.scrollTo(0,0);
  if(p==='panel'&&!heatPositioned)setTimeout(()=>{const heat=document.getElementById('heatScroll');if(heat){heat.scrollLeft=heat.scrollWidth;heatPositioned=true;}},0);
}

const achievementPlayer=AudioEngine.createAchievementPlayer();
function probeCustomSound(){achievementPlayer.probe();}
function playAchievement(){achievementPlayer.play(S.sound);}
function showLevel(level){
  const card=document.getElementById('levelCard');
  document.getElementById('levelValue').textContent='Lv '+level;
  document.getElementById('levelTitle').textContent=titleFor(level);
  card.hidden=false;document.getElementById('btnLevelClose').focus();
  if(!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)navigator.vibrate?.([30,40,60]);
}
function titleFor(level){return level>=20?'笃行者':level>=10?'破关者':level>=5?'稳步前行':level>=2?'已在路上':'初启旅程';}

function renderSound(){
  const b=document.getElementById('swSound');
  if(b)b.checked=!!S.sound;
}

/* ---------- 记录一次 ---------- */
function record(id){
  if(storageBlocked){setSaveWarning(startupWarning);return;}
  const t=taskById(id);
  if(!t){toast('任务不存在','#ff6b7a');return;}
  if(S.restDays.includes(day())){toast('今天已安排休息，取消休息后可以继续打卡');return;}
  if(doneToday(t)){toast('今天已经打过卡了','#ffd27a');return;}
  if(!Model.isTaskDue(t,day(),S.log)){toast(t.paused?'这条任务已暂停':'这条任务今天不需要做');return;}
  const before=lvOf(total()).lv,now=new Date(),uid=Model.newLogId();
  const output=page==='today'?document.getElementById('studyOutput').value.trim().slice(0,120):'';
  S.log.push({uid,d:day(),tm:hm(now),id:t.id,n:t.n,c:t.c,xp:Number(t.xp),ts:now.getTime(),output});
  const stored=save();
  document.getElementById('studyOutput').value='';
  playAchievement();render();
  toast(cat(t.c).n+' +'+t.xp+(stored?'':' · 尚未保存'),cat(t.c).c,{label:'撤销',run:()=>{if(undoLog(uid))toast('已撤销');}});
  const after=lvOf(total()).lv;if(after>before)setTimeout(()=>showLevel(after),220);
}

/* ---------- 渲染:属性 ---------- */
const HM_WEEKS=16;

function heatCells(){
  const today=new Date(day()+'T00:00:00');
  const dow=(today.getDay()+6)%7;                 // 0 = 周一
  const start=new Date(today);
  start.setDate(start.getDate()-dow-(HM_WEEKS-1)*7);
  const out=[];
  for(let i=0;i<HM_WEEKS*7;i++){
    const d=new Date(start.getTime());
    d.setDate(start.getDate()+i);
    const k=dayOf(d);
    const future=d.getTime()>today.getTime();
    out.push({k:k,future:future,xp:(!future&&S.days[k])?S.days[k].xp:0});
  }
  return out;
}

function lvlOf(xp){
  if(!xp)return 0;
  if(xp<=30)return 1;
  if(xp<=70)return 2;
  if(xp<=140)return 3;
  return 4;
}

function activeKeys(){
  return Object.keys(S.days)
    .filter(k=>S.days[k]&&S.days[k].n>0)
    .sort();
}

function longestStreak(){return Math.max(0,...activeKeys().map(k=>Model.streakCount(S.days,S.restDays,k)));}

/* 手机上 title 属性不会显示,所以格子必须点得动 */
let hmSel='';

function renderHeat(){
  const el=document.getElementById('hm');if(!el)return;
  const cells=heatCells();
  el.innerHTML=cells.map(c=>{
    const L=c.future?0:lvlOf(c.xp),rest=S.restDays.includes(c.k);
    const cls=[c.future?'f':L?'l'+L:'',c.k===hmSel?'sel':'',c.k===day()?'today':'',rest?'rest':''].join(' ');
    const label=c.k+(rest?' · 休息日':(' · '+c.xp+' XP'));
    return '<button type="button" class="'+cls+'" data-d="'+c.k+'" aria-label="'+label+'" aria-pressed="'+(c.k===hmSel)+'"'+(c.future?' disabled':'')+' title="'+label+'"></button>';
  }).join('');
  let lastMonth='';
  document.getElementById('hmMonths').innerHTML=Array.from({length:HM_WEEKS},(_,i)=>{
    const month=cells[i*7].k.slice(5,7),label=month!==lastMonth?Number(month)+'月':'';lastMonth=month;
    return '<span>'+label+'</span>';
  }).join('');
  document.getElementById('hmstat').textContent='共打卡 '+activeKeys().length+' 天 · 最长连击 '+longestStreak()+' 天（休息日可连接）';
  renderHeatDetail();
}

function renderHeatDetail(){
  const el=document.getElementById('hmdetail');
  if(!el)return;
  if(!hmSel){el.hidden=true;el.textContent='';return;}
  const d=S.days[hmSel];
  const rows=S.log.filter(function(l){return l.d===hmSel;});
  el.textContent=hmSel+((d&&d.n)
    ? (' · '+d.n+' 条记录 · +'+d.xp+' XP'+(rows.length?(' · 最后一条 '+rows[rows.length-1].tm):''))
    : (S.restDays.includes(hmSel)?' · 休息日 · 0 XP':' · 没有记录'));
  el.hidden=false;
}

function renderPanel(){
  const t=total(),p=lvOf(t);
  document.getElementById('plv').textContent=p.lv;
  document.getElementById('profileTitle').textContent=S.settings.name||'我的成长';
  document.getElementById('pxp').style.width=(p.rem/p.need*100)+'%';
  document.getElementById('pxptxt').textContent=p.rem+' / '+p.need;
  document.getElementById('ptotal').textContent='累计 '+t+' · '+titleFor(p.lv);
  document.getElementById('streak').textContent=streakOf();
  const rows=S.log.filter(l=>l.d===day());document.getElementById('todayn').textContent=rows.length;
  const trackKeys={math:['math'],eng:['vocab','paper'],cs:['cs']};
  document.getElementById('attrs').innerHTML=CATS.map(c=>{
    const xp=S.attr[c.k],a=lvOf(xp),gain=rows.filter(r=>r.c===c.k).reduce((sum,r)=>sum+r.xp,0);
    const tracks=(trackKeys[c.k]||[]).map(k=>{const tr=TRACKS.find(x=>x.k===k);return '<div class="attr-track">'+tr.n+' '+S.tracks[k]+'/'+tr.goal+tr.unit+'</div>';}).join('');
    return '<div class="card"><div class="glyph" style="color:'+c.c+'" aria-hidden="true">'+c.g+'</div>'
      +'<h3 style="color:'+c.c+'">'+c.n+'</h3><div class="cval">Lv '+a.lv+'</div>'
      +'<div class="cbar"><i style="background:'+c.c+';width:'+(a.rem/a.need*100)+'%"></i></div>'
      +'<div class="foot"><span>'+a.rem+'/'+a.need+'</span><span>'+(gain>0?'今日 +'+gain:'')+'</span></div>'+tracks+'</div>';
  }).join('');renderHeat();
}

/* ---------- 渲染:任务 ---------- */
let manage=false,editing=null;

function taskIsVisibleToday(t){return !t.paused&&(Model.isTaskDue(t,day(),S.log)||doneToday(t));}
function renderTasks(){
  const todayTasks=S.tasks.filter(taskIsVisibleToday),doneN=todayTasks.filter(doneToday).length,totalN=todayTasks.length;
  document.getElementById('btnManage').classList.toggle('on',manage);
  document.getElementById('btnManage').textContent=manage?'完成管理':'管理';
  const xp=S.log.filter(l=>l.d===day()).reduce((sum,l)=>sum+l.xp,0);
  document.getElementById('doneCard').innerHTML='<div class="dt"><b>'+doneN+'</b> / '+totalN+' 条今日任务<span>今日 +'+xp+' XP</span></div>'
    +'<div class="dbar"><i style="width:'+(totalN?doneN/totalN*100:0)+'%"></i></div>';
  const tasks=(manage?S.tasks:todayTasks).slice().sort((a,b)=>Number(doneToday(a))-Number(doneToday(b))||(a.t||'99:99').localeCompare(b.t||'99:99'));
  const box=document.getElementById('tasks');
  if(!tasks.length){box.innerHTML='<div class="empty">'+(manage?'还没有任务，点「新建」添加。':'今天没有待安排的任务。可以在管理中查看其他日期或已结项的任务。')+'</div>';return;}
  const groups=[['晨间',t=>t.t&&t.t<'12:00'],['午后',t=>t.t&&t.t>='12:00'&&t.t<'18:00'],['晚间',t=>t.t&&t.t>='18:00'],['随时',t=>!t.t]];
  const weekdays=['','一','二','三','四','五','六','日'];
  function row(t){
    const done=doneToday(t),c=cat(t.c),once=t.repeat==='once'&&S.log.some(l=>l.id===t.id);
    const state=t.paused?'已暂停':once?'已结项':t.repeat==='once'?'一次性':t.repeat==='weekly'?'每周'+(t.wd||[]).map(w=>weekdays[w]).join('、'):'每天';
    const content='<span class="task-main"><span class="name">'+esc(t.n)+'</span><span class="task-meta">'+esc([t.t,state,t.d].filter(Boolean).join(' · '))+'</span></span>'
      +'<span class="xp" style="color:'+c.c+'">'+(done?'已完成':'+'+t.xp)+'<small>'+c.n+'</small></span>';
    const attrs=' class="task'+(done?' done':'')+(t.paused?' paused':'')+'" data-id="'+esc(t.id)+'"';
    if(manage)return '<div'+attrs+'><button type="button" class="task-edit" aria-label="编辑'+esc(t.n)+'">'+content+'</button><button type="button" class="del" data-del="'+esc(t.id)+'" aria-label="删除'+esc(t.n)+'">删除</button></div>';
    return '<button type="button"'+attrs+(done?' aria-disabled="true"':'')+' aria-label="'+esc(t.n)+(done?'，今天已完成':'，完成可得'+t.xp+'经验')+'">'+content+'</button>';
  }
  box.innerHTML=groups.map(([name,filter])=>{const list=tasks.filter(filter);if(!list.length)return '';return '<section class="task-group"><h3 class="task-group-head">'+name+'<span>'+list.filter(doneToday).length+' / '+list.length+'</span></h3><div class="task-group-list">'+list.map(row).join('')+'</div></section>';}).join('');
}

function fillAttrSelect(){
  document.getElementById('fAttr').innerHTML=CATS.map(c=>'<option value="'+c.k+'">'+c.n+'</option>').join('');
}

function openForm(t){
  editing=t?t.id:null;
  document.getElementById('fName').value=t?t.n:'';
  document.getElementById('fAttr').value=t?t.c:'eng';
  document.getElementById('fXp').value=t?t.xp:20;
  document.getElementById('fTime').value=t?(t.t||''):'';
  document.getElementById('fDesc').value=t?(t.d||''):'';
  document.getElementById('fRepeat').value=t?(t.repeat||(t.wd?'weekly':'daily')):'daily';
  document.getElementById('fWeekdays').hidden=document.getElementById('fRepeat').value!=='weekly';
  document.getElementById('fPaused').checked=!!t?.paused;
  document.querySelectorAll('[name="weekday"]').forEach(el=>{el.checked=!!t?.wd?.includes(Number(el.value));});
  document.getElementById('taskForm').hidden=false;
  document.getElementById('fName').focus();
}
function closeForm(){
  editing=null;
  document.getElementById('taskForm').hidden=true;
}

/* ---------- 渲染:今天 ---------- */
function reportText(){
  const rows=S.log.filter(l=>l.d===day()),per={};rows.forEach(r=>per[r.c]=(per[r.c]||0)+r.xp);
  const gains=CATS.filter(c=>per[c.k]).map(c=>c.n+' +'+per[c.k]).join('   '),nc=nearestCd();
  return '【'+day()+' 战报】\n'+(S.restDays.includes(day())?'今天安排休息 · 0 XP\n':'记录 '+rows.length+' 次 · 今日 +'+rows.reduce((s,r)=>s+r.xp,0)+' XP\n')
    +(gains||'今天还没有学习记录')+'\nLv '+lvOf(total()).lv+' · '+titleFor(lvOf(total()).lv)+' · 连击 '+streakOf()+' 天\n'
    +rows.filter(l=>l.output).map(l=>l.n+'：'+l.output).join('\n')+(nc?'\n距'+nc.c.n+' '+nc.d+' 天':'');
}
function weeklyReportText(){
  const now=new Date(day()+'T12:00:00'),mon=new Date(now);mon.setDate(mon.getDate()-(mon.getDay()+6)%7);
  const prev=new Date(mon);prev.setDate(prev.getDate()-7);const start=dayOf(mon),prevStart=dayOf(prev);
  const prevEnd=new Date(now);prevEnd.setDate(prevEnd.getDate()-7);
  const rows=S.log.filter(l=>l.d>=start&&l.d<=day()),before=S.log.filter(l=>l.d>=prevStart&&l.d<=dayOf(prevEnd));
  const xp=rows.reduce((s,l)=>s+l.xp,0),old=before.reduce((s,l)=>s+l.xp,0),studyDays=new Set(rows.filter(l=>['math','eng','cs'].includes(l.c)).map(l=>l.d)).size;
  const per=CATS.map(c=>c.n+' +'+rows.filter(l=>l.c===c.k).reduce((s,l)=>s+l.xp,0)).join(' · ');
  return '【本周回顾 '+start+' 至 '+day()+'】\n学习日 '+studyDays+' 天 · '+rows.length+' 条记录 · '+xp+' XP\n'+per
    +'\n相对上周同期：'+(xp-old>=0?'+':'')+(xp-old)+' XP（经验衡量投入）\n'
    +'覆盖进度：'+TRACKS.map(t=>t.n+' '+S.tracks[t.k]+'/'+t.goal).join(' · ')+'\n'
    +(rows.some(l=>l.output)?'本周产出：\n'+rows.filter(l=>l.output).slice(-5).map(l=>'• '+l.output).join('\n'):'可以在打卡时选填一句产出，给下周留个线索。')
    +'\n下周只选 1–3 个重点：________';
}
function renderToday(){
  const today=day(),rows=S.log.filter(l=>l.d===today);
  document.getElementById('tl').innerHTML=rows.length?rows.slice().reverse().map(r=>{
    const c=cat(r.c);return '<div class="row"><span class="tm">'+esc(r.tm)+'</span><span class="nm">'+esc(r.n)
      +(r.output?'<span class="task-output">'+esc(r.output)+'</span>':'')+'</span><span class="g" style="color:'+c.c+'">+'+r.xp+'</span>'
      +'<button type="button" class="undo" data-uid="'+esc(r.uid)+'" aria-label="撤销'+esc(r.n)+'">撤销</button></div>';
  }).join(''):'<div class="empty">'+(S.restDays.includes(today)?'今天是休息日，好好恢复。':'从上面的主线开始，完成后会记在这里。')+'</div>';
  document.getElementById('rep').textContent=reportText();document.getElementById('weeklyRep').textContent=weeklyReportText();
  document.getElementById('icsNote').textContent=scheduled().length+' 条任务已设置时间；日历按每日、指定星期或一次性安排，并包含提醒。';
  const age=S.lastExport?Math.floor((Date.now()-S.lastExport)/86400000):null;
  document.getElementById('bknote').textContent='存档保存在本机；启用同步后也会上传到私有仓库。'+(age===null?'还没有手动导出备份。':age===0?'今天已导出备份。':'上次导出 '+age+' 天前。');
  const resting=S.restDays.includes(today),used=S.restDays.filter(d=>d.slice(0,7)===today.slice(0,7)).length;
  const btn=document.getElementById('btnRest');btn.textContent=resting?'取消今天休息':'今天休息';btn.disabled=!!S.days[today]?.n;
  document.getElementById('restNote').textContent='本月已用 '+used+' / 2 天 · 休息日不加经验，可连接已有连击。'+(rows.length?'今天已有记录，无需使用。':'');
}

/* ---------- 渲染:今日主线 / 倒计时 / 断了的 ---------- */
function lastDoneTs(id){
  let t=0;
  S.log.forEach(l=>{if(l.id===id&&l.ts>t)t=l.ts;});
  return t;
}
const doneToday=t=>S.log.some(l=>l.d===day()&&l.id===t.id);

function gapOf(t){return Model.missedOccurrences(t,day(),S.log,S.created);}
function pickFocus(excludeId){
  let best=null,score=-1;
  if(S.restDays.includes(day()))return null;
  for(const t of S.tasks){
    if(doneToday(t)||t.id===excludeId||!Model.isTaskDue(t,day(),S.log))continue;
    const value=Math.min(gapOf(t),14)*2+t.xp/10;if(value>score){score=value;best=t;}
  }
  return best;
}

function focusTask(){
  const today=day();
  if(!S.focus||S.focus.d!==today){
    const t=pickFocus(null);
    S.focus={d:today,id:t?t.id:''};
    save({sync:false});
    return t;
  }
  const t=taskById(S.focus.id);
  if(!t||doneToday(t)||!Model.isTaskDue(t,day(),S.log)||S.restDays.includes(day())){
    const n=pickFocus(null);
    S.focus={d:today,id:n?n.id:''};
    save({sync:false});
    return n;
  }
  return t;
}

function renderFocus(){
  const el=document.getElementById('focus');
  if(!el)return;
  const doneN=S.tasks.filter(taskIsVisibleToday).filter(doneToday).length;
  const t=focusTask();
  if(!t){
    el.innerHTML='<div class="ft">今日主线</div>'
      +'<div class="fn">'+(S.restDays.includes(day())?'今天安排休息':'今天的任务已完成')+'</div>'
      +'<div class="fm">'+(S.tasks.length?(doneN+' 条已打卡，接下来可以休息'):'先去「任务」页加一条')+'</div>';
    return;
  }
  const g=gapOf(t),c=cat(t.c);
  el.innerHTML='<div class="ft">今日主线</div>'
    +'<div class="fn">'+esc(t.n)+'</div>'
    +'<div class="fm">'+c.n+' +'+t.xp
      +(g>=2?(' · 已经 <b>'+g+' 次</b>待恢复'):'')
      +(t.d?(' · '+esc(t.d)):'')+'</div>'
    +'<div class="frow2">'
      +'<button class="ghost" id="focusSwap">换一条</button>'
      +'<button id="focusDo">已经完成</button>'
    +'</div>';
}

function cdDays(dstr){
  const d=new Date(dstr+'T00:00:00');d.setHours(0,0,0,0);
  const t=new Date();t.setHours(0,0,0,0);
  return Math.round((d-t)/86400000);
}
function nearestCd(){
  let best=null;
  (S.cds||[]).forEach(c=>{
    const d=cdDays(c.date);
    if(d<0)return;
    if(!best||d<best.d)best={c:c,d:d};
  });
  return best;
}
function renderCds(){
  const el=document.getElementById('cds');
  if(!el)return;
  const list=(S.cds||[]).slice().sort((a,b)=>(a.date<b.date?-1:1));
  el.innerHTML=list.map(c=>{
    const d=cdDays(c.date);
    return '<div class="cd'+((d>=0&&d<=30)?' hot':'')+'" data-cd="'+c.id+'">'
      +'<b>'+(d<0?'已过':(d+'<small>天</small>'))+'</b>'
      +'<span>'+esc(c.n)+(c.provisional?' · 请核对正式日期':'')+'</span></div>';
  }).join('')+'<div class="cd add" data-cd="">+ 添加</div>';

  const ne=nearestCd();
  const num=document.getElementById('dday'),lab=document.getElementById('ddlabel');
  if(num&&lab){
    if(ne){num.textContent=ne.d;lab.textContent='距'+ne.c.n;}
    else{num.textContent='—';lab.textContent='暂无倒计时';}
  }
}

function renderGaps(){
  const el=document.getElementById('gaps'),ti=document.getElementById('gapsTitle');
  if(!el)return;
  const rows=S.tasks.filter(t=>!doneToday(t)&&Model.isTaskDue(t,day(),S.log)).map(t=>({t:t,g:gapOf(t)}))
    .filter(x=>x.g>=2).sort((a,b)=>b.g-a.g).slice(0,6);
  if(ti)ti.textContent='待恢复'+(rows.length?(' · '+rows.length):'');
  if(!rows.length){el.innerHTML='<div class="empty">今天没有待恢复的任务</div>';return;}
  el.innerHTML=rows.map(x=>{
    const c=cat(x.t.c);
    return '<div class="gap'+(x.g>=5?' bad':'')+'">'
      +'<span class="gd" style="background:'+c.c+'"></span>'
      +'<span class="gn">'+esc(x.t.n)+'</span>'
      +'<span class="gv">'+x.g+' 天没做</span></div>';
  }).join('');
}

let cdEditing=null;
function openCdForm(c){
  cdEditing=c?c.id:null;
  document.getElementById('cdName').value=c?c.n:'';
  document.getElementById('cdDate').value=c?c.date:'';
  document.getElementById('cdDel').hidden=!c;
  document.getElementById('cdForm').hidden=false;
}
function closeCdForm(){
  cdEditing=null;
  document.getElementById('cdForm').hidden=true;
}

/* 备考覆盖量 / 章节打点 */
function renderTracks(){
  const el=document.getElementById('tracks');
  if(el){
    el.innerHTML=TRACKS.map(function(t){
      const now=Math.min(t.goal,Math.max(0,Number((S.tracks||{})[t.k])||0));
      const pct=t.goal?Math.round(now/t.goal*100):0;
      const nx=(t.kind==='list'&&now<t.goal)
        ? ('<div class="nx">下一'+t.unit+': '+esc(t.items[now])+'</div>') : '';
      return '<div class="trk">'
        +'<div class="th"><b>'+t.n+'</b><em>'+now+' / '+t.goal+' '+t.unit+'</em></div>'
        +'<div class="tb"><i style="width:'+pct+'%"></i></div>'
        +nx
        +'<div class="ops">'
          +'<button data-trk="'+t.k+'" data-d="-1">− '+t.step+'</button>'
          +'<button class="p" data-trk="'+t.k+'" data-d="1">+ '+t.step+'</button>'
        +'</div></div>';
    }).join('');
  }
  const sum=document.getElementById('trkSum');
  if(sum){
    sum.textContent='进度:'+TRACKS.map(function(t){
      const now=Math.min(t.goal,Math.max(0,Number((S.tracks||{})[t.k])||0));
      return t.n+' '+now+'/'+t.goal;
    }).join(' · ');
  }
}

function render(){
  Model.rebuildStats(S,CATS);lastRenderedDay=day();
  renderPanel();
  renderTasks();
  renderToday();
  renderFocus();
  renderCds();
  renderGaps();
  renderTracks();
  renderSound();
  renderSetup();
}

/* Every aggregate is derived from the remaining journal, never patched independently. */
function undoLog(uid){
  if(!Model.removeLog(S,uid,CATS))return false;
  save();render();return true;
}

/* ---------- 日历 ---------- */
function scheduled(){return Calendar.scheduledTasks(S.tasks).filter(t=>t.repeat!=='once'||!S.log.some(l=>l.id===t.id));}
function buildICS(){return Calendar.buildCalendar(scheduled());}

function icsBlob(){return new Blob([buildICS()],{type:'text/calendar;charset=utf-8'});}

function exportICS(){
  const n=scheduled().length;
  if(!n){toast('没有设时间的任务','#ff6b7a');return;}
  const url=URL.createObjectURL(icsBlob());
  const a=document.createElement('a');
  a.href=url;a.download='life-rpg.ics';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
  toast('已导出 '+n+' 条日程','#37d6a0');
}

async function shareICS(){
  const n=scheduled().length;
  if(!n){toast('没有设时间的任务','#ff6b7a');return;}
  try{
    const f=new File([buildICS()],'life-rpg.ics',{type:'text/calendar'});
    if(navigator.canShare&&navigator.canShare({files:[f]})){
      await navigator.share({files:[f],title:'life-rpg 日程'});
      toast('已发送','#37d6a0');
    }else{
      exportICS();
    }
  }catch(e){/* 用户取消 */}
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll('.tabbar button').forEach(b=>{
  b.addEventListener('click',()=>showPage(b.dataset.p));
});

document.getElementById('focus').addEventListener('click',function(e){
  const b=e.target.closest('button');
  if(!b)return;
  if(b.id==='focusDo'){
    const t=focusTask();
    if(t)record(t.id);
  }else if(b.id==='focusSwap'){
    const cur=(S.focus&&S.focus.id)||'';
    const n=pickFocus(cur);
    if(n){S.focus={d:day(),id:n.id};save();render();}
    else toast('没有别的未完成了','#ffd27a');
  }
});

document.getElementById('cds').addEventListener('click',function(e){
  const el=e.target.closest('[data-cd]');
  if(!el)return;
  const id=el.dataset.cd;
  openCdForm(id?(S.cds||[]).find(c=>c.id===id):null);
});
document.getElementById('btnCdAdd').addEventListener('click',function(){openCdForm(null);});
document.getElementById('cdCancel').addEventListener('click',function(){closeCdForm();});
document.getElementById('cdSave').addEventListener('click',function(){
  const n=document.getElementById('cdName').value.trim();
  const d=document.getElementById('cdDate').value;
  if(!n||!d){toast('名称和日期都要填','#ff6b7a');return;}
  if(cdEditing){
    const o=(S.cds||[]).find(c=>c.id===cdEditing);
    if(o){o.n=n;o.date=d;o.provisional=false;}
  }else{
    S.cds=S.cds||[];
    S.cds.push({id:'c'+Date.now().toString(36),n:n,date:d});
  }
  save();closeCdForm();render();toast(cdEditing?'已修改':'已添加','#37d6a0');
});
document.getElementById('cdDel').addEventListener('click',function(){
  if(!cdEditing)return;
  if(!confirm('删除这个倒计时?'))return;
  S.cds=(S.cds||[]).filter(c=>c.id!==cdEditing);
  save();closeCdForm();render();toast('已删除');
});

document.getElementById('tasks').addEventListener('click',e=>{
  const del=e.target.closest('[data-del]');
  if(del){
    const id=del.dataset.del,t=taskById(id);
    if(t&&confirm('删除任务「'+t.n+'」?历史记录不会删。')){
      S.tasks=S.tasks.filter(x=>x.id!==id);save();renderTasks();toast('已删除');
    }
    return;
  }
  const row=e.target.closest('.task');
  if(!row)return;
  if(manage)openForm(taskById(row.dataset.id));
  else record(row.dataset.id);
});

document.getElementById('btnManage').addEventListener('click',()=>{
  manage=!manage;closeForm();renderTasks();
});
document.getElementById('btnNew').addEventListener('click',()=>{
  manage=true;renderTasks();openForm(null);
});
document.getElementById('fCancel').addEventListener('click',()=>{closeForm();renderTasks();});
document.getElementById('fSave').addEventListener('click',()=>{
  const n=document.getElementById('fName').value.trim();
  if(!n){toast('先填名称','#ff6b7a');return;}
  const c=document.getElementById('fAttr').value;
  let xp=Number(document.getElementById('fXp').value);
  if(!xp||xp<1)xp=10;
  if(xp>300)xp=300;
  const t=document.getElementById('fTime').value||'';
  const d=document.getElementById('fDesc').value.trim();
  const repeat=document.getElementById('fRepeat').value;
  const wd=Array.from(document.querySelectorAll('[name="weekday"]:checked')).map(el=>Number(el.value));
  const paused=document.getElementById('fPaused').checked;
  if(repeat==='weekly'&&!wd.length){toast('每周任务至少选择一天','#ff6b7a');return;}
  if(!['daily','weekly','once'].includes(repeat)||!CATS.some(cat=>cat.k===c)||!Number.isFinite(xp))return;
  const fields={n,c,xp:Math.round(xp),t,d,repeat,paused,wd:repeat==='weekly'?wd:[]};
  if(editing){
    const o=taskById(editing);
    if(o)Object.assign(o,fields);
  }else{
    S.tasks.push({id:Model.newLogId(),...fields,added:day()});
  }
  const wasEditing=!!editing,stored=save();S.focus={};closeForm();render();toast((wasEditing?'已修改':'已添加')+(stored?'':'，尚未保存'),'#37d6a0');
});
document.getElementById('btnResetTasks').addEventListener('click',()=>{
  if(!confirm('恢复默认任务会替换自定义任务；历史记录保留。继续吗？'))return;
  S.tasks=freshTasks();S.focus={};save();render();toast('已恢复默认');
});

document.getElementById('btnCopy').addEventListener('click',function(){
  const t=reportText();
  const done=()=>toast('战报已复制','#37d6a0');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done).catch(fallback);
  }else fallback();
  function fallback(){
    const ta=document.createElement('textarea');
    ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');done();}catch(e){toast('复制失败,长按选中','#ff6b7a');}
    ta.remove();
  }
});

document.getElementById('btnIcsShare').addEventListener('click',shareICS);
document.getElementById('btnIcsDown').addEventListener('click',exportICS);

/* ---------- GitHub 同步 ---------- */


/* 设置页:折叠分组 + 每行右侧摘要。折叠状态记在 localStorage,下次进来还是原样。 */
const SETUP_KEY='liferpg.setup';
let setupOpen={};
try{ setupOpen=JSON.parse(localStorage.getItem(SETUP_KEY)||'{}')||{}; }catch(e){ setupOpen={}; }


function toggleSec(k){
  setupOpen[k]=!setupOpen[k];
  const c=document.querySelector('.setcard[data-sec="'+k+'"]');
  if(c){c.classList.toggle('open',!!setupOpen[k]);c.querySelector('.setrow')?.setAttribute('aria-expanded',String(!!setupOpen[k]));const body=c.querySelector('.setbody');if(body)body.hidden=!setupOpen[k];}
  if(!DEMO){ try{ localStorage.setItem(SETUP_KEY,JSON.stringify(setupOpen)); }catch(e){} }
}

function applySetupOpen(){
  document.querySelectorAll('.setcard[data-sec]').forEach(function(c){
    c.classList.toggle('open',!!setupOpen[c.dataset.sec]);
    const row=c.querySelector('.setrow');
    const body=c.querySelector('.setbody');if(body)body.hidden=!setupOpen[c.dataset.sec];
    row?.setAttribute('aria-expanded',String(!!setupOpen[c.dataset.sec]));
    if(row&&!row.dataset.bound){
      row.dataset.bound='1';
      row.addEventListener('click',function(){ toggleSec(c.dataset.sec); });
    }
  });
}

function renderSetup(){
  for(const [id,value] of [['profileName',S.settings.name],['dayStart',S.settings.dayStart]]){
    const input=document.getElementById(id);if(document.activeElement!==input)input.value=String(value);
  }
  const vS=document.getElementById('vSync');
  if(vS){
    const hasTok=!!String(syncCfg().token||'').trim();
    let s='未设置';
    if(hasTok)s=({error:'同步失败',conflict:'需要处理冲突',pending:'有待同步的更改',syncing:'同步中',success:'已同步',idle:'已设置'})[syncKind]||'已设置';
    vS.textContent=s;
  }
  const vC=document.getElementById('vCal');
  if(vC){
    const n=scheduled().length;
    vC.textContent=n?(n+' 条可导出'):'未设时间';
  }
  const vD=document.getElementById('vData');
  if(vD){
    if(!S.lastExport)vD.textContent='还没备份';
    else{
      const dd=Math.floor((Date.now()-S.lastExport)/86400000);
      vD.textContent=(dd<=0)?'今天备份过':(dd+' 天前备份');
    }
  }
  const vM=document.getElementById('vDemo');
  if(vM)vM.textContent=DEMO?'开':'关';
}

/* 手动更新。iOS 会把 Service Worker 的自动更新检查拖到最长一天一次,
   所以给一个按钮:主动 reg.update() → 等新 SW 接管 → 再刷新。
   右侧显示当前缓存的构建时间,刷新前后对一眼就知道有没有真的换到新版。 */
function fmtBuild(k){
  const m=/^liferpg-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(k||'');
  return m?(m[1]+'-'+m[2]+'-'+m[3]+' '+m[4]+':'+m[5]):'';
}

async function renderVer(){
  const v=document.getElementById('vVer');
  if(!v)return;
  try{
    if(typeof caches==='undefined'){v.textContent='无缓存';return;}
    const ks=await caches.keys();
    const mine=ks.filter(function(k){return k.indexOf('liferpg-')===0;}).sort();
    v.textContent=mine.length?(fmtBuild(mine[mine.length-1])||'已缓存'):'无缓存';
  }catch(e){v.textContent='—';}
}

async function forceUpdate(){
  const row=document.getElementById('btnUpdate'),v=document.getElementById('vVer');
  if(!DEMO&&JSON.stringify(S)!==persistedRaw&&!save()){toast('请先导出未保存的记录，再更新应用');return;}
  row.disabled=true;v.textContent='检查更新…';
  try{
    if(!navigator.serviceWorker){toast('此浏览器不支持离线更新');return;}
    const reg=await navigator.serviceWorker.getRegistration();
    if(!reg){location.reload();return;}
    await reg.update();
    const worker=reg.installing;
    if(worker&&worker.state!=='installed'&&worker.state!=='activated'){
      await new Promise((resolve,reject)=>{
        const finish=()=>{if(worker.state==='installed'||worker.state==='activated'){clearTimeout(timer);worker.removeEventListener('statechange',change);resolve();}
          else if(worker.state==='redundant'){clearTimeout(timer);worker.removeEventListener('statechange',change);reject(new Error('新版本安装失败，当前版本仍可使用'));}};
        const change=()=>finish();
        const timer=setTimeout(()=>{worker.removeEventListener('statechange',change);reject(new Error('更新尚未完成，请稍后再试'));},15000);
        worker.addEventListener('statechange',change);finish();
      });
    }
    if(!reg.waiting){toast('当前已是可用的最新版本');return;}
    if(!DEMO&&JSON.stringify(S)!==persistedRaw&&!save()){toast('记录尚未保存，请先导出备份');return;}
    await new Promise((resolve,reject)=>{
      const change=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',change);resolve();};
      const timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',change);reject(new Error('新版本尚未接管，请稍后再试'));},10000);
      navigator.serviceWorker.addEventListener('controllerchange',change);reg.waiting.postMessage({type:'SKIP_WAITING'});
    });
    location.reload();
  }catch(e){toast(e.message||'检查更新失败，请联网后重试','#ff6b7a');}
  finally{row.disabled=false;renderVer();}
}

function syncState(message,color){syncStat=message;const el=document.getElementById('syncNote');el.textContent=message;el.style.color=color||'var(--dim)';renderSetup();}
function setupSync(){
  syncClient?.stop();syncClient=null;if(DEMO||!syncCfg().token)return;
  let instanceConfig={...syncCfg()};
  syncClient=createGitHubSync({repo:SYNC_REPO,path:SYNC_PATH,getConfig:()=>instanceConfig,
    getSnapshot:()=>{if(storageBlocked||localStorage.getItem(KEY)!==persistedRaw)throw new Error('Local state changed');Model.rebuildStats(S,CATS);return JSON.parse(JSON.stringify(S));},
    saveConfig:c=>{localStorage.setItem(SYNC_KEY,JSON.stringify(c));instanceConfig={...c};},
    onStatus:s=>{syncKind=s.kind;syncState(s.message,s.kind==='error'||s.kind==='conflict'?'#ff6b7a':s.kind==='success'?'#37d6a0':'var(--dim)');}});
}
function scheduleSync(){if(!DEMO&&!storageBlocked)syncClient?.schedule();}
function pushSync(manual=false,overwrite=false){
  if(DEMO)return Promise.resolve(false);
  if(storageBlocked){setSaveWarning(startupWarning);return Promise.resolve(false);}
  if(!syncClient)setupSync();
  if(!syncClient){if(manual)syncState('请先设置 GitHub token');return Promise.resolve(false);}
  return syncClient.pushNow({overwrite});
}
const tok=document.getElementById('syncTok');
setupSync();syncState(syncCfg().token?'已设置同步；需要恢复时先选择「从云端恢复」':'未设置同步');
tok.addEventListener('change',()=>{
  const value=tok.value.trim();tok.value='';syncClient?.stop();syncClient=null;
  try{if(value)localStorage.setItem(SYNC_KEY,JSON.stringify({token:value}));else localStorage.removeItem(SYNC_KEY);
    setupSync();syncState(value?'已设置；可同步本机记录或从云端恢复':'已停用，存档不再上传');
  }catch{syncState('同步设置无法保存，请检查浏览器存储','#ff6b7a');}
});
document.getElementById('btnSync').addEventListener('click',()=>pushSync(true));
document.getElementById('btnSyncOff').addEventListener('click',()=>{
  syncClient?.stop();syncClient=null;tok.value='';
  try{localStorage.removeItem(SYNC_KEY);syncState('已停用，存档不再上传');}catch{syncState('本次已暂停同步，令牌未能从本机删除','#ff6b7a');}
});
document.getElementById('btnRestore').addEventListener('click',async()=>{
  if(DEMO)return;if(!syncClient)setupSync();if(!syncClient){syncState('请先设置 GitHub token');return;}
  const client=syncClient,remote=await client.download();if(!remote||client!==syncClient)return;
  try{const candidate=normalize(remote.state);
    if(!confirm('用云端的 '+candidate.log.length+' 条记录恢复本机？本机现存档会先保留一个恢复点。')){syncState('已取消恢复，云端未改动；需要上传时请手动同步');return;}
    if(installState(candidate,'云端恢复',{keepSync:true})&&client.acceptRemote(remote.sha)){syncState('已从云端恢复 '+candidate.log.length+' 条记录','#37d6a0');}
  }catch(e){syncState('云端存档无效，未替换本机：'+e.message,'#ff6b7a');}
});
document.getElementById('btnOverwrite').addEventListener('click',()=>{
  if(!DEMO&&confirm('确认用本机的 '+S.log.length+' 条记录覆盖云端？其他设备的更新可能被替换；建议先导出两边的备份。'))pushSync(true,true);
});

document.getElementById('btnExp').addEventListener('click',()=>{
  if(DEMO)return;
  const b=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
  const u=URL.createObjectURL(b),a=document.createElement('a');
  a.href=u;a.download='life-rpg-'+day()+'.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(u),3000);
  S.lastExport=Date.now();save();renderToday();
  toast('已导出备份','#37d6a0');
});

document.getElementById('btnImport').addEventListener('click',()=>document.getElementById('fileImp').click());
document.getElementById('fileImp').addEventListener('change',e=>{
  if(DEMO)return;
  const file=e.target.files?.[0];if(!file)return;
  if(file.size>5*1024*1024){toast('备份超过 5 MB，请先检查文件');e.target.value='';return;}
  const reader=new FileReader();
  reader.onload=()=>{try{const raw=JSON.parse(reader.result);
    // Validate before showing the replacement confirmation; never mutate S on failure.
    normalize(raw);
    if(confirm('导入将替换当前存档，并保留一个本机恢复点。继续吗？'))installState(raw,'导入');
  }catch(err){toast('备份无效，当前存档未改变：'+err.message,'#ff6b7a');}};
  reader.onerror=()=>toast('读取失败，当前存档未改变','#ff6b7a');
  reader.readAsText(file);e.target.value='';
});
document.getElementById('btnRecovery').addEventListener('click',()=>{
  if(DEMO)return;
  try{const raw=localStorage.getItem(KEY+'.recovery')||localStorage.getItem(KEY+'.migration-v3');
    if(!raw){toast('还没有本机恢复点，可以导入 JSON 备份或从云端恢复');return;}
    const state=normalize(JSON.parse(raw));
    if(confirm('恢复到保存了 '+state.log.length+' 条记录的本机恢复点？当前存档会成为新的恢复点。'))installState(state,'本机恢复');
  }catch(e){toast('恢复点无法读取：'+e.message,'#ff6b7a');}
});
document.getElementById('btnProfileSave').addEventListener('click',()=>{
  const name=document.getElementById('profileName').value.trim().slice(0,20),cut=Number(document.getElementById('dayStart').value);
  if(!Number.isInteger(cut)||cut<0||cut>6){toast('请选择 0 到 6 点之间的日切时间');return;}
  try{const candidate=normalize({...S,settings:{...S.settings,name,dayStart:cut},focus:{}});S=candidate;}
  catch(e){toast('当前记录与这个日切设置不兼容，设置未改变：'+e.message,'#ff6b7a');return;}
  const stored=save();render();toast(stored?'设置已保存':'设置尚未保存');
});
document.getElementById('btnRest').addEventListener('click',()=>{
  const today=day();
  try{if(S.restDays.includes(today))S.restDays=S.restDays.filter(d=>d!==today);else Model.addRestDay(S,today);
    S.focus={};const stored=save();render();toast(stored?(S.restDays.includes(today)?'今天好好休息':'已取消今天休息'):'休息安排尚未保存');
  }catch(e){toast(e.message,'#ff6b7a');}
});
document.getElementById('btnPersist').addEventListener('click',async()=>{
  if(DEMO)return;
  if(!navigator.storage?.persist){toast('此浏览器不支持存储保护，请定期导出备份');return;}
  try{const granted=await navigator.storage.persist();document.getElementById('storageState').textContent=granted?'已获得持久存储权限；仍建议定期导出备份。':'浏览器未授予持久存储权限；请定期导出备份。';}
  catch{toast('暂时无法申请存储保护，请定期导出备份');}
});
document.getElementById('fRepeat').addEventListener('change',()=>{document.getElementById('fWeekdays').hidden=document.getElementById('fRepeat').value!=='weekly';});
document.getElementById('btnWeeklyCopy').addEventListener('click',async()=>{
  try{if(!navigator.clipboard?.writeText){toast('此浏览器无法自动复制，可以长按周回顾选中文字');return;}await navigator.clipboard.writeText(weeklyReportText());toast('周回顾已复制');}catch{toast('复制失败，可以长按选中文字');}
});
function closeLevel(){document.getElementById('levelCard').hidden=true;document.querySelector('.tabbar button.on')?.focus();}
document.getElementById('btnLevelClose').addEventListener('click',closeLevel);
document.getElementById('levelCard').addEventListener('keydown',e=>{if(e.key==='Escape')closeLevel();if(e.key==='Tab'){e.preventDefault();document.getElementById('btnLevelClose').focus();}});


document.getElementById('btnRst').addEventListener('click',()=>{
  if(!confirm('清空全部进度(含任务列表)?建议先导出备份。'))return;
  installState(blank(),'重置');
});

/* ---------- 启动 ---------- */
fillAttrSelect();
probeCustomSound();
applySetupOpen();
renderVer();
let todayOpen={};try{todayOpen=JSON.parse(localStorage.getItem(DEMO?'liferpg.demo.today':'liferpg.today')||'{}');}catch{}
document.querySelectorAll('details[data-today]').forEach(el=>{
  el.open=!!todayOpen[el.dataset.today];
  el.addEventListener('toggle',()=>{todayOpen[el.dataset.today]=el.open;if(!DEMO)try{localStorage.setItem('liferpg.today',JSON.stringify(todayOpen));}catch{}});
});

if(DEMO){
  document.getElementById('demobar').hidden=false;
  document.getElementById('dataTools').hidden=true;
  document.getElementById('bknote').hidden=true;
  ['btnRecovery','btnPersist','btnRestore','btnOverwrite','btnSync','btnSyncOff','syncTok','btnRst'].forEach(id=>document.getElementById(id).disabled=true);
  document.getElementById('btnDemo').textContent='退出演示';
  if(DEMO_LOCK){
    document.getElementById('demobarLink').hidden=true;
    document.getElementById('demobarHint').hidden=false;
    document.getElementById('demoBlock').hidden=true;
  }
}
document.getElementById('btnDemo').addEventListener('click',function(){
  location.href=DEMO?'./':'?demo=1';
});
document.getElementById('btnDemoLock').addEventListener('click',function(){
  // replace 而不是 href:把真实 App 那条历史记录顶掉,返回键就回不到真实数据
  location.replace('?demo=1&lock=1');
});
document.getElementById('swSound').addEventListener('change',function(e){
  S.sound=!!(e&&e.target?e.target.checked:!S.sound);
  save();renderSound();
  if(S.sound)playAchievement();
});
document.getElementById('btnUpdate').addEventListener('click',forceUpdate);
document.getElementById('tl').addEventListener('click',function(e){
  const b=e.target.closest('.undo');
  if(!b)return;
  const uid=b.dataset.uid;
  const l=S.log.find(row=>row.uid===uid);
  if(!l)return;
  if(!confirm('撤销「'+l.n+'」这一条?会退回 '+l.xp+' 经验。'))return;
  const nm=l.n;
  undoLog(uid);
  toast('已撤销 '+nm);
});
document.getElementById('hm').addEventListener('click',function(e){
  const c=e.target.closest('[data-d]');
  if(!c)return;
  hmSel=(hmSel===c.dataset.d)?'':c.dataset.d;
  renderHeat();
});
document.getElementById('tracks').addEventListener('click',function(e){
  const b=e.target.closest('[data-trk]');
  if(!b)return;
  const t=TRACKS.filter(function(x){return x.k===b.dataset.trk;})[0];
  if(!t)return;
  const dir=Number(b.dataset.d);
  S.tracks=S.tracks||freshTracks();
  const cur=Number(S.tracks[t.k]||0);
  let next=cur+dir*t.step;
  if(next<0)next=0;
  if(next>t.goal)next=t.goal;
  if(next===cur){toast(dir>0?'已经到目标了':'已经是最低了','#ffd27a');return;}
  S.tracks[t.k]=next;
  save();render();scheduleSync();
  toast(t.n+' '+(dir>0?'+':'−')+Math.abs(next-cur),'#4f8cff');
});
document.getElementById('btnShare').addEventListener('click',function(){
  const t=reportText();
  if(typeof navigator!=='undefined'&&navigator.share){
    navigator.share({title:'今日战报',text:t}).catch(function(){});
  }else{
    toast('这台设备不支持分享','#ff6b7a');
  }
});

showPage(page);
render();
if(startupWarning)setSaveWarning(startupWarning);
document.getElementById('fWeekdays').hidden=true;
function checkDay(){if(day()!==lastRenderedDay){S.focus={};render();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkDay();});
setInterval(checkDay,30000);
window.addEventListener('storage',e=>{
  if(DEMO)return;
  if(e.key===KEY&&e.newValue!==persistedRaw){storageBlocked=true;startupWarning='另一页面已经更新存档，请刷新后继续，避免覆盖新记录。';syncClient?.stop();setSaveWarning(startupWarning);}
  if(e.key===SYNC_KEY&&!syncCfg().token){syncClient?.stop();syncClient=null;syncState('同步已在另一页面停用');}
});

if(typeof navigator!=='undefined'&&'serviceWorker' in navigator
   &&typeof location!=='undefined'&&(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')){
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('./sw.js').then(reg=>{
      const offer=()=>{if(reg.waiting&&navigator.serviceWorker.controller)toast('应用有新版本，可以现在更新',null,{label:'更新',run:forceUpdate});};
      offer();reg.addEventListener('updatefound',()=>{reg.installing?.addEventListener('statechange',offer);});
    }).catch(()=>{});
  });
}
