import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function boot(initial = {}, failWrite = false, clock) {
  const nodes = {}, store = {...initial};
  let exportedBlob;
  function element(tag = 'div') {
    return {tagName: tag.toUpperCase(), value: '', textContent: '', innerHTML: '', hidden: false,
      style: {}, dataset: {}, children: [], checked: false, disabled: false,
      classList: {values: new Set(), add(c){this.values.add(c);}, remove(c){this.values.delete(c);},
        toggle(c,v){v ??= !this.values.has(c); v ? this.values.add(c) : this.values.delete(c);}, contains(c){return this.values.has(c);}},
      listeners: {}, addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);},
      fire(k,e={}){for(const fn of this.listeners[k]??[])fn(e);},
      appendChild(c){this.children.push(c);return c;}, append(...c){this.children.push(...c);},
      setAttribute(k,v){this[k]=String(v);}, removeAttribute(k){delete this[k];},
      querySelector(){return null;}, querySelectorAll(){return [];},
      remove(){this.removed=true;}, focus(){}, select(){}, click(){this.fire('click');},
      showModal(){this.hidden=false;}, close(){this.hidden=true;}};
  }
  const context = {console, TextEncoder, TextDecoder,
    URL: {createObjectURL:blob=>{exportedBlob=blob;return 'blob:test';},revokeObjectURL(){}}, Blob, AbortController,
    setTimeout(){return 1;}, clearTimeout(){}, setInterval(){return 1;}, clearInterval(){},
    confirm:()=>true, matchMedia:()=>({matches:true}),
    localStorage:{getItem:k=>store[k]??null, setItem(k,v){if(failWrite)throw new Error('QuotaExceededError');store[k]=String(v);},removeItem:k=>delete store[k]},
    location:{search:'',protocol:'http:',hostname:'localhost',href:'http://localhost/',reload(){}},
    navigator:{},fetch:async()=>({ok:false,status:404}),
    document:{hidden:false,body:element('body'),activeElement:null,
      getElementById:id=>nodes[id]??=(element()),createElement:element,
      querySelector:()=>null,querySelectorAll:selector=>selector.includes('weekday')?Object.values(nodes).filter(el=>el.name==='weekday'&&(!selector.includes(':checked')||el.checked)):[],addEventListener(){}}};
  context.window=context;context.addEventListener=()=>{};context.scrollTo=()=>{};
  if(clock){const fixed=new Date(clock).getTime();context.Date=class extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};}
  vm.createContext(context);
  for(const [file,name] of [['state','Model'],['sync','Sync'],['audio','AudioEngine'],['calendar','Calendar'],['study','Study'],['study-view','StudyView']]){
    const module=fs.readFileSync(new URL('../../modules/'+file+'.mjs',import.meta.url),'utf8');
    const exports=[...module.matchAll(/export\s+(?:function|const)\s+(\w+)/g)].map(m=>m[1]);
    vm.runInContext('globalThis.'+name+'=(()=>{'+module.replace(/\bexport\s+/g,'')+';return {'+exports.join(',')+'};})()',context);
  }
  context.createGitHubSync=context.Sync.createGitHubSync;
  const src=fs.readFileSync(new URL('../../app.mjs',import.meta.url),'utf8').replace(/^import .*?;\s*$/gm,'');
  vm.runInContext(src,context,{timeout:5000});
  return {nodes,store,run:s=>vm.runInContext(s,context),exportText:()=>exportedBlob.text()};
}

