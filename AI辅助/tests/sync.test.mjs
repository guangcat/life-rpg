import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../../modules/sync.mjs', import.meta.url);
const response = (status, data = {}) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const tick = () => new Promise(done => setTimeout(done, 2));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('operation did not settle'); }
async function fixture(fetchImpl, options = {}) {
  assert.ok(existsSync(moduleUrl), 'GitHub backup module must exist');
  const {createGitHubSync} = await import(moduleUrl);
  const statuses = [], saved = [];
  let config = {token: 'private-test-token', ...(options.config || {})};
  let snapshot = {label: '中文备份 🌙', log: [{xp: 8}]};
  const sync = createGitHubSync({repo: 'owner/private-data', getConfig: () => config,
    getSnapshot: () => snapshot, saveConfig: next => { config = next; saved.push(next); },
    onStatus: status => statuses.push(status), fetchImpl, delayMs: 5, timeoutMs: 1000, ...options,
  });
  return {sync, statuses, saved, config: () => config, change: next => {snapshot = next;}, disable: () => {config = {};}};
}
const readPayload = init => JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));

test('first missing backup creates a UTF-8 snapshot and stores the returned SHA', async () => {
  const calls = [];
  const f = await fixture(async (url, init) => { calls.push({url, init}); return init.method === 'PUT' ? response(201, {content: {sha: 'created'}}) : response(404); });
  assert.equal(await f.sync.pushNow(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/private-data/contents/backup.json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-test-token');
  assert.equal(calls[0].url.includes('private-test-token'), false);
  assert.deepEqual(readPayload(calls[1].init), {label: '中文备份 🌙', log: [{xp: 8}]});
  assert.equal('sha' in JSON.parse(calls[1].init.body), false);
  assert.equal(f.config().sha, 'created');
  assert.ok(f.config().lastSync);
  assert.equal(f.statuses.at(-1).kind, 'success');
});

test('baseline mismatch and unaccepted existing backup refuse to PUT', async () => {
  for (const config of [{}, {sha: 'old'}]) {
    const calls = [];
    const f = await fixture(async (_url, init) => { calls.push(init); return response(200, {sha: 'remote'}); }, {config});
    assert.equal(await f.sync.pushNow(), false);
    f.sync.schedule();
    await new Promise(done => setTimeout(done, 12));
    assert.equal(calls.length, 1);
    assert.equal(f.statuses.at(-1).kind, 'conflict');
    assert.match(f.statuses.at(-1).message, /恢复|覆盖/);
  }
});

test('a removed accepted remote backup is also a conflict', async () => {
  const f = await fixture(async () => response(404), {config: {sha: 'known'}});
  assert.equal(await f.sync.pushNow(), false);
  assert.equal(f.statuses.at(-1).kind, 'conflict');
});

test('explicit overwrite uses exactly the SHA read that round and never retries 409 or 422', async () => {
  for (const code of [409, 422]) {
    const calls = [];
    const f = await fixture(async (_url, init) => { calls.push(init); return init.method === 'PUT' ? response(code) : response(200, {sha: 'just-read'}); });
    assert.equal(await f.sync.pushNow({overwrite: true}), false);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].body).sha, 'just-read');
    assert.equal(f.statuses.at(-1).kind, 'conflict');
    f.sync.schedule();
    await new Promise(done => setTimeout(done, 12));
    assert.equal(calls.length, 2);
  }
});

test('changes made while a snapshot is uploading are sent once the first upload finishes', async () => {
  const gate = deferred(), uploads = [];
  let remoteSha = 'baseline';
  const f = await fixture(async (_url, init) => {
    if (init.method !== 'PUT') return response(200, {sha: remoteSha});
    uploads.push(readPayload(init));
    if (uploads.length === 1) await gate.promise;
    remoteSha = 'sha-' + uploads.length;
    return response(200, {content: {sha: remoteSha}});
  }, {config: {sha: remoteSha}});
  const first = f.sync.pushNow();
  await until(() => uploads.length === 1);
  f.change({log: [{xp: 8}, {xp: 13}]});
  f.sync.schedule();
  gate.resolve();
  assert.equal(await first, true);
  await until(() => uploads.length === 2 && f.config().sha === 'sha-2');
  assert.equal(uploads[0].log.length, 1);
  assert.equal(uploads[1].log.length, 2);
});

