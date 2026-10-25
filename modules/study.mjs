// Pure study summaries. Callers supply their local business-day key; no clock or storage is read here.
export const DEFAULT_CET4_DATE = '2026-12-12';
const DAY_MS = 86400000;
const LEARNING_CATEGORIES = new Set(['math', 'eng', 'cs', 'grad']);
const CET4_NAMES = new Set(['四级', '英语四级', '大学英语四级', 'CET4', 'CET-4', '四级（待核对）']);

function dayNumber(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new TypeError('日期必须为 YYYY-MM-DD');
  }
  const [year, month, day] = key.split('-').map(Number);
  // setUTCFullYear also preserves years 0001–0099, unlike Date.UTC's legacy year conversion.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) throw new TypeError(`日期 ${key} 无效`);
  return date.getTime() / DAY_MS;
}

export function cet4Countdown(cds = []) {
  if (!Array.isArray(cds)) throw new TypeError('倒计时必须是数组');
  const canonical = cds.find(countdown => countdown?.id === 'cet4');
  if (canonical && canonical.provisional !== true) return canonical;
  // Legacy manual countdowns have generated IDs. The last exact name match wins;
  // only a confirmed manual record can supersede a provisional canonical record.
  for (let index = cds.length - 1; index >= 0; index--) {
    const countdown = cds[index];
    if (typeof countdown?.n === 'string' && CET4_NAMES.has(countdown.n.trim().toUpperCase()) &&
        (!canonical || countdown.provisional !== true)) return countdown;
  }
  return canonical ?? null;
}

export function cet4Date(cds = []) {
  const exam = cet4Countdown(cds);
  // An explicit date remains authoritative, including old estimated dates and expired dates.
  const date = exam ? exam.date : DEFAULT_CET4_DATE;
  dayNumber(date);
  return date;
}

export function daysUntil(dateKey, todayKey) {
  return dayNumber(dateKey) - dayNumber(todayKey);
}

function trackProgress(state, definitions, key) {
  const definition = definitions.find(track => (track?.k ?? track?.key ?? track?.id) === key);
  const goal = definition?.goal;
  if (typeof goal !== 'number' || !Number.isFinite(goal) || goal <= 0) {
    throw new TypeError(`${key} 的目标必须是正数`);
  }
  const amount = state.tracks?.[key] ?? 0;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError(`${key} 的进度必须是有限数值`);
  const value = Math.min(goal, Math.max(0, amount));
  return { value, goal, remaining: goal - value };
}

export function examProgress(state, trackDefs, todayKey) {
  if (!Array.isArray(trackDefs)) throw new TypeError('进度目标必须是数组');
  const date = cet4Date(state.cds);
  const daysLeft = daysUntil(date, todayKey);
  const expired = daysLeft < 0;
  const vocab = trackProgress(state, trackDefs, 'vocab');
  const paper = trackProgress(state, trackDefs, 'paper');
  vocab.perDay = expired ? null : Math.ceil(vocab.remaining / Math.max(1, daysLeft));
  const coverage = (vocab.value / vocab.goal + paper.value / paper.goal) / 2;
  return { date, daysLeft, expired, vocab, paper, coverage, hp: Math.round((1 - coverage) * 100) };
}

export function addVocabulary(current, amount, goal) {
  if (!Number.isSafeInteger(current) || current < 0) throw new TypeError('当前词汇进度无效，请核对存档。');
  if (!Number.isSafeInteger(goal) || goal <= 0) throw new TypeError('词汇目标必须是正整数。');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('请填写实际新增词数（正整数）。');
  if (current >= goal) throw new RangeError('当前词汇进度已达到目标。');
  if (amount > goal - current) throw new RangeError(`本次新增超过剩余的 ${goal - current} 词，请核对后重填。`);
  return current + amount;
}

export function isEffectiveLog(row) {
  return !!row && row.id !== 'min_open' && LEARNING_CATEGORIES.has(row.c);
}

export function studyDays(log, todayKey) {
  if (!Array.isArray(log)) throw new TypeError('学习日志必须是数组');
  const today = dayNumber(todayKey);
  const weekday = new Date(today * DAY_MS).getUTCDay() || 7;
  const monday = today - weekday + 1;
  const checkIn = new Set(), effective = new Set(), weekCheckIn = new Set(), weekEffective = new Set();
  for (const row of log) {
    const date = dayNumber(row.d);
    if (date > today) continue;
    checkIn.add(row.d);
    const learning = isEffectiveLog(row);
    if (learning) effective.add(row.d);
    if (date >= monday) {
      weekCheckIn.add(row.d);
      if (learning) weekEffective.add(row.d);
    }
  }
  // Weekly counts always describe a seven-day Monday–Sunday week; future dates add nothing.
  return { checkInDays: checkIn.size, effectiveDays: effective.size,
    weekEffective: weekEffective.size, weekCheckIn: weekCheckIn.size };
}
