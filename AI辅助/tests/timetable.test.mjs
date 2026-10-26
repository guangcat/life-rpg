import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimetable, coursesOn, courseTime, fetchTimetable } from '../../modules/timetable.mjs';

const periods = (third = '10:20') => [
  { period: 1, start: '08:30', end: '09:15' }, { period: 2, start: '09:20', end: '10:05' },
  { period: 3, start: third, end: third === '10:20' ? '11:05' : '11:15' },
];
const course = (id, extra = {}) => ({ id, name: '合成课程', weekday: 3, periods: [1, 2],
  weeks: { start: 1, end: 15, parity: 'all' }, timeGroup: 'standard', location: '测试教室', attendanceRequired: true, ...extra });
const sample = () => ({ schemaVersion: 1, term: '测试学期', campus: '测试校区', semesterStart: null, sourceWeek: 7,
  periodTimes: { standard: periods(), practice: periods('10:30') }, courses: [course('a')], notes: ['合成数据'], sources: [{ path: 'reference/example.png', caption: '来源说明', metadata: { checked: true } }] });
const response = data => ({ ok: true, json: async () => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') }) });

test('课表标准化不改原输入，保留来源metadata且不补猜开学日期', () => {
  const raw = sample(), before = structuredClone(raw), result = normalizeTimetable(raw);
  assert.deepEqual(raw, before); assert.notEqual(result, raw); assert.deepEqual(result.sources, raw.sources); assert.equal(result.semesterStart, null);
});
test('拒绝无效日期、星期、周次、节次、作息时间和免听字段', () => {
  for (const change of [s => s.semesterStart = '2026-02-30', s => s.courses[0].weekday = 0,
    s => s.courses[0].weeks.end = 0, s => s.courses[0].weeks.parity = 'both', s => s.courses[0].periods = [4],
    s => s.courses[0].periods = [1, 1], s => s.periodTimes.standard[0].end = '08:00',
    s => s.periodTimes.standard[0].start = '25:00', s => s.courses[0].attendanceRequired = 'false']) {
    const raw = sample(); change(raw); assert.throws(() => normalizeTimetable(raw), TypeError);
  }
});
test('未知周次只提供星期参考，不按来源第几周冒充当前课程', () => {
  const s = sample(); s.courses = [course('early', { weeks: { start: 1, end: 4, parity: 'all' } }), course('late', { weeks: { start: 17, end: 18, parity: 'all' } }), course('other', { weekday: 4 })];
  const before = structuredClone(s); assert.deepEqual(coursesOn(s, { weekday: 3 }).map(c => c.id), ['early', 'late']); assert.deepEqual(s, before);
});
test('已知周次按范围与单双周过滤', () => {
  const s = sample(); s.courses = [course('odd', { weeks: { start: 1, end: 15, parity: 'odd' } }), course('even', { weeks: { start: 2, end: 14, parity: 'even' } })];
  assert.deepEqual(coursesOn(s, { weekday: 3, week: 7 }).map(c => c.id), ['odd']);
  assert.deepEqual(coursesOn(s, { weekday: 3, week: 8 }).map(c => c.id), ['even']); assert.deepEqual(coursesOn(s, { weekday: 3, week: 16 }), []);
});
test('免听课程默认不作为需到课课程，参考模式可保留显示', () => {
  const s = sample(); s.courses.push(course('exempt', { attendanceRequired: false }));
  assert.deepEqual(coursesOn(s, { weekday: 3 }).map(c => c.id), ['a']); assert.equal(coursesOn(s, { weekday: 3, week: 7, includeExempt: true }).length, 2);
});
test('上课时间按课程分组与首末节次选择，不混用校区作息', () => {
  const s = normalizeTimetable(sample()); const a = course('standard', { periods: [3] }), b = course('practice', { periods: [3], timeGroup: 'practice' });
  assert.deepEqual(courseTime(s, a), { start: '10:20', end: '11:05' }); assert.deepEqual(courseTime(s, b), { start: '10:30', end: '11:15' });
  assert.deepEqual(courseTime(s, course('block')), { start: '08:30', end: '10:05' });
});
test('私有课表仅GET固定路径，令牌只进请求头并传递取消信号', async () => {
  const token = 'synthetic-secret', signal = new AbortController().signal; let requested;
  const result = await fetchTimetable({ repo: 'example/private-data', token, signal, fetchImpl: async (url, options) => { requested = { url, options }; return response(sample()); } });
  assert.equal(result.term, '测试学期'); assert.equal(requested.url, 'https://api.github.com/repos/example/private-data/contents/timetable.json');
  assert.equal(requested.options.method, 'GET'); assert.equal(requested.options.signal, signal); assert.equal(requested.options.headers.Authorization, 'Bearer ' + token); assert.equal(requested.url.includes(token), false);
});
test('坏Base64、UTF8、JSON及结构均安全失败，不回显内容或令牌', async () => {
  const token = 'synthetic-secret';
  for (const content of ['bad!', Buffer.from([0xff]).toString('base64'), Buffer.from('{bad json').toString('base64'), Buffer.from('{}').toString('base64')]) {
    await assert.rejects(fetchTimetable({ repo: 'example/data', token, fetchImpl: async () => ({ ok: true, json: async () => ({ encoding: 'base64', content }) }) }), error => /课表格式/.test(error.message) && !error.message.includes(token));
  }
});
test('网络和权限错误不泄露令牌，取消原因保持可识别', async () => {
  const options = { repo: 'example/data', token: 'synthetic-secret' };
  await assert.rejects(fetchTimetable({ ...options, fetchImpl: async () => { throw Error(options.token); } }), error => !error.message.includes(options.token));
  await assert.rejects(fetchTimetable({ ...options, fetchImpl: async () => ({ ok: false, status: 404 }) }), /连接权限/);
  const aborted = new DOMException('取消', 'AbortError'); await assert.rejects(fetchTimetable({ ...options, fetchImpl: async () => { throw aborted; } }), error => error === aborted);
});
