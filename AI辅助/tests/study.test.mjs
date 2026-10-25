import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { businessDay } from '../../modules/state.mjs';

const Study = await import('../../modules/study.mjs').catch(() => ({}));
const tracks = [{ k: 'vocab', goal: 2000 }, { k: 'paper', goal: 5 }, { k: 'math', goal: 5 }];
const sample = (overrides = {}) => ({ cds: [], tracks: { vocab: 0, paper: 0 }, log: [], ...overrides });
const row = (d, c = 'eng', id = 'words') => ({ id, d, c, xp: 20 });

test('study rules expose the bounded pure API', () => {
  for (const key of ['cet4Countdown', 'cet4Date', 'daysUntil', 'examProgress', 'studyDays', 'isEffectiveLog', 'addVocabulary']) {
    assert.equal(typeof Study[key], 'function', `${key} must be available`);
  }
  assert.equal(Study.DEFAULT_CET4_DATE, '2026-12-12');
});

test('CET4 fallback is fixed and never borrows an unrelated countdown', () => {
  assert.equal(Study.cet4Date(), '2026-12-12');
  assert.equal(Study.cet4Date([]), '2026-12-12');
  assert.equal(Study.cet4Date([{ id: 'birthday', date: '2026-10-26' }]), '2026-12-12');
  const result = Study.examProgress(sample({ cds: [{ id: 'birthday', date: '2026-10-26' }] }), tracks, '2026-10-25');
  assert.equal(result.date, '2026-12-12');
  assert.equal(result.daysLeft, 48);
  assert.equal(Study.examProgress(sample(), tracks, '2027-01-01').expired, true);
});

test('explicit CET4 dates survive, including legacy estimates and dates in the past', () => {
  for (const date of ['2026-12-19', '2027-06-12', '2026-01-01']) {
    const cds = [{ id: 'other', date: '2026-10-26' }, { id: 'cet4', date, provisional: true }];
    const before = structuredClone(cds);
    assert.equal(Study.cet4Date(cds), date);
    assert.equal(Study.examProgress(sample({ cds }), tracks, '2026-10-25').date, date);
    assert.deepEqual(cds, before);
  }
});

test('legacy manually named CET4 countdowns use their existing dates and original objects', () => {
  for (const n of ['四级', '英语四级', '大学英语四级', 'CET4', 'CET-4', '四级（待核对）']) {
    const exam = Object.freeze({ id: 'c123', n, date: '2027-06-12' });
    const cds = Object.freeze([{ id: 'other', n: '生日', date: '2026-10-26' }, exam]);
    const before = structuredClone(cds);
    assert.equal(Study.cet4Countdown(cds), exam);
    assert.equal(Study.cet4Date(cds), '2027-06-12');
    assert.equal(Study.examProgress(sample({ cds }), tracks, '2026-12-13').expired, false);
    assert.deepEqual(cds, before);
  }
});

test('confirmed canonical CET4 wins over legacy names regardless of array order', () => {
  const canonical = { id: 'cet4', n: '我改过的考试名', date: '2026-12-19' };
  const manual = { id: 'c123', n: '四级', date: '2027-06-12' };
  assert.equal(Study.cet4Countdown([manual, canonical]), canonical);
  assert.equal(Study.cet4Countdown([canonical, manual]), canonical);
  assert.equal(Study.cet4Date([canonical, manual]), '2026-12-19');
});

test('last confirmed legacy CET4 overrides a provisional canonical without rewriting dates', () => {
  const canonical = { id: 'cet4', n: '四级（待核对）', date: '2026-12-19', provisional: true };
  const first = { id: 'c123', n: '四级', date: '2027-06-12' };
  const last = { id: 'c124', n: '四级', date: '2026-06-13' };
  const provisional = { id: 'c125', n: 'CET-4', date: '2027-12-11', provisional: true };
  const cds = [first, canonical, last, provisional];
  const before = structuredClone(cds);
  assert.equal(Study.cet4Countdown(cds), last);
  assert.equal(Study.cet4Date(cds), '2026-06-13');
  const expired = Study.examProgress(sample({ cds }), tracks, '2026-10-25');
  assert.equal(expired.expired, true);
  assert.equal(expired.vocab.perDay, null);
  assert.deepEqual(cds, before);
  assert.equal(Study.cet4Countdown([canonical, provisional]), canonical);
});

test('without canonical CET4 the last exact named countdown wins, preserving an expired choice', () => {
  const first = { id: 'c123', n: '四级', date: '2027-06-12' };
  const last = { id: 'c124', n: '四级', date: '2026-06-13' };
  assert.equal(Study.cet4Countdown([first, last]), last);
  assert.equal(Study.cet4Date([first, last]), '2026-06-13');
  assert.equal(Study.cet4Countdown([{ id: 'c1', n: ' cet-4 ', date: '2027-06-12' }])?.id, 'c1');
});

