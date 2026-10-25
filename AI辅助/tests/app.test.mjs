import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function boot(initial = {}, failWrite = false, clock) {
  const nodes = {}, store = {...initial};
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
    URL: {createObjectURL:()=> 'blob:test',revokeObjectURL(){}}, Blob, AbortController,
    setTimeout(){return 1;}, clearTimeout(){}, setInterval(){return 1;}, clearInterval(){},
    confirm:()=>true, matchMedia:()=>({matches:true}),
    localStorage:{getItem:k=>store[k]??null, setItem(k,v){if(failWrite)throw new Error('QuotaExceededError');store[k]=String(v);},removeItem:k=>delete store[k]},
    location:{search:'',protocol:'http:',hostname:'localhost',href:'http://localhost/',reload(){}},
    navigator:{},fetch:async()=>({ok:false,status:404}),
    document:{hidden:false,body:element('body'),activeElement:null,
      getElementById:id=>nodes[id]??=(element()),createElement:element,
      querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}}};
  context.window=context;context.addEventListener=()=>{};context.scrollTo=()=>{};
  if(clock){const fixed=new Date(clock).getTime();context.Date=class extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};}
  vm.createContext(context);
  for(const [file,name] of [['state','Model'],['sync','Sync'],['audio','AudioEngine'],['calendar','Calendar']]){
    const module=fs.readFileSync(new URL('../../modules/'+file+'.mjs',import.meta.url),'utf8');
    const exports=[...module.matchAll(/export\s+(?:function|const)\s+(\w+)/g)].map(m=>m[1]);
    vm.runInContext('globalThis.'+name+'=(()=>{'+module.replace(/\bexport\s+/g,'')+';return {'+exports.join(',')+'};})()',context);
  }
  context.createGitHubSync=context.Sync.createGitHubSync;
  const src=fs.readFileSync(new URL('../../app.mjs',import.meta.url),'utf8').replace(/^import .*?;\s*$/gm,'');
  vm.runInContext(src,context,{timeout:5000});
  return {nodes,store,run:s=>vm.runInContext(s,context)};
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
