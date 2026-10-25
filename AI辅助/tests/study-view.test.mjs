import test from 'node:test';
import assert from 'node:assert/strict';
import { radarMarkup, bossMarkup } from '../../modules/study-view.mjs';

const cats = ['数学', '英语', '专业', '毕业', '体力', '情报'].map((n, i) => ({
  k: String(i), n, c: '#4f8cff'
}));
const metrics = (overrides = {}) => ({
  date: '2026-12-12', daysLeft: 48, expired: false,
  vocab: { value: 650, goal: 2000, remaining: 1350, perDay: 29 },
  paper: { value: 1, goal: 5, remaining: 4 }, coverage: .2625, hp: 74,
  ...overrides
});

test('radar shows six named attribute levels using the supplied XP-to-level function', () => {
  const attributes = { '0': 500, '1': 250 };
  const original = structuredClone(attributes);
  const html = radarMarkup(cats, attributes, xp => ({ lv: Math.floor(xp / 100) + 1 }));
  assert.equal((html.match(/<text /g) || []).length, 6);
  assert.match(html, /数学 6<\/text>/);
  assert.match(html, /英语 3<\/text>/);
  assert.match(html, /情报 1<\/text>/);
  assert.match(html, /font-size="12\.5"/);
  assert.match(html, /role="img" aria-label="六项属性雷达图：/);
  assert.match(html, /经验反映投入，不能代表考试掌握程度/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  assert.deepEqual(attributes, original);
});

test('radar escapes text and rejects attribute colors that could inject SVG markup', () => {
  const unsafe = [{ k: 'eng', n: '<script>alert("x")</script>', c: '#fff" onload="alert(1)' }];
  const html = radarMarkup(unsafe, {}, () => ({ lv: 1 }));
  assert.doesNotMatch(html, /<script|onload=/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /fill="#ffcf5c"/);
});

test('Boss renders recorded totals, equal-weight coverage, remaining HP and vocabulary pace', () => {
  const input = metrics();
  const original = structuredClone(input);
  const html = bossMarkup(input, '大学英语四级考试');
  assert.match(html, /650 \/ 2000/);
  assert.match(html, /1 \/ 5/);
  assert.match(html, /两项平均覆盖量 <b>26%/);
  assert.match(html, /剩余血量 <b>74%/);
  assert.match(html, /data-boss-hp="74"/);
  assert.match(html, /aria-valuenow="74"/);
  assert.match(html, /还有 48 天/);
  assert.match(html, /目标日期：2026-12-12/);
  assert.match(html, /29 词/);
  assert.deepEqual(input, original);
});

test('Boss explains the manual progress boundary and escapes the supplied countdown name', () => {
  const html = bossMarkup(metrics(), '<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  for (const phrase of ['学习覆盖进度（手动记录）',
    '打卡只增加XP，不自动增加词汇或真题进度',
    'Boss血量仅根据已记录词汇/真题覆盖量计算']) {
    assert.ok(html.includes(phrase), phrase);
  }
});

test('exam-day vocabulary pace uses today’s full remaining amount', () => {
  const html = bossMarkup(metrics({ daysLeft: 0,
    vocab: { value: 650, goal: 2000, remaining: 1350, perDay: 1350 } }));
  assert.match(html, /就在今天/);
  assert.match(html, /今天还需记录 <b>1350 词/);
  assert.doesNotMatch(html, /\/0|NaN|Infinity/);
});

test('expired dates keep historical recorded progress and stop showing a future daily target', () => {
  const html = bossMarkup(metrics({ date: '2026-01-01', daysLeft: -3, expired: true,
    vocab: { value: 650, goal: 2000, remaining: 1350, perDay: null } }));
  assert.match(html, /目标日期：2026-01-01/);
  assert.match(html, /已过 3 天/);
  assert.match(html, /650 \/ 2000/);
  assert.match(html, /1 \/ 5/);
  assert.match(html, /已记录进度保留/);
  assert.doesNotMatch(html, /每天需记录/);
});

test('completed coverage displays zero HP and completion without a divide-by-zero pace', () => {
  const html = bossMarkup(metrics({ daysLeft: 0, coverage: 1, hp: 0,
    vocab: { value: 2000, goal: 2000, remaining: 0, perDay: 0 },
    paper: { value: 5, goal: 5, remaining: 0 } }));
  assert.match(html, /两项平均覆盖量 <b>100%/);
  assert.match(html, /data-boss-hp="0"/);
  assert.match(html, /词汇目标已记录完成/);
  assert.doesNotMatch(html, /\/0|每天需记录|NaN|Infinity|undefined/);
});

test('completed progress remains visible and explained after the target date', () => {
  const html = bossMarkup(metrics({ daysLeft: -1, expired: true, coverage: 1, hp: 0,
    vocab: { value: 2000, goal: 2000, remaining: 0, perDay: null },
    paper: { value: 5, goal: 5, remaining: 0 } }));
  assert.match(html, /已过 1 天/);
  assert.match(html, /2000 \/ 2000/);
  assert.match(html, /已记录进度保留。词汇目标已记录完成/);
  assert.doesNotMatch(html, /每天需记录|NaN|Infinity/);
});
