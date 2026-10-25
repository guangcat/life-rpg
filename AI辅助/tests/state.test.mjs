import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const state = await import('../../modules/state.mjs').catch(() => ({}));

test('state boundary exposes normalization and calendar operations', () => {
  for (const name of ['normalizeState', 'businessDay', 'deriveStats', 'rebuildStats',
    'isTaskDue', 'missedOccurrences', 'streakCount', 'addRestDay', 'removeLog', 'newLogId']) {
    assert.equal(typeof state[name], 'function', `${name} must be available`);
  }
});

const cats = [{ k: 'math' }, { k: 'eng' }];
const now = new Date(2026, 9, 25, 12).getTime();
const options = { cats, taskVersion: 3, now,
  defaultTasks: [{ id: 'daily', n: '练题', c: 'math', xp: 20 }],
  tracks: [{ k: 'chapters', goal: 5 }], defaultCds: () => [] };
const log = (overrides = {}) => ({ uid: 'log_a', id: 'daily', n: '练题',
  c: 'math', xp: 20, d: '2026-10-24', tm: '22:00',
  ts: new Date(2026, 9, 25, 2).getTime(), ...overrides });
const raw = (overrides = {}) => ({ tv: 3, created: now - 7 * 86400000,
  tasks: [{ id: 'daily', n: '练题', c: 'math', xp: 20, added: '2026-10-18' }],
  log: [], ...overrides });
const normalize = value => state.normalizeState(value, options);

test('normalization derives stale aggregates from log without changing input or historical dates', () => {
  const value = raw({ log: [log()], attr: { math: 999, eng: 5 },
    days: { '2026-10-25': { n: 100, xp: 999 } }, settings: { dayStart: 4, name: '广广' } });
  const before = structuredClone(value);
  const result = normalize(value);
  assert.deepEqual(value, before);
  assert.notEqual(result.log, value.log);
  assert.notEqual(result.tasks[0], value.tasks[0]);
  assert.deepEqual(result.attr, { math: 20, eng: 0 });
  assert.deepEqual(result.days, { '2026-10-24': { n: 1, xp: 20 } });
  assert.equal(result.log[0].d, '2026-10-24');
  assert.ok(result.migrationWarnings.length >= 1);
});

test('legacy records gain stable identities without replacing their task id', () => {
  const entry = log(); delete entry.uid;
  const result = normalize(raw({ log: [entry] }));
  assert.match(result.log[0].uid, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.log[0].id, 'daily');
  assert.equal(normalize(raw({ log: [entry] })).log[0].uid, result.log[0].uid);
  assert.equal(normalize(result).log[0].uid, result.log[0].uid);
});

test('old valid tasks survive migration and defaults are appended once by id', () => {
  const custom = { id: 'custom', n: '自定义', c: 'eng', xp: 7, added: '2026-10-01' };
  const value = raw({ tv: 1, tasks: [{ ...options.defaultTasks[0], n: '我改过的任务', xp: 8 }, custom] });
  const result = normalize(value);
  assert.equal(result.tv, 3);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].xp, 8);
  assert.equal(result.tasks[0].n, '我改过的任务');
  assert.equal(result.tasks[1].id, 'custom');
  assert.deepEqual(normalize(result).tasks, result.tasks);
  assert.equal(normalize(raw({ tv: 1, tasks: [custom] })).tasks[1].id, 'daily');
});

test('current-version empty tasks stay empty and old unscheduled tasks become daily', () => {
  assert.deepEqual(normalize(raw({ tasks: [] })).tasks, []);
  assert.equal(normalize(raw()).tasks[0].repeat, 'daily');
  assert.equal(normalize(raw({ tasks: [{ ...raw().tasks[0], wd: [7] }] })).tasks[0].repeat, 'weekly');
  assert.deepEqual(normalize({}).settings, { name: '', dayStart: 0 });
  assert.equal(normalize({}).tasks[0].added, '2026-10-25');
});

test('derived stats support string and object categories and deleted tasks in historical logs', () => {
  const entries = [log(), log({ uid: 'log_b', id: 'deleted', c: 'eng', xp: 5 })];
  assert.deepEqual(state.deriveStats(entries, ['math', 'eng']), {
    attr: { math: 20, eng: 5 }, days: { '2026-10-24': { n: 2, xp: 25 } } });
  assert.deepEqual(state.deriveStats(entries, cats), state.deriveStats(entries, ['math', 'eng']));
  assert.equal(normalize(raw({ log: entries })).log.length, 2);
  const value = { log: entries, days: {}, attr: { math: 0, eng: 0 } };
  assert.equal(state.rebuildStats(value, cats), value);
  assert.deepEqual(value.attr, { math: 20, eng: 5 });
});

