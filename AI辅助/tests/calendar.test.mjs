import test from 'node:test';
import assert from 'node:assert/strict';
let Calendar={};try{Calendar=await import('../../modules/calendar.mjs');}catch{}
test('日历模块保留VALARM并按周生成，下次日期符合星期',()=>{
  assert.equal(typeof Calendar.buildCalendar,'function');
  const text=Calendar.buildCalendar([{id:'weekly',n:'周复盘',c:'intel',xp:15,t:'21:30',wd:[7],repeat:'weekly'}],new Date(2026,9,21,10));
  assert.match(text,/RRULE:FREQ=WEEKLY;BYDAY=SU/);assert.match(text,/DTSTART:20261025T213000/);
  assert.match(text,/BEGIN:VALARM/);assert.match(text,/UID:liferpg-weekly@life-rpg/);
});
test('暂停任务不导出，一次性任务不生成重复规则，转义用户文本',()=>{
  assert.equal(typeof Calendar.buildCalendar,'function');
  const text=Calendar.buildCalendar([{id:'paused',n:'暂停',t:'09:00',paused:true},{id:'once',n:'a\nb,\\c;',t:'10:00',repeat:'once'}],new Date(2026,9,21,9));
  assert.doesNotMatch(text,/暂停|RRULE/);assert.match(text,/SUMMARY:a\\nb\\,\\\\c\\;/);
});
