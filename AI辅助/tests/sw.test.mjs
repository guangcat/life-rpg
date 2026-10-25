import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/life-rpg/';
const required = ['./', './index.html', './app.css', './app.mjs', './modules/state.mjs', './modules/sync.mjs', './modules/audio.mjs', './modules/calendar.mjs', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
function harness(fetchImpl = async () => new Response('static')) {
  const handlers = {}, buckets = new Map(), calls = [];
  let skipped = 0, claimed = 0;
  const key = value => new URL(typeof value === 'string' ? value : value.url, scope).href;
  const cache = name => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const bucket = buckets.get(name);
    return {put: async (request, res) => {bucket.set(key(request), res.clone());}, match: async request => bucket.get(key(request))?.clone()};
  };
  const caches = {open: async name => cache(name), keys: async () => [...buckets.keys()], delete: async name => buckets.delete(name), match: async request => {for (const bucket of buckets.values()) {if (bucket.has(key(request))) return bucket.get(key(request)).clone();}}};
  const self = {registration: {scope}, location: new URL(scope + 'sw.js'), addEventListener: (type, handler) => {handlers[type] = handler;}, skipWaiting: async () => {skipped++;}, clients: {claim: async () => {claimed++;}}};
  vm.runInNewContext(source, {self, caches, URL, Request, Response, Set, Promise, fetch: async (request, init) => {calls.push({url: key(request), init}); return fetchImpl(request, init);}});
  const event = async (type, extra = {}) => {let pending; handlers[type]({...extra, waitUntil: promise => {pending = promise;}}); await pending;};
  const fetchEvent = async (url, options = {}) => {
    let pending;
    const request = {url: new URL(url, scope).href, method: 'GET', mode: 'cors', ...options};
    handlers.fetch({request, respondWith: promise => {pending = promise;}, waitUntil: () => {}});
    return pending ? {handled: true, response: await pending} : {handled: false};
  };
  return {event, fetchEvent, cache, buckets, calls, skipped: () => skipped, claimed: () => claimed};
}

test('install fetches and caches every required application file with reload', async () => {
  const sw = harness(); await sw.event('install');
  assert.deepEqual(sw.calls.map(call => call.url).sort(), required.map(path => new URL(path, scope).href).sort());
  assert.ok(sw.calls.every(call => call.init.cache === 'reload'));
  assert.equal(sw.buckets.size, 1);
  assert.equal([...sw.buckets.values()][0].size, required.length);
  assert.equal(sw.skipped(), 0);
});

test('install fails when any core module cannot be fetched', async () => {
  const sw = harness(async request => String(request).includes('modules/sync.mjs') ? new Response('missing', {status: 404}) : new Response('static'));
  await assert.rejects(sw.event('install'));
});

test('updating worker waits for an explicit update message', async () => {
  const sw = harness(); await sw.event('install'); assert.equal(sw.skipped(), 0);
  await sw.event('message', {data: {type: 'OTHER'}}); assert.equal(sw.skipped(), 0);
  await sw.event('message', {data: {type: 'SKIP_WAITING'}}); assert.equal(sw.skipped(), 1);
});

test('activation removes only old Life RPG caches', async () => {
  const sw = harness(); await sw.event('install');
  const current = [...sw.buckets.keys()][0];
  await sw.cache('liferpg-old').put('./old', new Response('old'));
  await sw.cache('another-app').put('./other', new Response('other'));
  await sw.event('activate');
  assert.deepEqual([...sw.buckets.keys()].sort(), ['another-app', current].sort());
  assert.equal(sw.claimed(), 1);
});

test('API, personal files, cross-origin, outside-scope and writes are never intercepted or cached', async () => {
  const sw = harness(); await sw.event('install'); const count = sw.calls.length;
  for (const [url, options] of [['https://api.github.com/repos/x/y/contents/backup.json', {}], ['./backup/latest.json', {}], ['./state.json', {}], ['/other/app.mjs', {}], ['https://other.test/life-rpg/app.mjs', {}], ['./app.mjs', {method: 'PUT'}]]) {
    assert.equal((await sw.fetchEvent(url, options)).handled, false, url);
  }
  assert.equal(sw.calls.length, count);
});

test('static resources are served from this worker cache and ignore query versions safely', async () => {
  let networkCalls = 0;
  const sw = harness(async () => {networkCalls++; return new Response('cached-module');});
  await sw.event('install'); const count = networkCalls;
  const result = await sw.fetchEvent('./modules/sync.mjs?v=2');
  assert.equal(result.handled, true);
  assert.equal(await result.response.text(), 'cached-module');
  assert.equal(networkCalls, count);
});

test('only offline navigations get the cached index fallback', async () => {
  let offline = false;
  const sw = harness(async () => {if (offline) throw new Error('offline'); return new Response('app-index');});
  await sw.event('install'); offline = true;
  const nav = await sw.fetchEvent('./some-route?demo=1', {mode: 'navigate'});
  assert.equal(await nav.response.text(), 'app-index');
  const current = [...sw.buckets.keys()][0];
  sw.buckets.get(current).delete(new URL('./modules/sync.mjs', scope).href);
  await assert.rejects(sw.fetchEvent('./modules/sync.mjs'), /offline/);
  assert.equal((await sw.fetchEvent('./missing.png')).handled, false);
});

test('online navigation errors keep their HTTP status and are never replaced by an old index', async () => {
  const sw = harness(async (_request, init) => init ? new Response('app-index') : new Response('not found', {status: 404}));
  await sw.event('install');
  const nav = await sw.fetchEvent('./unknown', {mode: 'navigate'});
  assert.equal(nav.response.status, 404);
  assert.equal(await nav.response.text(), 'not found');
});

test('app navigation keeps the active cached HTML together with its cached modules', async () => {
  let version='old';const sw=harness(async()=>new Response(version));await sw.event('install');
  version='new';const nav=await sw.fetchEvent('./?demo=1',{mode:'navigate'});
  assert.equal(await nav.response.text(),'old');
  const module=await sw.fetchEvent('./app.mjs');assert.equal(await module.response.text(),'old');
});