for (const [name, value] of [
  ['null root', null], ['array root', []], ['null log', raw({ log: null })],
  ['object log', raw({ log: {} })], ['null task array', raw({ tasks: null })],
  ['null task', raw({ tasks: [null] })], ['duplicate tasks', raw({ tasks: [raw().tasks[0], raw().tasks[0]] })],
  ['non-finite XP', raw({ log: [log({ xp: Infinity })] })],
  ['string XP', raw({ log: [log({ xp: '20' })] })], ['negative XP', raw({ log: [log({ xp: -1 })] })],
  ['non-finite aggregate', raw({ attr: { math: NaN } })],
  ['null day aggregate', raw({ days: { '2026-10-24': null } })],
  ['bad historical date', raw({ log: [log({ d: '2026-02-30' })] })],
  ['invalid timestamp', raw({ log: [log({ ts: 1e100 })] })],
  ['duplicate uid', raw({ log: [log(), log({ d: '2026-10-23' })] })],
  ['duplicate completion', raw({ log: [log(), log({ uid: 'log_b' })] })],
  ['prototype uid', raw({ log: [log({ uid: '__proto__' })] })],
  ['dangerous task id', raw({ tasks: [{ ...raw().tasks[0], id: 'constructor' }] })],
  ['dangerous log id', raw({ log: [log({ id: '<img>' })] })],
  ['unknown category', raw({ log: [log({ c: 'unknown' })] })],
  ['invalid repeat', raw({ tasks: [{ ...raw().tasks[0], repeat: 'monthly' }] })],
  ['invalid weekly schedule', raw({ tasks: [{ ...raw().tasks[0], repeat: 'weekly', wd: [0] }] })],
  ['null countdowns', raw({ cds: null })], ['invalid countdown', raw({ cds: [{ id: 'exam', n: '考试', date: 'no' }] })],
  ['invalid tracks', raw({ tracks: { chapters: '3' } })], ['invalid settings', raw({ settings: null })],
  ['late day start', raw({ settings: { dayStart: 7 } })], ['noninteger day start', raw({ settings: { dayStart: 1.5 } })],
  ['invalid pause flag', raw({ tasks: [{ ...raw().tasks[0], paused: 'false' }] })],
  ['unsafe object key', JSON.parse('{"log":[],"tracks":{"__proto__":1}}')],
]) {
  test(`strict import rejects ${name} and leaves source unchanged`, () => {
    const before = structuredClone(value);
    assert.throws(() => normalize(value));
    assert.deepEqual(value, before);
  });
}

test('missing log with stored XP is refused while an empty legacy shell can initialize', () => {
  assert.throws(() => normalize({ attr: { math: 40, eng: 0 } }));
  assert.throws(() => normalize({ attr: { math: 0, eng: 0 } }));
  assert.deepEqual(normalize({}).log, []);
});

test('business dates honor midnight and early-morning boundaries without mutating Date', () => {
  const date = new Date(2026, 9, 25, 3, 59);
  assert.equal(state.businessDay(date, 4), '2026-10-24');
  assert.equal(state.businessDay(date, 0), '2026-10-25');
  assert.equal(date.getHours(), 3);
  assert.equal(state.businessDay(new Date(2026, 9, 25, 4), 4), '2026-10-25');
  assert.equal(state.businessDay(new Date(2027, 0, 1, 2), 4), '2026-12-31');
  assert.throws(() => state.businessDay(new Date('invalid'), 4));
  assert.throws(() => state.businessDay(date, -1));
});

