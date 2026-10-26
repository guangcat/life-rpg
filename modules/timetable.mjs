// 课表只作课程参考，不改任务、经验或任何存档。
function fail(message) { throw new TypeError(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式不正确。`);
  return value;
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}格式不正确。`);
  return value;
}
function integer(value, label, min = 1, max = 60) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label}超出有效范围。`);
  return value;
}
function list(value, label, max = 300) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式不正确。`);
  return value;
}
function minute(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('上课时间格式不正确。');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('开学日期格式不正确。');
  const [year, month, day] = value.split('-').map(Number), parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day); parsed.setUTCHours(0, 0, 0, 0);
  if (year < 1 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) fail('开学日期格式不正确。');
}

export function normalizeTimetable(raw) {
  object(raw, '课表');
  let result; try { result = JSON.parse(JSON.stringify(raw)); } catch { fail('课表格式不正确。'); }
  if (result.schemaVersion !== 1) fail('课表版本暂不支持。');
  text(result.term, '学期'); text(result.campus, '校区');
  if (result.semesterStart !== null) date(result.semesterStart);
  if (result.sourceWeek !== undefined) integer(result.sourceWeek, '来源周次');
  object(result.periodTimes, '作息时间');
  for (const group of ['standard', 'practice']) {
    const periods = list(result.periodTimes[group], '作息时间', 30), seen = new Set();
    if (!periods.length) fail('作息时间不能为空。');
    for (const period of periods) {
      object(period, '节次'); integer(period.period, '节次', 1, 30);
      if (seen.has(period.period)) fail('节次不能重复。');
      if (minute(period.end) <= minute(period.start)) fail('下课时间必须晚于上课时间。');
      seen.add(period.period);
    }
  }
  const ids = new Set();
  for (const course of list(result.courses, '课程')) {
    object(course, '课程'); text(course.id, '课程编号', 100); text(course.name, '课程名称');
    if (ids.has(course.id)) fail('课程编号不能重复。'); ids.add(course.id);
    integer(course.weekday, '星期', 1, 7); text(course.location, '上课地点');
    if (!['standard', 'practice'].includes(course.timeGroup)) fail('课程作息分组不正确。');
    if (typeof course.attendanceRequired !== 'boolean') fail('课程免听设置不正确。');
    const periods = list(course.periods, '课程节次', 30), valid = result.periodTimes[course.timeGroup];
    if (!periods.length || new Set(periods).size !== periods.length) fail('课程节次不能为空或重复。');
    for (const period of periods) {
      integer(period, '课程节次', 1, 30);
      if (!valid.some(item => item.period === period)) fail('课程节次没有对应的作息时间。');
    }
    course.periods.sort((a, b) => a - b);
    object(course.weeks, '上课周次'); integer(course.weeks.start, '开始周次'); integer(course.weeks.end, '结束周次');
    if (course.weeks.end < course.weeks.start || !['all', 'odd', 'even'].includes(course.weeks.parity)) fail('上课周次不正确。');
  }
  result.notes ??= []; result.sources ??= [];
  for (const note of list(result.notes, '课表说明', 50)) text(note, '课表说明', 1000);
  for (const source of list(result.sources, '课表来源', 30)) { object(source, '课表来源'); text(source.path ?? source.fileName, '来源文件', 600); }
  return result;
}

export function coursesOn(timetable, { weekday, week = null, includeExempt = false } = {}) {
  if (weekday !== undefined) integer(weekday, '星期', 1, 7);
  if (week !== null) integer(week, '周次');
  if (typeof includeExempt !== 'boolean') fail('免听筛选设置不正确。');
  return timetable.courses.filter(course =>
    (weekday === undefined || course.weekday === weekday) && (includeExempt || course.attendanceRequired) &&
    (week === null || (week >= course.weeks.start && week <= course.weeks.end &&
      (course.weeks.parity === 'all' || (week % 2 === 0 ? 'even' : 'odd') === course.weeks.parity))))
    .sort((a, b) => a.weekday - b.weekday || a.periods[0] - b.periods[0] || a.weeks.start - b.weeks.start);
}

export function courseTime(timetable, course) {
  const times = timetable.periodTimes[course.timeGroup];
  const first = times?.find(item => item.period === Math.min(...course.periods));
  const last = times?.find(item => item.period === Math.max(...course.periods));
  if (!first || !last) fail('课程节次没有对应的作息时间。');
  return { start: first.start, end: last.end };
}

export function fetchTimetable(options) { return readTimetable(options); }
async function readTimetable({ repo, token, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) fail('课表仓库设置不正确。');
  if (typeof token !== 'string' || !token.trim()) fail('请先连接 GitHub，再读取课表。');
  if (typeof fetchImpl !== 'function') fail('当前无法读取云端课表。');
  let response;
  try {
    response = await fetchImpl('https://api.github.com/repos/' + repo.split('/').map(encodeURIComponent).join('/') + '/contents/timetable.json', {
      method: 'GET', cache: 'no-store', signal,
      headers: { Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('课表读取失败，请联网后重试。');
  }
  if (!response.ok) throw new Error(response.status === 404 ? '云端课表尚不可用，请检查连接权限。' : '课表读取失败，请检查 GitHub 连接。');
  let data;
  try { data = await response.json(); } catch { throw new Error('云端课表格式无法读取。'); }
  try {
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > 2_000_000) fail('课表内容无效。');
    const encoded = data.content.replace(/\s/g, '');
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('课表编码无效。');
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) fail('课表编码无效。');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return normalizeTimetable(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw new Error('云端课表格式无法读取，请保留原文件后重新整理。'); }
}
