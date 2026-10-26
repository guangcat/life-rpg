import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../../update.html',import.meta.url),'utf8');
function boot({supported=true,failed=false}={}){
  const button={disabled:false,textContent:'',addEventListener(_event,fn){this.click=fn;}},status={textContent:'',dataset:{}};
  let controllerChange,registered=0,updated=0,replaced=0,posted=0;
  const worker={state:failed?'redundant':'installed',addEventListener(){},removeEventListener(){},
    postMessage(){posted++;this.state='activated';service.controller=this;controllerChange();}};
  const registration={installing:failed?worker:null,waiting:failed?null:worker,update:async()=>{updated++;}};
  const service={controller:null,register:async(_path,options)=>{assert.equal(options.updateViaCache,'none');registered++;return registration;},
    addEventListener(_event,fn){controllerChange=fn;},removeEventListener(){}};
  const context={document:{getElementById:id=>id==='installUpdate'?button:status},navigator:supported?{serviceWorker:service}:{},
    isSecureContext:true,location:{replace(path){assert.equal(path,'./');replaced++;}},setTimeout(){return 1;},clearTimeout(){}};
  Object.defineProperty(context,'localStorage',{get(){throw new Error('updater must not access saves');}});
  Object.defineProperty(context,'sessionStorage',{get(){throw new Error('updater must not access saves');}});
  vm.createContext(context);vm.runInContext(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1],context);
  return {button,status,worker,registration,counts:()=>({registered,updated,replaced,posted})};
}

test('直达入口启动不操作存档或安装，点击后等待新版接管才返回应用',async()=>{
  const a=boot();assert.deepEqual(a.counts(),{registered:0,updated:0,replaced:0,posted:0});
  await a.button.click();assert.deepEqual(a.counts(),{registered:1,updated:1,replaced:1,posted:1});
});
test('直达入口不支持离线更新时给出可理解的提示，不刷新',async()=>{
  const a=boot({supported:false});await a.button.click();assert.match(a.status.textContent,/Safari|Chrome|Edge/);
  assert.equal(a.counts().replaced,0);assert.equal(a.button.disabled,false);
});
test('安装失败保留当前页面并允许重试，不激活或刷新',async()=>{
  const a=boot({failed:true});await a.button.click();assert.match(a.status.textContent,/旧版本仍可使用/);
  assert.equal(a.counts().replaced,0);assert.equal(a.counts().posted,0);assert.equal(a.button.disabled,false);
  a.registration.installing=null;a.registration.waiting=a.worker;a.worker.state='installed';await a.button.click();assert.equal(a.counts().replaced,1);
});