test('snapshot is frozen before the preliminary GET finishes', async () => {
  const gate = deferred(), started = deferred();
  let uploaded;
  const f = await fixture(async (_url, init) => {
    if (init.method === 'PUT') { uploaded = readPayload(init); return response(201, {content: {sha: 'one'}}); }
    started.resolve(); await gate.promise; return response(404);
  });
  const job = f.sync.pushNow();
  await started.promise;
  f.change({log: []});
  gate.resolve();
  assert.equal(await job, true);
  assert.equal(uploaded.log.length, 1);
});

test('schedule debounces rapid local changes', async () => {
  let puts = 0;
  const f = await fixture(async (_url, init) => init.method === 'PUT' ? (puts++, response(201, {content: {sha: 'one'}})) : response(404));
  f.sync.schedule(); f.sync.schedule(); f.sync.schedule();
  assert.equal(puts, 0);
  await until(() => puts === 1);
  f.sync.stop();
});

test('download decodes UTF-8 without accepting unvalidated remote state', async () => {
  const state = {log: [{text: '复习 🌙'}]};
  const f = await fixture(async () => response(200, {sha: 'remote', encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64').replace(/(.{12})/g, '$1\n')}));
  assert.deepEqual(await f.sync.download(), {state, sha: 'remote'});
  assert.equal(f.config().sha, undefined);
  assert.equal(f.sync.acceptRemote('remote'), true);
  assert.equal(f.config().sha, 'remote');
});

test('download waits for an active upload and holds scheduled uploads until remote acceptance', async () => {
  const gate = deferred(), calls = [];
  let remoteSha = 'base';
  const f = await fixture(async (_url, init) => {
    calls.push(init.method || 'GET');
    if (init.method === 'PUT') { await gate.promise; remoteSha = 'after'; return response(200, {content: {sha: remoteSha}}); }
    return response(200, {sha: remoteSha, content: Buffer.from('{"log":[]}').toString('base64'), encoding: 'base64'});
  }, {config: {sha: 'base'}});
  const pushing = f.sync.pushNow();
  await until(() => calls.includes('PUT'));
  const downloading = f.sync.download();
  f.sync.schedule();
  await tick();
  assert.deepEqual(calls, ['GET', 'PUT']);
  gate.resolve();
  await pushing;
  assert.equal((await downloading).sha, 'after');
  await new Promise(done => setTimeout(done, 12));
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
  f.sync.acceptRemote('after');
});

test('HTTP, network, malformed content and timeout failures are visible and settle safely', async () => {
  for (const fetchImpl of [async () => response(401), async () => {throw new Error('offline');}, async () => response(200, {unexpected: true}), () => new Promise(() => {})]) {
    const f = await fixture(fetchImpl, {timeoutMs: 10});
    assert.equal(await f.sync.pushNow(), false);
    assert.equal(f.statuses.at(-1).kind, 'error');
    assert.match(f.statuses.at(-1).message, /token|网络|响应|超时/);
  }
});

test('invalid or missing remote backups report download errors without changing baseline', async () => {
  for (const result of [response(404), response(200, {sha: 's', content: 'not-base64'}), response(200, {sha: 's', content: Buffer.from('not json').toString('base64')})]) {
    const f = await fixture(async () => result);
    assert.equal(await f.sync.download(), null);
    assert.equal(f.statuses.at(-1).kind, 'error');
    assert.equal(f.saved.length, 0);
  }
});

test('stop cancels pending work and prevents a GET result from initiating a PUT', async () => {
  const gate = deferred(), calls = [];
  const f = await fixture(async (_url, init) => {calls.push(init); await gate.promise; return response(404);});
  const pushing = f.sync.pushNow();
  await until(() => calls.length === 1);
  f.sync.schedule(); f.sync.stop(); gate.resolve();
  assert.equal(await pushing, false);
  f.sync.schedule(); assert.equal(await f.sync.pushNow(), false);
  await new Promise(done => setTimeout(done, 12));
  assert.equal(calls.length, 1);
  assert.equal(f.saved.length, 0);
});

test('stop after PUT was sent avoids saving its result and discloses that the request may have reached GitHub', async () => {
  const gate = deferred();
  let putting = false;
  const f = await fixture(async (_url, init) => {
    if (init.method !== 'PUT') return response(404);
    putting = true; await gate.promise; return response(201, {content: {sha: 'late'}});
  });
  const pushing = f.sync.pushNow(); await until(() => putting);
  f.sync.schedule(); f.sync.stop(); gate.resolve();
  assert.equal(await pushing, false);
  assert.equal(f.saved.length, 0);
  assert.equal(f.statuses.at(-1).kind, 'idle');
  assert.match(f.statuses.at(-1).message, /已发出|可能/);
});

test('removing the token during GET prevents upload without requiring stop()', async () => {
  const gate = deferred(), calls = [];
  const f = await fixture(async (_url, init) => {calls.push(init); await gate.promise; return response(404);});
  const job = f.sync.pushNow(); await until(() => calls.length === 1);
  f.disable(); gate.resolve();
  assert.equal(await job, false);
  assert.equal(calls.length, 1);
  assert.equal(f.saved.length, 0);
});

test('stop cancels a debounce timer before any request is sent', async () => {
  let calls = 0;
  const f = await fixture(async () => {calls++; return response(404);});
  f.sync.schedule(); f.sync.stop();
  await new Promise(done => setTimeout(done, 12));
  assert.equal(calls, 0);
});

test('manual pushes queue behind each other using the preceding successful SHA', async () => {
  const gate = deferred(), uploads = [];
  let remote = null;
  const f = await fixture(async (_url, init) => {
    if (init.method !== 'PUT') return remote ? response(200, {sha: remote}) : response(404);
    uploads.push(JSON.parse(init.body));
    if (uploads.length === 1) await gate.promise;
    remote = 'sha-' + uploads.length;
    return response(201, {content: {sha: remote}});
  });
  const first = f.sync.pushNow(); await until(() => uploads.length === 1);
  f.change({log: [{xp: 20}]});
  const second = f.sync.pushNow(); gate.resolve();
  assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].sha, 'sha-1');
  assert.deepEqual(JSON.parse(Buffer.from(uploads[1].content, 'base64').toString('utf8')), {log: [{xp: 20}]});
});

test('timeouts cover a stalled response body and never process late network results', async () => {
  const late = deferred();
  let calls = 0;
  const f = await fixture(async () => {calls++; return {ok: true, json: () => late.promise};}, {timeoutMs: 10});
  assert.equal(await f.sync.pushNow(), false);
  late.resolve({sha: 'late'}); await tick();
  assert.equal(calls, 1); assert.equal(f.saved.length, 0);
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.match(f.statuses.at(-1).message, /超时/);
});

test('failed config persistence is visible instead of claiming the sync baseline was saved', async () => {
  for (const saveConfig of [() => false, () => {throw new Error('storage full');}]) {
    const f = await fixture(async (_url, init) => init.method === 'PUT' ? response(201, {content: {sha: 'remote-written'}}) : response(404), {saveConfig});
    assert.equal(await f.sync.pushNow(), false);
    assert.equal(f.statuses.at(-1).kind, 'error');
    assert.match(f.statuses.at(-1).message, /基线|配置|本地/);
  }
});
