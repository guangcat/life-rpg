// log is the source of XP and activity. attr/days are export-compatible caches.
const DEFAULT_CATS = ['math', 'eng', 'cs', 'grad', 'vit', 'intel'];
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = message => { throw new TypeError(message); };
const pad = number => String(number).padStart(2, '0');

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  return value;
}

// Clone data before normalization: no partial mutation can escape a failed import.
function clone(value, path = 'state', ancestors = new Set(), depth = 0) {
  if (depth > 64) fail(`${path} 嵌套过深`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必须是有限数值`);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} 必须是 JSON 数据`);
  if (ancestors.has(value)) fail(`${path} 不能循环引用`);
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail(`${path} 必须是普通对象`);
  if (Object.getOwnPropertySymbols(value).length) fail(`${path} 不能包含 Symbol`);
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  const keys = Object.keys(value);
  if (Array.isArray(value) && keys.length !== value.length) fail(`${path} 不能包含稀疏数组或附加属性`);
  for (const key of keys) {
    if (UNSAFE.has(key)) fail(`${path}.${key} 不安全`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) fail(`${path}.${key} 不能是访问器`);
    result[key] = clone(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value) || UNSAFE.has(value)) {
    fail(`${label} 不是安全标识符`);
  }
  return value;
}

function text(value, label, max = 1000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${label} 无效`);
  return value;
}

function number(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER ||
      (integer && !Number.isSafeInteger(value))) fail(`${label} 必须是非负有限数值`);
  return value;
}

function timestamp(value, label) {
  number(value, label);
  if (!Number.isFinite(new Date(value).getTime())) fail(`${label} 时间无效`);
  return value;
}

function dateOfKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) fail('日期必须为 YYYY-MM-DD');
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, month - 1, day);
  if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    fail(`日期 ${key} 无效`);
  }
  return date;
}

function keyOfDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftKey(key, count) {
  const date = dateOfKey(key);
  date.setDate(date.getDate() + count);
  return keyOfDate(date);
}

function dayNumber(key) {
  const date = dateOfKey(key);
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime() / 86400000;
}

function dayStartHour(value) {
  if (!Number.isInteger(value) || value < 0 || value > 6) fail('日切时间必须为 0–6 点的整数');
  return value;
}

export function businessDay(date = new Date(), dayStart = 0) {
  dayStartHour(dayStart);
  const local = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (!Number.isFinite(local.getTime())) fail('业务日期无效');
  // Calendar arithmetic, rather than subtracting milliseconds, survives DST days.
  if (local.getHours() < dayStart) local.setDate(local.getDate() - 1);
  local.setHours(12, 0, 0, 0);
  return keyOfDate(local);
}

function categoryKeys(cats = DEFAULT_CATS) {
  const keys = array(cats, 'cats').map(cat => identifier(typeof cat === 'string' ? cat :
    object(cat, 'category').k ?? cat.key ?? cat.id, 'category id'));
  if (new Set(keys).size !== keys.length) fail('属性标识符不能重复');
  return keys;
}

function category(value, keys, label) {
  identifier(value, label);
  if (!keys.includes(value)) fail(`${label} 未定义`);
  return value;
}

function validateAggregate(attr, days) {
  if (attr !== undefined) {
    object(attr, 'attr');
    for (const [key, value] of Object.entries(attr)) {
      identifier(key, 'attr key'); number(value, `attr.${key}`);
    }
  }
  if (days !== undefined) {
    object(days, 'days');
    for (const [key, value] of Object.entries(days)) {
      dateOfKey(key); object(value, `days.${key}`);
      number(value.n, `days.${key}.n`, true); number(value.xp, `days.${key}.xp`);
    }
  }
}

function stableUid(entry) {
  const input = JSON.stringify([entry.id, entry.d, entry.ts, entry.c, entry.xp, entry.n, entry.tm]);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `legacy_${hash.toString(16).padStart(16, '0')}`;
}

function normalizeLog(entries, keys, preserveLegacyRepeats = false) {
  const uids = new Set();
  const completions = new Map();
  const legacy = preserveLegacyRepeats && Array.isArray(entries) && entries.length > 0 && entries.every(entry => entry?.uid === undefined);
  return array(entries, 'log').map((entry, index) => {
    object(entry, `log[${index}]`);
    identifier(entry.id, 'log.id'); text(entry.n, 'log.n'); category(entry.c, keys, 'log.c');
    number(entry.xp, 'log.xp'); dateOfKey(entry.d); timestamp(entry.ts, 'log.ts');
    if (entry.tm === undefined) {
      const date = new Date(entry.ts); entry.tm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    } else if (typeof entry.tm !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.tm)) fail('log.tm 无效');
    if (entry.legacyRepeat !== undefined && typeof entry.legacyRepeat !== 'boolean') fail('log.legacyRepeat 必须为布尔值');
    if (entry.uid === undefined) {
      const base = stableUid(entry); entry.uid = base;
      if (legacy) { let suffix = 1; while (uids.has(entry.uid)) entry.uid = `${base}_${suffix++}`; }
    }
    identifier(entry.uid, 'log.uid');
    if (uids.has(entry.uid)) fail('log.uid 不能重复');
    const completion = `${entry.id}/${entry.d}`;
    const previous = completions.get(completion);
    if (previous) {
      if (legacy) { previous.legacyRepeat = true; entry.legacyRepeat = true; }
      else if (previous.legacyRepeat !== true || entry.legacyRepeat !== true) fail('同一任务同一天不能重复完成');
    }
    uids.add(entry.uid); completions.set(completion, entry);
    return entry;
  });
}

export function deriveStats(log, cats = DEFAULT_CATS) {
  const keys = categoryKeys(cats);
  const attr = Object.fromEntries(keys.map(key => [key, 0]));
  const days = {};
  for (const entry of array(log, 'log')) {
    object(entry, 'log entry'); dateOfKey(entry.d); category(entry.c, keys, 'log.c'); number(entry.xp, 'log.xp');
    attr[entry.c] += entry.xp;
    const day = days[entry.d] ??= { n: 0, xp: 0 };
    day.n++; day.xp += entry.xp;
    number(attr[entry.c], '汇总属性 XP'); number(day.xp, '当日汇总 XP');
  }
  return { attr, days };
}

export function rebuildStats(state, cats = DEFAULT_CATS) {
  const stats = deriveStats(state.log, cats);
  state.attr = stats.attr; state.days = stats.days;
  return state;
}

function normalizeTask(task, keys, born) {
  object(task, 'task'); identifier(task.id, 'task.id'); text(task.n, 'task.n');
  category(task.c, keys, 'task.c'); number(task.xp, 'task.xp');
  if (task.d === undefined) task.d = ''; else text(task.d, 'task.d', 2000, true);
  if (task.t === undefined) task.t = '';
  if (typeof task.t !== 'string' || (task.t !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.t))) fail('任务时间无效');
  if (task.wd !== undefined) {
    array(task.wd, 'task.wd');
    if (task.wd.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(task.wd).size !== task.wd.length) {
      fail('星期必须为不重复的 1–7');
    }
  }
  if (task.repeat === undefined) task.repeat = task.wd?.length ? 'weekly' : 'daily';
  if (!['daily', 'weekly', 'once'].includes(task.repeat)) fail('任务重复规则无效');
  if (task.repeat === 'weekly' && !task.wd?.length) fail('每周任务必须选择星期');
  if (task.paused === undefined) task.paused = false;
  if (typeof task.paused !== 'boolean') fail('task.paused 必须为布尔值');
  if (task.added === undefined) task.added = born;
  dateOfKey(task.added);
  return task;
}

function uniqueTasks(tasks, keys, born) {
  const ids = new Set();
  return array(tasks, 'tasks').map(task => {
    normalizeTask(task, keys, born);
    if (ids.has(task.id)) fail('任务 id 不能重复');
    ids.add(task.id); return task;
  });
}

function equalNumbers(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => (left[key] ?? 0) === (right[key] ?? 0));
}

function sameDays(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => (left[key]?.n ?? 0) === (right[key]?.n ?? 0) &&
    (left[key]?.xp ?? 0) === (right[key]?.xp ?? 0));
}

function validateRestDays(restDays, log, today) {
  const seen = new Set();
  const months = new Map();
  for (const key of array(restDays, 'restDays')) {
    dateOfKey(key);
    if (key > today) fail('不能设置未来休息日');
    if (seen.has(key)) fail('休息日不能重复');
    if (log.some(entry => entry.d === key)) fail('已有学习记录的日期不能设为休息日');
    const month = key.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
    if (months.get(month) > 2) fail('每月最多两个休息日');
    seen.add(key);
  }
  return restDays;
}

export function normalizeState(raw, { cats = DEFAULT_CATS, defaultTasks = [], tracks = [],
  defaultCds = [], taskVersion = 1, now = Date.now(), preserveLegacyRepeats = false } = {}) {
  object(raw, 'state');
  const result = clone(raw);
  const keys = categoryKeys(cats);
  timestamp(now, 'now'); number(taskVersion, 'taskVersion', true);
  validateAggregate(result.attr, result.days);
  if (result.log === undefined && own(result, 'attr')) fail('存档有 attr 却缺少 log，无法安全恢复 XP');
  if (typeof preserveLegacyRepeats !== 'boolean') fail('旧记录兼容设置必须为布尔值');
  result.log = normalizeLog(result.log === undefined ? [] : result.log, keys, preserveLegacyRepeats);
  const stats = deriveStats(result.log, keys);
  const warnings = [];
  if (result.attr !== undefined && !equalNumbers(result.attr, stats.attr)) warnings.push('旧属性 XP 与日志不一致，已依据日志重新汇总。');
  if (result.days !== undefined && !sameDays(result.days, stats.days)) warnings.push('旧每日统计与日志不一致，已依据日志重新汇总。');
  result.attr = stats.attr; result.days = stats.days;

  const settings = result.settings === undefined ? {} : object(result.settings, 'settings');
  if (settings.name === undefined) settings.name = '';
  text(settings.name, 'settings.name', 100, true);
  if (settings.dayStart === undefined) settings.dayStart = 0;
  dayStartHour(settings.dayStart); result.settings = settings;
  result.created = result.created === undefined ? now : timestamp(result.created, 'created');
  // Legacy added dates follow their original midnight boundary; history is never re-dated.
  const born = businessDay(new Date(result.created), 0);
  const defaults = uniqueTasks(clone(defaultTasks, 'defaultTasks'), keys, businessDay(new Date(now), settings.dayStart));
  result.tasks = uniqueTasks(result.tasks === undefined ? [] : result.tasks, keys, born);
  if (result.tv !== undefined) number(result.tv, 'tv', true);
  const migrating = result.tv === undefined || result.tv < taskVersion;
  if (migrating || raw.tasks === undefined) {
    const ids = new Set(result.tasks.map(task => task.id));
    for (const task of defaults) if (!ids.has(task.id)) { result.tasks.push(task); ids.add(task.id); }
  }
  result.tv = migrating ? taskVersion : result.tv;
  if (migrating && raw.tv !== undefined) warnings.push('任务表已迁移：保留已有任务，仅补充缺少的默认任务。');

  result.cds = result.cds === undefined ? clone(typeof defaultCds === 'function' ? defaultCds() : defaultCds, 'defaultCds') : result.cds;
  const countdownIds = new Set();
  for (const countdown of array(result.cds, 'cds')) {
    object(countdown, 'countdown'); identifier(countdown.id, 'countdown.id'); text(countdown.n, 'countdown.n'); dateOfKey(countdown.date);
    if (countdownIds.has(countdown.id)) fail('倒计时 id 不能重复');
    countdownIds.add(countdown.id);
  }
  result.focus = result.focus === undefined ? {} : object(result.focus, 'focus');
  if (result.focus.d !== undefined) dateOfKey(result.focus.d);
  if (result.focus.id !== undefined && result.focus.id !== '') identifier(result.focus.id, 'focus.id');
  result.sound = result.sound === undefined ? true : result.sound;
  if (typeof result.sound !== 'boolean') fail('sound 必须为布尔值');
  result.tracks = result.tracks === undefined ? {} : object(result.tracks, 'tracks');
  for (const [key, value] of Object.entries(result.tracks)) { identifier(key, 'track id'); number(value, `tracks.${key}`); }
  for (const track of array(tracks, 'track definitions')) {
    const key = identifier(typeof track === 'string' ? track : object(track, 'track definition').k ?? track.key ?? track.id, 'track id');
    if (!own(result.tracks, key)) result.tracks[key] = 0;
  }
  if (result.lastExport !== undefined) timestamp(result.lastExport, 'lastExport');
  result.restDays = validateRestDays(result.restDays === undefined ? [] : result.restDays, result.log,
    businessDay(new Date(now), settings.dayStart));
  result.migrationWarnings = warnings;
  return result;
}

function repeatOf(task) { return task.repeat ?? (task.wd?.length ? 'weekly' : 'daily'); }
function scheduledOn(task, dateKey) {
  const repeat = repeatOf(task);
  if (repeat === 'daily' || repeat === 'once') return true;
  if (repeat !== 'weekly') fail('任务重复规则无效');
  const weekday = dateOfKey(dateKey).getDay() || 7;
  return array(task.wd, 'task.wd').includes(weekday);
}

// "Due" describes the day's schedule; a daily/weekly completion still belongs to it.
export function isTaskDue(task, dateKey, log = []) {
  object(task, 'task'); dateOfKey(dateKey); array(log, 'log');
  if (task.paused || (task.added && task.added > dateKey)) return false;
  if (repeatOf(task) === 'once' && log.some(entry => entry.id === task.id)) return false;
  return scheduledOn(task, dateKey);
}

export function missedOccurrences(task, dateKey, log = [], created = Date.now()) {
  if (!isTaskDue(task, dateKey, log)) return 0;
  if (log.some(entry => entry.id === task.id && entry.d === dateKey)) return 0;
  let start = task.added ?? (typeof created === 'string' ? created : businessDay(new Date(created), 0));
  dateOfKey(start);
  for (const entry of log) if (entry.id === task.id && entry.d < dateKey && entry.d >= start) start = shiftKey(entry.d, 1);
  if (start >= dateKey) return 0;
  if (repeatOf(task) === 'once') return 1;
  const elapsed = dayNumber(dateKey) - dayNumber(start);
  if (repeatOf(task) === 'daily') return elapsed;
  // Full weeks plus at most six calendar days; no loop over years of history.
  const weekdays = new Set(task.wd);
  let missed = Math.floor(elapsed / 7) * weekdays.size;
  for (let offset = Math.floor(elapsed / 7) * 7; offset < elapsed; offset++) {
    if (scheduledOn(task, shiftKey(start, offset))) missed++;
  }
  return missed;
}

export function streakCount(days, restDays = [], dateKey = businessDay()) {
  object(days, 'days'); array(restDays, 'restDays'); dateOfKey(dateKey);
  const rest = new Set(restDays);
  const active = key => (days[key]?.n ?? 0) > 0;
  let cursor = dateKey;
  if (!active(cursor) && !rest.has(cursor)) cursor = shiftKey(cursor, -1);
  let count = 0;
  // Each iteration consumes one known active/rest day, then reaches a real gap.
  const limit = Object.keys(days).length + rest.size + 1;
  for (let index = 0; index < limit; index++) {
    if (active(cursor)) count++;
    else if (!rest.has(cursor)) break;
    cursor = shiftKey(cursor, -1);
  }
  return count;
}

export function addRestDay(state, dateKey) {
  object(state, 'state'); dateOfKey(dateKey);
  const restDays = state.restDays === undefined ? [] : array(state.restDays, 'restDays');
  if (restDays.includes(dateKey)) return state;
  const next = [...restDays, dateKey].sort();
  validateRestDays(next, array(state.log, 'log'), businessDay(new Date(), state.settings?.dayStart ?? 0));
  state.restDays = next;
  return state;
}

export function removeLog(state, uid, cats = DEFAULT_CATS) {
  identifier(uid, 'log.uid');
  const index = array(state.log, 'log').findIndex(entry => entry.uid === uid);
  if (index < 0) return false;
  const remaining = state.log.filter((_, position) => position !== index);
  const stats = deriveStats(remaining, cats);
  state.log = remaining; state.attr = stats.attr; state.days = stats.days;
  return true;
}

let sequence = 0;
export function newLogId() {
  if (globalThis.crypto?.randomUUID) return `log_${globalThis.crypto.randomUUID()}`;
  sequence++;
  return `log_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}