test('冷启动进入今天页，不被上次设置页截住',async()=>{
  const a=await boot({'liferpg.ui':'setup'});assert.equal(a.run('page'),'today');
});
test('打卡日志有稳定uid，重复点击不增加经验',async()=>{
  const a=await boot();a.run('record("math_block");record("math_block")');
  assert.equal(a.run('S.log.length'),1);assert.equal(a.run('S.attr.math'),40);
  assert.equal(typeof a.run('S.log[0].uid'),'string');
});
test('撤销按uid定位，数组排序后仍撤销正确记录',async()=>{
  const a=await boot();a.run('record("math_block");record("eng_drill");var uid=S.log[0].uid;S.log.reverse();undoLog(uid)');
  assert.equal(a.run('S.attr.math'),0);assert.equal(a.run('S.attr.eng'),30);assert.equal(a.run('S.log.length'),1);
});
test('打卡反馈提供就地撤销按钮',async()=>{
  const a=await boot();a.run('record("math_block")');
  const toast=a.nodes.toast.children.at(-1);const button=toast.children.find(c=>c.tagName==='BUTTON');
  assert.ok(button);button.click();assert.equal(a.run('S.log.length'),0);
});
test('坏导入不改变当前状态或已保存内容',async()=>{
  const a=await boot();a.run('record("math_block")');const before=a.store['liferpg.v1'];
  assert.equal(a.run('installState({attr:null,log:{}},"导入")'),false);
  assert.equal(a.run('S.attr.math'),40);assert.equal(a.store['liferpg.v1'],before);
});
test('导入共用规范化并先保留当前存档恢复点',async()=>{
  const a=await boot();a.run('record("math_block");var backup=JSON.parse(JSON.stringify(S));record("eng_drill");installState(backup,"导入")');
  assert.equal(a.run('S.log.length'),1);assert.equal(JSON.parse(a.store['liferpg.v1.recovery']).log.length,2);
});
test('存储失败明确显示警告，不静默声称已保存',async()=>{
  const a=await boot({},true);a.run('record("math_block")');
  assert.equal(a.nodes.saveWarning.hidden,false);assert.match(a.nodes.saveWarning.textContent,/保存|存储/);
  assert.equal(a.store['liferpg.v1'],undefined);
});
test('损坏的启动存档保留原字节，后续打卡不能覆盖',async()=>{
  const a=await boot({'liferpg.v1':'{bad json'});a.run('record("math_block")');
  assert.equal(a.store['liferpg.v1'],'{bad json');assert.equal(a.nodes.saveWarning.hidden,false);
});
test('主线与完成率排除暂停任务，间隔天数权重有上限',async()=>{
  const a=await boot();a.run('S.tasks=[{id:"old",n:"旧",c:"math",xp:1,added:"2000-01-01",paused:true},{id:"new",n:"新",c:"eng",xp:20,added:day()}];S.focus={};renderTasks()');
  assert.equal(a.run('pickFocus(null).id'),'new');assert.match(a.nodes.doneCard.innerHTML,/1\s*条|\/\s*1/);
});
test('日切设置校验，姓名以文本呈现',async()=>{
  const a=await boot();a.nodes.profileName.value='<img onerror=x>';a.nodes.dayStart.value='4';
  a.nodes.btnProfileSave.fire('click');assert.equal(a.run('S.settings.dayStart'),4);
  assert.equal(a.nodes.profileTitle.textContent,'<img onerror=x>');
});
test('休息日不产生经验，可取消',async()=>{
  const a=await boot();a.nodes.btnRest.fire('click');assert.equal(a.run('S.log.length'),0);
  assert.equal(a.run('S.restDays.includes(day())'),true);a.nodes.btnRest.fire('click');
  assert.equal(a.run('S.restDays.includes(day())'),false);
});
test('导入的恶意任务标识不进入可执行HTML',async()=>{
  const a=await boot();assert.equal(a.run('installState({log:[],attr:{},tasks:[{id:\'x" onclick="alert(1)\',n:"x",c:"math",xp:2}]},"导入")'),false);
});
test('另一个标签页更新本机存档后，旧页面不能覆盖它',async()=>{
  const a=await boot();a.run('record("math_block")');
  const other=JSON.parse(a.store['liferpg.v1']);other.settings.name='另一页面的新存档';
  a.store['liferpg.v1']=JSON.stringify(other);const fresh=a.store['liferpg.v1'];
  a.run('record("eng_drill")');assert.equal(a.store['liferpg.v1']===fresh,true,'other tab data must be preserved');
  assert.equal(a.nodes.saveWarning.hidden,false);assert.match(a.nodes.saveWarning.textContent,/另一|其他|刷新/);
  a.nodes.btnExp.fire('click');const exported=JSON.parse(await a.exportText());
  assert.deepEqual(exported.log.map(l=>l.id),['math_block','eng_drill']);
  assert.equal(a.store['liferpg.v1'],fresh,'export must not replace the saved copy');
});
test('凌晨更改日切不能保存会导致未来休息日的无效存档',async()=>{
  const a=await boot({},false,'2026-10-25T01:00:00');
  a.run('S.settings.dayStart=0;S.restDays=[day()];save();render()');
  a.nodes.dayStart.value='4';a.nodes.btnProfileSave.fire('click');
  assert.equal(a.run('S.settings.dayStart'),0);assert.equal(JSON.parse(a.store['liferpg.v1']).settings.dayStart,0);
});
test('手动更新等待worker安装，并在接管后才刷新',async()=>{
  const a=await boot();a.run(`
    var stateHandler,controlHandler,posted=0,reloads=0;
    var installing={state:'installing',addEventListener:(event,fn)=>{stateHandler=fn;},removeEventListener(){}};
    var registration={installing,waiting:null,update:async()=>{}};
    navigator.serviceWorker={controller:{},getRegistration:async()=>registration,
      addEventListener:(event,fn)=>{controlHandler=fn;},removeEventListener(){}};
    location.reload=()=>{reloads++;};var updatePromise=forceUpdate();
  `);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(a.run('reloads'),0);
  a.run(`registration.waiting={postMessage:()=>{posted++;}};installing.state='installed';stateHandler();`);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(a.run('posted'),1);assert.equal(a.run('reloads'),0);
  a.run('controlHandler()');await a.run('updatePromise');assert.equal(a.run('reloads'),1);
});