test('CET4 recognition excludes unrelated or broad names and returns null when absent', () => {
  const cds = ['四六级', '六级', '四级词汇', '四级练习', '我的四级', 'CET-6', '四级考试模拟'].map((n, i) =>
    ({ id: `c${i}`, n, date: '2027-06-12' }));
  assert.equal(Study.cet4Countdown(), null);
  assert.equal(Study.cet4Countdown([]), null);
  assert.equal(Study.cet4Countdown(cds), null);
  assert.equal(Study.cet4Date(cds), '2026-12-12');
});

test('calendar-day differences cover today, expiration, year and leap boundaries', () => {
  assert.equal(Study.daysUntil('2026-12-12', '2026-12-12'), 0);
  assert.equal(Study.daysUntil('2026-12-12', '2026-12-13'), -1);
  assert.equal(Study.daysUntil('2027-01-01', '2026-12-31'), 1);
  assert.equal(Study.daysUntil('2028-03-01', '2028-02-28'), 2);
  assert.equal(Study.daysUntil('0099-03-01', '0099-02-28'), 1);
  for (const invalid of ['2026-02-30', '2026-13-01', '2026-1-01', '0000-01-01', new Date()]) {
    assert.throws(() => Study.daysUntil(invalid, '2026-10-25'));
    assert.throws(() => Study.daysUntil('2026-12-12', invalid));
  }
});

test('countdown follows the caller business day on both sides of the 4am cutover', () => {
  const before = businessDay(new Date(2026, 11, 12, 3, 59), 4);
  const after = businessDay(new Date(2026, 11, 12, 4), 4);
  assert.equal(Study.daysUntil('2026-12-12', before), 1);
  assert.equal(Study.daysUntil('2026-12-12', after), 0);
});