test('business date uses local calendar across both DST transitions', () => {
  const moduleUrl = new URL('../../modules/state.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {businessDay} from ${JSON.stringify(moduleUrl)};
     console.log(businessDay(new Date(2026,2,8,4,30),4));
     console.log(businessDay(new Date(2026,10,1,3,30),4));`],
    { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(output.trim(), '2026-03-08\n2026-10-31');
});

test('task scheduling applies weekday, once-completed and paused rules', () => {
  const daily = { id: 'daily', repeat: 'daily', added: '2026-10-01' };
  const weekly = { ...daily, repeat: 'weekly', wd: [7] };
  assert.equal(state.isTaskDue(daily, '2026-10-25', []), true);
  assert.equal(state.isTaskDue(daily, '2026-10-24', [log()]), true);
  assert.equal(state.isTaskDue(weekly, '2026-10-24', []), false);
  assert.equal(state.isTaskDue(weekly, '2026-10-25', []), true);
  assert.equal(state.isTaskDue({ ...daily, paused: true }, '2026-10-25', []), false);
  assert.equal(state.isTaskDue({ ...daily, repeat: 'once' }, '2026-10-25', [log()]), false);
  assert.equal(state.isTaskDue({ ...daily, repeat: 'once' }, '2026-10-25', []), true);
  assert.equal(state.isTaskDue({ ...daily, added: '2026-10-26' }, '2026-10-25', []), false);
});

test('missed occurrences count past scheduled days since creation or most recent completion', () => {
  const daily = { id: 'daily', repeat: 'daily', added: '2026-10-22' };
  assert.equal(state.missedOccurrences(daily, '2026-10-25', [log()], now), 0);
  assert.equal(state.missedOccurrences(daily, '2026-10-25', [log({ d: '2026-10-23' })], now), 1);
  assert.equal(state.missedOccurrences(daily, '2026-10-25', [], now), 3);
  assert.equal(state.missedOccurrences({ ...daily, added: '2026-10-25' }, '2026-10-25', [], now), 0);
  const weekly = { ...daily, repeat: 'weekly', wd: [7], added: '2026-10-01' };
  assert.equal(state.missedOccurrences(weekly, '2026-10-24', [], now), 0);
  assert.equal(state.missedOccurrences(weekly, '2026-10-25', [log({ d: '2026-10-18' })], now), 0);
  assert.equal(state.missedOccurrences(weekly, '2026-10-25', [log({ d: '2026-10-11' })], now), 1);
  assert.equal(state.missedOccurrences({ ...daily, repeat: 'once' }, '2026-10-25', [], now), 1);
  assert.equal(state.missedOccurrences({ ...daily, paused: true }, '2026-10-25', [], now), 0);
});

test('rest days bridge learning streaks without creating or adding to them', () => {
  const days = { '2026-10-22': { n: 1 }, '2026-10-24': { n: 1 } };
  assert.equal(state.streakCount(days, ['2026-10-23'], '2026-10-25'), 2);
  assert.equal(state.streakCount(days, [], '2026-10-25'), 1);
  assert.equal(state.streakCount(days, ['2026-10-23', '2026-10-25'], '2026-10-25'), 2);
  assert.equal(state.streakCount({}, ['2026-10-23', '2026-10-24'], '2026-10-25'), 0);
});

test('imported rest days enforce monthly quota, valid dates and business-day future boundary', () => {
  assert.deepEqual(normalize(raw({ restDays: ['2026-09-01', '2026-09-02', '2026-10-01', '2026-10-02'] })).restDays,
    ['2026-09-01', '2026-09-02', '2026-10-01', '2026-10-02']);
  for (const dates of [null, ['2026-10-01', '2026-10-02', '2026-10-03'], ['2026-10-26'],
    ['2026-02-30'], ['2026-10-01', '2026-10-01']]) {
    assert.throws(() => normalize(raw({ restDays: dates })));
  }
  assert.throws(() => normalize(raw({ restDays: ['2026-10-24'], log: [log()] })));
  assert.throws(() => state.normalizeState(raw({ restDays: ['2026-10-25'], settings: { dayStart: 4 } }),
    { ...options, now: new Date(2026, 9, 25, 2).getTime() }));
});

test('adding a rest day enforces quota and learning conflict without changing XP or logs', () => {
  const value = normalize(raw({ restDays: ['2026-09-01', '2026-09-02'], log: [log()] }));
  assert.equal(state.addRestDay(value, '2026-10-22'), value);
  state.addRestDay(value, '2026-10-23');
  const before = structuredClone(value);
  assert.throws(() => state.addRestDay(value, '2026-10-21'));
  assert.throws(() => state.addRestDay(value, '2026-10-24'));
  assert.throws(() => state.addRestDay(value, '2999-01-01'));
  assert.deepEqual(value, before);
  assert.equal(value.attr.math, 20);
  assert.equal(value.log.length, 1);
});

test('removal targets stable uid and removes an empty day from derived stats', () => {
  const value = normalize(raw({ log: [log(), log({ uid: 'log_b', id: 'other', d: '2026-10-23', xp: 5 })] }));
  value.log.reverse();
  assert.equal(state.removeLog(value, 'log_a', cats), true);
  assert.equal(value.log[0].uid, 'log_b');
  assert.deepEqual(value.attr, { math: 5, eng: 0 });
  assert.deepEqual(value.days, { '2026-10-23': { n: 1, xp: 5 } });
  assert.equal(state.removeLog(value, 'log_a', cats), false);
  assert.equal(state.removeLog(value, 'log_b', cats), true);
  assert.deepEqual(value.days, {});
  assert.deepEqual(value.attr, { math: 0, eng: 0 });
});

test('new completion identities are safe and distinct during rapid calls', () => {
  const ids = Array.from({ length: 500 }, () => state.newLogId());
  assert.equal(new Set(ids).size, 500);
  ids.forEach(id => assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/));
});
