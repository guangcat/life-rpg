// A serialized GitHub Contents backup client. State validation belongs to the app.
// Tokens are read at operation time and only travel in Authorization headers.
export function createGitHubSync({
  repo, path = 'backup.json', getConfig, getSnapshot, saveConfig, onStatus,
  fetchImpl = globalThis.fetch, delayMs = 4000, timeoutMs = 15000,
}) {
  const url = 'https://api.github.com/repos/' + String(repo).split('/').map(encodeURIComponent).join('/')
    + '/contents/' + String(path).split('/').map(encodeURIComponent).join('/');
  let timer = null, active = false, dirty = false, stopped = false;
  let blocked = false, restoring = false, request = null, putInFlight = false;
  const queue = [];

  function status(kind, message, extra = {}) {
    try { onStatus?.({kind, message, ...extra}); } catch { /* UI callbacks must not break backup state. */ }
  }
  function known(message) { return Object.assign(new Error(message), {visible: true}); }
  function persistConfig(next) {
    try {if (saveConfig(next) === false) throw new Error('not saved');}
    catch {throw known('本地同步基线无法保存，请检查浏览器存储后重试；远端内容请先核对。');}
  }
  function cancelled() { return Object.assign(new Error('stopped'), {cancelled: true}); }
  function config() { return getConfig() || {}; }
  function token() { return String(config().token || '').trim(); }
  function current(auth) { return !stopped && token() === auth; }
  function clearTimer() { clearTimeout(timer); timer = null; }
  function conflict(message, sha) {
    blocked = true; dirty = false; clearTimer();
    status('conflict', message + '，请先恢复远端备份，或确认覆盖。', sha ? {sha} : {});
  }
  function hint(code) {
    if (code === 401) return 'token 无效或已过期';
    if (code === 403) return 'token 权限不足，或 GitHub 请求被限流';
    if (code === 404) return '备份不存在，或 token 无权访问该仓库';
    return 'GitHub 请求失败（HTTP ' + code + '）';
  }
  function report(error, auth) {
    if (!stopped && !error?.cancelled && (!auth || current(auth))) {
      status('error', error?.visible ? error.message : '网络请求失败，请检查网络后重试。');
    }
  }
  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function decode(content) {
    try {
      const binary = atob(content.replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch { throw known('远端备份的 Base64 或 UTF-8 内容无效。'); }
  }

  // Time out both the response and its body. The race also works with a fetch
  // implementation that does not honor AbortSignal (including offline tests).
  async function send(auth, method = 'GET', body) {
    if (!current(auth)) throw cancelled();
    const controller = new AbortController();
    let timeout, cancel;
    const cancelledPromise = new Promise((_resolve, reject) => { cancel = () => {controller.abort(); reject(cancelled());}; });
    request = {cancel};
    try {
      return await Promise.race([
        (async () => {
          const result = await fetchImpl(url, {
            method, cache: 'no-store', signal: controller.signal,
            headers: {Authorization: 'Bearer ' + auth, Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
            ...(body ? {body: JSON.stringify(body)} : {}),
          });
          let data = null;
          if (result.ok) {
            try { data = await result.json(); } catch { throw known('GitHub 响应不是有效 JSON。'); }
          }
          return {result, data};
        })(),
        new Promise((_resolve, reject) => { timeout = setTimeout(() => {
          controller.abort(); reject(known('GitHub 请求超时，请检查网络后重试。'));
        }, timeoutMs); }),
        cancelledPromise,
      ]);
    } finally { clearTimeout(timeout); request = null; }
  }

  async function upload({overwrite = false} = {}) {
    let auth;
    try {
      auth = token();
      if (stopped) return false;
      if (!auth) {status('idle', '还没设置 token，存档不会上传。'); return false;}
      // Freeze the entire normalized snapshot before the first network await.
      const snapshot = JSON.stringify(getSnapshot(), null, 2);
      if (!snapshot) throw known('本地存档无法序列化，请先导出检查。');
      const baseline = config().sha || null;
      status('syncing', '正在同步到 GitHub…');
      const head = await send(auth);
      if (!current(auth)) return false;
      let remoteSha = null;
      if (head.result.ok) {
        if (typeof head.data?.sha !== 'string' || !head.data.sha) throw known('GitHub 响应缺少备份 SHA。');
        remoteSha = head.data.sha;
      } else if (head.result.status !== 404) throw known(hint(head.result.status));
      if (remoteSha !== baseline && !overwrite) {
        conflict('远端备份与这台设备的同步基线不同', remoteSha); return false;
      }
      if (!current(auth)) return false;
      const body = {message: 'backup ' + new Date().toISOString(), content: encode(snapshot)};
      if (remoteSha) body.sha = remoteSha;
      putInFlight = true;
      const pushed = await send(auth, 'PUT', body);
      putInFlight = false;
      if (!current(auth)) return false;
      if (pushed.result.status === 409 || pushed.result.status === 422) {
        conflict('GitHub 拒绝了本次写入（HTTP ' + pushed.result.status + '），未自动覆盖', remoteSha); return false;
      }
      if (!pushed.result.ok) throw known(hint(pushed.result.status));
      const sha = pushed.data?.content?.sha;
      if (typeof sha !== 'string' || !sha) throw known('GitHub 响应缺少已保存的 SHA，请核对远端备份。');
      const at = new Date().toISOString();
      persistConfig({...config(), sha, lastSync: at});
      blocked = false;
      status('success', '已同步到 GitHub。', {at, sha});
      return true;
    } catch (error) { report(error, auth); return false; }
    finally { putInFlight = false; }
  }

  async function restore() {
    let auth;
    try {
      auth = token();
      if (stopped) return null;
      if (!auth) throw known('还没设置 token，无法读取远端备份。');
      status('syncing', '正在读取远端备份…');
      const remote = await send(auth);
      if (!current(auth)) return null;
      if (!remote.result.ok) throw known(hint(remote.result.status));
      const {sha, content, encoding} = remote.data || {};
      if (typeof sha !== 'string' || !sha || typeof content !== 'string' || (encoding && encoding !== 'base64')) {
        throw known('GitHub 响应缺少有效的备份内容或 SHA。');
      }
      let state;
      try { state = JSON.parse(decode(content)); } catch (error) {
        if (error.visible) throw error;
        throw known('远端备份不是有效 JSON，未修改本地存档。');
      }
      status('success', '已下载远端备份，等待校验与恢复。', {sha});
      return {state, sha};
    } catch (error) { report(error, auth); return null; }
  }

  function enqueue(type, options = {}, automatic = false) {
    if (stopped) return Promise.resolve(type === 'download' ? null : false);
    return new Promise(resolve => {queue.push({type, options, automatic, resolve}); void pump();});
  }
  async function pump() {
    if (active || stopped || !queue.length) return;
    active = true;
    const job = queue.shift();
    if (job.type === 'push') dirty = false;
    const result = job.type === 'download' ? await restore() : await upload(job.options);
    active = false;
    job.resolve(result);
    // Edits made during a push must survive its frozen snapshot. A conflict
    // or restore pauses this automatic follow-up until the user resolves it.
    if (dirty && !queue.length && !stopped && !blocked && !restoring) {
      dirty = false;
      void enqueue('push', {}, true);
    }
    void pump();
  }

  function schedule() {
    try {
      if (stopped || blocked || restoring || !token()) return;
      clearTimer();
      status('pending', active ? '有新更改，当前同步结束后继续上传。' : '有新更改，稍后同步。');
      if (active || queue.length) {dirty = true; return;}
      timer = setTimeout(() => {timer = null; void enqueue('push', {}, true);}, delayMs);
    } catch (error) { report(error); }
  }
  function pushNow(options = {}) {
    clearTimer();
    restoring = false;
    return enqueue('push', options);
  }
  function download() {
    clearTimer(); dirty = false; restoring = true;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].automatic) queue.splice(i, 1)[0].resolve(false);
    }
    return enqueue('download');
  }
  function acceptRemote(sha) {
    if (stopped) return false;
    try {
      if (active || queue.length) throw known('同步正在进行，请稍后再确认恢复。');
      if (typeof sha !== 'string' || !sha) throw known('远端备份 SHA 无效。');
      if (!token()) throw known('同步已停用，无法保存远端同步基线。');
      persistConfig({...config(), sha, lastSync: new Date().toISOString()});
      blocked = false; restoring = false; dirty = false;
      status('success', '已恢复远端备份并保存同步基线。', {sha});
      return true;
    } catch (error) {report(error); return false;}
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimer(); dirty = false;
    while (queue.length) {const job = queue.shift(); job.resolve(job.type === 'download' ? null : false);}
    const mayHaveWritten = putInFlight;
    request?.cancel();
    status('idle', mayHaveWritten ? '已停用同步；已发出的写入请求可能已到达 GitHub。' : '已停用同步，后续更改不会上传。');
  }
  return {schedule, pushNow, download, acceptRemote, stop};
}