test('新存档四级默认为2026-12-12，倒计时和配速共享4点日切',async()=>{
  const a=await boot({},false,'2026-10-26T03:59:00');
  assert.equal(a.run('S.cds.find(c=>c.id==="cet4").date'),'2026-12-12');
  assert.equal(a.run('cdDays("2026-12-12")'),48);assert.equal(a.run('dday()'),48);
  assert.equal(a.run('Study.examProgress(S,TRACKS,day()).vocab.perDay'),42);
});
test('旧存档日期、日志、经验与词汇量全部保留，不强行补新任务',async()=>{
  const old=await boot({},false,'2026-10-25T12:00:00');old.run('record("math_block")');
  const raw=JSON.parse(old.store['liferpg.v1']);raw.cds=[{id:'cet4',n:'我的四级日期',date:'2026-12-05'}];
  raw.tracks.vocab=637;raw.tv=2;raw.tasks=[{id:'os_course',n:'操作系统课程',c:'cs',xp:22,repeat:'daily',added:'2026-10-01'},
    {id:'grad_hw',n:'交作业',c:'grad',xp:15,repeat:'daily',added:'2026-10-01'},
    {id:'cs_practice',n:'408独立练习',c:'cs',xp:25,repeat:'daily',added:'2026-10-01'}];
  const a=await boot({'liferpg.v1':JSON.stringify(raw)},false,'2026-10-25T12:00:00');
  assert.equal(a.run('S.cds[0].date'),'2026-12-05');assert.equal(a.run('S.tracks.vocab'),637);
  assert.equal(a.run('JSON.stringify(S.log)'),JSON.stringify(raw.log));assert.equal(a.run('S.attr.math'),40);
  assert.equal(a.run('S.tasks.length'),3);assert.equal(a.run('taskById("grad_hw").repeat'),'daily');
  assert.equal(a.run('isOptionalTask(taskById("grad_hw"))'),true);assert.equal(a.run('isOptionalTask(taskById("cs_practice"))'),true);
  assert.equal(a.run('taskIsVisibleToday(taskById("os_course"))'),true);
});
test('新用户默认不每日要求作业、无课全勤与408，英语概率高数保留',async()=>{
  const a=await boot({},false,'2026-10-21T12:00:00');
  assert.equal(a.run('S.tasks.some(t=>t.id==="grad_hw")'),false);
  assert.equal(a.run('taskById("grad_class").paused'),true);
  assert.equal(a.run('isOptionalTask(taskById("cs_practice"))'),true);
  for(const id of ['eng_main','prob_video','math_block'])assert.equal(a.run(`taskIsVisibleToday(taskById("${id}"))`),true);
  assert.equal(a.run('S.tasks.filter(t=>taskIsVisibleToday(t)&&!isOptionalTask(t)).some(t=>["grad_class","cs_practice"].includes(t.id))'),false);
});
test('全勤按课表星期参与，周复盘严格只在周日出现',async()=>{
  const a=await boot({},false,'2026-10-21T12:00:00');
  a.run('var attendance={id:"grad_class",n:"上课",c:"grad",xp:20,repeat:"weekly",wd:[3],paused:false};');
  assert.equal(a.run('isTaskEligible(attendance,"2026-10-21")'),true);
  assert.equal(a.run('isTaskEligible(attendance,"2026-10-22")'),false);
  assert.equal(a.run('isTaskEligible({...attendance,wd:[],repeat:"daily"},"2026-10-21")'),false);
  assert.equal(a.run('isTaskEligible({...taskById("weekly"),repeat:"daily",wd:[]},"2026-10-21")'),false);
  assert.equal(a.run('isTaskEligible(taskById("weekly"),"2026-10-25")'),true);
});
test('按需任务不占完成率或主线，仍可主动打卡',async()=>{
  const a=await boot();a.run('S.tasks=[{id:"cs_practice",n:"408练习",c:"cs",xp:25,repeat:"daily",added:day()},{id:"math_block",n:"高数",c:"math",xp:40,repeat:"daily",added:day()}];S.focus={};renderTasks();');
  assert.equal(a.run('pickFocus(null).id'),'math_block');assert.match(a.nodes.doneCard.innerHTML,/\/\s*1\s*条/);
  a.run('record("cs_practice")');assert.equal(a.run('S.attr.cs'),25);
  assert.match(a.nodes.doneCard.innerHTML,/<b>0<\/b>\s*\/\s*1\s*条/);
});
test('作业通过明确入口创建一次性任务',async()=>{
  const a=await boot();a.nodes.btnHomework.fire('click');
  assert.equal(a.nodes.fRepeat.value,'once');assert.equal(a.nodes.fAttr.value,'grad');
  a.nodes.fName.value='交操作系统作业';a.nodes.fSave.fire('click');
  assert.equal(a.run('S.tasks.at(-1).repeat'),'once');assert.equal(a.run('S.tasks.at(-1).n'),'交操作系统作业');
});
test('仅保底或作息不算有效学习，原连续打卡不清零',async()=>{
  const a=await boot({},false,'2026-10-25T12:00:00');a.run('record("min_open")');
  assert.equal(a.run('studySummary().checkInDays'),1);assert.equal(a.run('studySummary().effectiveDays'),0);assert.equal(a.run('streakOf()'),1);
  assert.match(a.nodes.learningDays.textContent,/本周达标 0\/7/);a.run('record("vit_sleep")');assert.equal(a.run('studySummary().effectiveDays'),0);
  a.run('record("math_block")');assert.equal(a.run('studySummary().effectiveDays'),1);assert.match(a.nodes.learningDays.textContent,/本周达标 1\/7/);
});
test('撤销有效学习后仍保留保底打卡与其连击',async()=>{
  const a=await boot();a.run('record("min_open");record("eng_words");undoLog(S.log.find(l=>l.id==="eng_words").uid);');
  assert.equal(a.run('studySummary().effectiveDays'),0);assert.equal(a.run('studySummary().checkInDays'),1);assert.equal(a.run('streakOf()'),1);
});
test('周一4点切换周达标范围，但保留上周有效日与打卡连击',async()=>{
  const sun=await boot({},false,'2026-10-26T03:59:00');sun.run('record("math_block")');assert.equal(sun.run('studySummary().weekEffective'),1);
  const mon=await boot({'liferpg.v1':sun.store['liferpg.v1']},false,'2026-10-26T04:00:00');
  assert.equal(mon.run('studySummary().weekEffective'),0);assert.equal(mon.run('studySummary().effectiveDays'),1);assert.equal(mon.run('streakOf()'),1);
});
test('精确新增37词不增加经验或学习日志，刷新与导出导入保持累计',async()=>{
  const a=await boot();a.run('S.tracks.vocab=650;save()');const xp=a.run('total()');
  assert.equal(a.run('changeVocab(37)'),true);assert.equal(a.run('S.tracks.vocab'),687);assert.equal(a.run('total()'),xp);assert.equal(a.run('S.log.length'),0);
  a.nodes.btnExp.fire('click');const exported=await a.exportText();assert.equal(JSON.parse(exported).tracks.vocab,687);
  const b=await boot({'liferpg.v1':exported});assert.equal(b.run('S.tracks.vocab'),687);assert.equal(b.run('S.log.length'),0);
});
test('非法词数和超过剩余量的输入不会修改已有累计',async()=>{
  const a=await boot();a.run('S.tracks.vocab=1950;save()');
  for(const value of ['0','-1','1.5','NaN','Infinity','51']){assert.equal(a.run(`changeVocab(${value})`),false);assert.equal(a.run('S.tracks.vocab'),1950);}
  assert.equal(a.run('changeVocab(1)'),true);assert.equal(a.run('S.tracks.vocab'),1951);
});
test('普通背词只涨XP，Boss血量只跟实际词汇和真题记录变化',async()=>{
  const a=await boot();const before=a.run('Study.examProgress(S,TRACKS,day()).hp');a.run('record("eng_main")');
  assert.equal(a.run('S.tracks.vocab'),0);assert.equal(a.run('Study.examProgress(S,TRACKS,day()).hp'),before);
  a.run('changeVocab(200)');assert.equal(a.run('Study.examProgress(S,TRACKS,day()).hp'),95);
  a.nodes.tracks.fire('click',{target:{closest:selector=>selector==='[data-trk]'?{dataset:{trk:'paper',d:'1'}}:null}});assert.equal(a.run('Study.examProgress(S,TRACKS,day()).hp'),85);
  assert.match(a.nodes.boss.innerHTML,/手动记录/);assert.doesNotMatch(a.nodes.boss.innerHTML,/每次背词和做真题都会削减/);
});
test('到期日配速按剩余量，过期不预测，新建默认和已存日期不混用',async()=>{
  const a=await boot({},false,'2026-12-12T12:00:00');a.run('S.tracks.vocab=1700;render()');
  assert.equal(a.run('Study.examProgress(S,TRACKS,day()).daysLeft'),0);assert.equal(a.run('Study.examProgress(S,TRACKS,day()).vocab.perDay'),300);
  a.run('S.cds=[{id:"cet4",n:"已设置日期",date:"2026-12-01"}];render()');assert.equal(a.run('Study.examProgress(S,TRACKS,day()).expired'),true);assert.equal(a.run('Study.examProgress(S,TRACKS,day()).vocab.perDay'),null);
});
test('不一致的旧经验不会在启动或导入时被自动重写，原档可导出',async()=>{
  const original=JSON.stringify({attr:{math:90},log:[],tasks:[],tv:3});
  const a=await boot({'liferpg.v1':original});assert.equal(a.store['liferpg.v1'],original);assert.equal(a.run('storageBlocked'),true);
  a.nodes.btnExp.fire('click');assert.equal(await a.exportText(),original);assert.equal(a.store['liferpg.v1'],original);
  const b=await boot();const before=b.store['liferpg.v1'];assert.equal(b.run('installState({attr:{math:90},log:[],tasks:[],tv:3},"导入")'),false);assert.equal(b.store['liferpg.v1'],before);
});
test('旧系统估算日期也不静默覆盖，手动改期后Boss与词汇配速同时更新',async()=>{
  const old=await boot({},false,'2026-10-25T12:00:00');
  const raw=JSON.parse(old.store['liferpg.v1']);raw.cds=[{id:'cet4',n:'四级（待核对）',date:'2026-12-19',provisional:true}];
  const a=await boot({'liferpg.v1':JSON.stringify(raw)},false,'2026-10-25T12:00:00');
  assert.equal(a.run('S.cds[0].date'),'2026-12-19');assert.match(a.nodes.boss.innerHTML,/日期沿用已有存档/);
  a.run('openCdForm(S.cds[0])');a.nodes.cdName.value='四级';a.nodes.cdDate.value='2026-12-12';a.nodes.cdSave.fire('click');
  assert.equal(a.run('S.cds[0].date'),'2026-12-12');assert.equal(a.run('S.cds[0].provisional'),false);
  assert.equal(a.run('Study.examProgress(S,TRACKS,day()).daysLeft'),48);assert.match(a.nodes.tracks.innerHTML,/每天至少/);
});
test('历史累计超出目标只封顶展示血量，不截断或改写累计词汇',async()=>{
  const old=await boot();const raw=JSON.parse(old.store['liferpg.v1']);raw.tracks.vocab=2300;
  const a=await boot({'liferpg.v1':JSON.stringify(raw)});assert.equal(a.run('S.tracks.vocab'),2300);
  assert.match(a.nodes.tracks.innerHTML,/2300 \/ 2000/);assert.equal(a.run('Study.examProgress(S,TRACKS,day()).vocab.perDay'),0);
  assert.equal(a.run('changeVocab(1)'),false);assert.equal(JSON.parse(a.store['liferpg.v1']).tracks.vocab,2300);
  a.nodes.tracks.fire('click',{target:{closest:selector=>selector==='[data-trk]'?{dataset:{trk:'vocab',d:'-1'}}:null}});
  assert.equal(a.run('S.tracks.vocab'),2299);assert.equal(JSON.parse(a.store['liferpg.v1']).tracks.vocab,2299);
});
test('旧版按名称新增的四级日期被Boss与配速采用，编辑不另建倒计时',async()=>{
  const old=await boot({},false,'2026-10-25T12:00:00');const raw=JSON.parse(old.store['liferpg.v1']);
  raw.cds=[{id:'c123',n:'四级',date:'2027-06-12'}];
  const a=await boot({'liferpg.v1':JSON.stringify(raw)},false,'2026-10-25T12:00:00');
  assert.equal(a.run('Study.examProgress(S,TRACKS,day()).date'),'2027-06-12');assert.match(a.nodes.boss.innerHTML,/2027-06-12/);
  a.nodes.boss.fire('click',{target:{closest:()=>({id:'btnBossDate'})}});assert.equal(a.run('cdEditing'),'c123');
  a.nodes.cdName.value='四级';a.nodes.cdDate.value='2027-06-19';a.nodes.cdSave.fire('click');
  assert.equal(a.run('S.cds.length'),1);assert.equal(a.run('S.cds[0].id'),'c123');assert.equal(a.run('Study.cet4Date(S.cds)'),'2027-06-19');
});