test('calendar differences remain whole days across daylight saving changes', () => {
  const moduleUrl = new URL('../../modules/study.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { daysUntil } from ${JSON.stringify(moduleUrl)};
     console.log(daysUntil('2026-03-09', '2026-03-08'));
     console.log(daysUntil('2026-11-02', '2026-11-01'));`],
  { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(output.trim(), '1\n1');
});

test('pace uses remaining vocabulary, rounds up, and handles exam day as today', () => {
  const value = sample({ cds: [{ id: 'cet4', date: '2026-10-30' }], tracks: { vocab: 1633, paper: 2 } });
  const result = Study.examProgress(value, tracks, '2026-10-25');
  assert.equal(result.daysLeft, 5);
  assert.equal(result.expired, false);
  assert.deepEqual(result.vocab, { value: 1633, goal: 2000, remaining: 367, perDay: 74 });
  assert.deepEqual(result.paper, { value: 2, goal: 5, remaining: 3 });
  const today = Study.examProgress(value, tracks, '2026-10-30');
  assert.equal(today.daysLeft, 0);
  assert.equal(today.expired, false);
  assert.equal(today.vocab.perDay, 367);
});

test('expired exams expose overdue status without a future study pace', () => {
  const result = Study.examProgress(sample({ tracks: { vocab: 800, paper: 1 } }), tracks, '2026-12-13');
  assert.equal(result.daysLeft, -1);
  assert.equal(result.expired, true);
  assert.equal(result.vocab.remaining, 1200);
  assert.equal(result.vocab.perDay, null);
});

test('Boss HP is the average of normalized vocabulary and paper coverage', () => {
  const result = Study.examProgress(sample({ tracks: { vocab: 1000, paper: 5 } }), tracks, '2026-10-25');
  assert.equal(result.coverage, .75);
  assert.equal(result.hp, 25);
  const onlyWords = Study.examProgress(sample({ tracks: { vocab: 2000, paper: 0 } }), tracks, '2026-10-25');
  assert.equal(onlyWords.coverage, .5);
  assert.equal(onlyWords.hp, 50);
});

test('XP, unrelated tracks and cached activity cannot change Boss HP', () => {
  const base = sample({ tracks: { vocab: 640, paper: 1, math: 0 } });
  const enriched = { ...structuredClone(base), attr: { eng: 9999999 }, days: { '2026-10-25': { xp: 9999999, n: 500 } },
    log: [row('2026-10-25')], tracks: { ...base.tracks, math: 500, cs: 300 } };
  assert.deepEqual(Study.examProgress(enriched, tracks, '2026-10-25'),
    Study.examProgress(base, tracks, '2026-10-25'));
});

test('display clamps coverage to goals without rewriting accumulated source counts', () => {
  const value = sample({ tracks: { vocab: 2500, paper: 20 } });
  const before = structuredClone(value);
  Object.freeze(value.tracks); Object.freeze(value.cds); Object.freeze(value);
  const result = Study.examProgress(value, tracks, '2026-10-25');
  assert.deepEqual(result.vocab, { value: 2000, goal: 2000, remaining: 0, perDay: 0 });
  assert.deepEqual(result.paper, { value: 5, goal: 5, remaining: 0 });
  assert.equal(result.coverage, 1);
  assert.equal(result.hp, 0);
  assert.deepEqual(value, before);
  const negative = Study.examProgress(sample({ tracks: { vocab: -1, paper: -3 } }), tracks, '2026-10-25');
  assert.equal(negative.vocab.value, 0);
  assert.equal(negative.paper.value, 0);
  assert.equal(negative.hp, 100);
});

test('exam progress respects supplied goals and treats missing tracked amounts as zero', () => {
  const custom = [{ k: 'vocab', goal: 3000 }, { k: 'paper', goal: 10 }];
  const result = Study.examProgress({ cds: [] }, custom, '2026-12-10');
  assert.equal(result.vocab.goal, 3000);
  assert.equal(result.vocab.perDay, 1500);
  assert.equal(result.paper.goal, 10);
  assert.equal(result.hp, 100);
  assert.throws(() => Study.examProgress(sample(), [{ k: 'vocab', goal: 0 }, tracks[1]], '2026-10-25'));
});

test('actual vocabulary increments accept 1, 7, 37 and the exact remaining amount', () => {
  assert.equal(Study.addVocabulary(0, 1, 2000), 1);
  assert.equal(Study.addVocabulary(100, 7, 2000), 107);
  assert.equal(Study.addVocabulary(107, 37, 2000), 144);
  assert.equal(Study.addVocabulary(1963, 37, 2000), 2000);
});

test('invalid vocabulary amounts are rejected instead of rounded or silently clamped', () => {
  for (const amount of [NaN, Infinity, -Infinity, 0, -1, 1.5, 37.1, 2001, '7', '', undefined, null, true]) {
    assert.throws(() => Study.addVocabulary(0, amount, 2000), `must reject ${String(amount)}`);
  }
  assert.throws(() => Study.addVocabulary(1999, 7, 2000));
  assert.throws(() => Study.addVocabulary(2000, 1, 2000));
  assert.throws(() => Study.addVocabulary(2500, 1, 2000));
});

test('vocabulary validation refuses invalid existing counts or goals', () => {
  for (const current of [NaN, Infinity, -1, 1.5, '0']) {
    assert.throws(() => Study.addVocabulary(current, 1, 2000));
  }
  for (const goal of [NaN, Infinity, 0, -1, 1.5, '2000']) {
    assert.throws(() => Study.addVocabulary(0, 1, goal));
  }
});

test('only real learning categories are effective and the minimum opener is excluded', () => {
  for (const category of ['math', 'eng', 'cs', 'grad']) {
    assert.equal(Study.isEffectiveLog(row('2026-10-25', category)), true);
    assert.equal(Study.isEffectiveLog(row('2026-10-25', category, 'min_open')), false);
  }
  for (const category of ['vit', 'intel', 'unknown']) {
    assert.equal(Study.isEffectiveLog(row('2026-10-25', category)), false);
  }
  assert.equal(Study.isEffectiveLog(null), false);
});

test('check-in and effective days count distinct dated logs and ignore future rows', () => {
  const log = [row('2026-10-18', 'eng'), row('2026-10-19', 'vit', 'sleep'),
    row('2026-10-20', 'intel', 'min_open'), row('2026-10-21', 'math'), row('2026-10-21', 'eng', 'words2'),
    row('2026-10-25', 'grad', 'homework'), row('2026-10-26', 'eng')];
  const before = structuredClone(log);
  assert.deepEqual(Study.studyDays(log, '2026-10-25'), {
    checkInDays: 5, effectiveDays: 3, weekEffective: 2, weekCheckIn: 4,
  });
  assert.deepEqual(log, before);
});

test('week starts on Monday and future days in that week do not create activity', () => {
  const log = [row('2026-10-18'), row('2026-10-19'), row('2026-10-20'), row('2026-10-25')];
  assert.deepEqual(Study.studyDays(log, '2026-10-19'), {
    checkInDays: 2, effectiveDays: 2, weekEffective: 1, weekCheckIn: 1,
  });
  assert.deepEqual(Study.studyDays(log, '2026-10-25'), {
    checkInDays: 4, effectiveDays: 4, weekEffective: 3, weekCheckIn: 3,
  });
  assert.deepEqual(Study.studyDays(log, '2026-10-26'), {
    checkInDays: 4, effectiveDays: 4, weekEffective: 0, weekCheckIn: 0,
  });
});

test('rest days and cached aggregates cannot manufacture effective days', () => {
  const state = sample({ restDays: ['2026-10-23', '2026-10-24'],
    days: { '2026-10-23': { n: 100, xp: 10000 } }, log: [row('2026-10-25', 'intel', 'min_open')] });
  assert.deepEqual(Study.studyDays(state.log, '2026-10-25'), {
    checkInDays: 1, effectiveDays: 0, weekEffective: 0, weekCheckIn: 1,
  });
  assert.deepEqual(Study.studyDays([], '2026-10-25'), {
    checkInDays: 0, effectiveDays: 0, weekEffective: 0, weekCheckIn: 0,
  });
});