test('今天主卡写清学习动作，不用XP与待恢复次数挤占说明',async()=>{
  const a=await boot();
  assert.match(a.nodes.focus.innerHTML,/完成并打卡/);
  assert.doesNotMatch(a.nodes.focus.innerHTML,/待恢复|\+40/);
  a.nodes.btnTodayTasks.fire('click');assert.equal(a.run('page'),'tasks');
});

test('今天保底入口可直接记录，摘要随记录与撤销更新',async()=>{
  const a=await boot();a.nodes.btnMinimum.fire('click');
  assert.equal(a.run('S.log.at(-1).id'),'min_open');
  assert.equal(a.run('studySummary().effectiveDays'),0);
  assert.match(a.nodes.todaySummary.textContent,/1/);assert.equal(a.nodes.btnMinimum.disabled,true);
  a.run('undoLog(S.log.at(-1).uid)');assert.match(a.nodes.todaySummary.textContent,/0/);assert.equal(a.nodes.btnMinimum.disabled,false);
});

test('受保护旧档仅在操作时弹窗，可关闭并导出原字节',async()=>{
  const original='{bad json',a=await boot({'liferpg.v1':original});
  assert.equal(a.nodes.saveDialog.hidden,true);
  a.run('record("math_block")');assert.equal(a.nodes.saveDialog.hidden,false);
  assert.equal(a.store['liferpg.v1'],original);assert.equal(a.run('S.log.length'),0);
  a.nodes.btnSaveClose.fire('click');assert.equal(a.nodes.saveDialog.hidden,true);
  a.run('record("math_block")');a.nodes.btnSaveExport.fire('click');
  assert.equal(await a.exportText(),original);assert.equal(a.store['liferpg.v1'],original);
});

test('实际保存失败弹窗说明未保存，进入备份设置不清除当前记录',async()=>{
  const a=await boot({},true);a.run('record("math_block")');
  assert.equal(a.nodes.saveDialog.hidden,false);assert.match(a.nodes.saveDialogMessage.textContent,/未保存|还没保存/);
  a.nodes.btnSaveSettings.fire('click');assert.equal(a.run('page'),'setup');assert.equal(a.run('S.log.length'),1);
  assert.equal(a.nodes.saveDialog.hidden,true);
});

test('今天不再展示Boss与多组进度，设置内才有存档说明',()=>{
  const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const today=html.split('id="p-today"')[1].split('id="p-panel"')[0];
  const panel=html.split('id="p-panel"')[1].split('id="p-tasks"')[0];
  assert.doesNotMatch(today,/id="boss"|data-today="(?:countdown|progress|gaps|report|weekly)"/);
  assert.match(panel,/id="boss"/);assert.match(panel,/id="tracks"/);
  assert.ok(html.indexOf('id="saveWarning"')>html.indexOf('id="p-setup"'));
});
