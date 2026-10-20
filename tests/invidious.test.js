'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InvidiousCluster, instanceList } = require('../lib/invidious');
const a = 'https://inv.nadeko.net', b = 'https://invidious.nerdvpn.de';

function fakeFetch(delays, failures = []) {
  return (url, { signal, method }) => new Promise((resolve, reject) => {
    const origin = new URL(url).origin;
    const timer = setTimeout(() => {
      const status = failures.includes(origin) && method !== 'HEAD' ? 403 : 200;
      resolve({
        status, ok: status === 200,
        headers: { get: () => null },
        text: async () => JSON.stringify([{ videoId: 'abcdefghijk', title: origin }])
      });
    }, delays[origin] ?? 5);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

test('uses fastest valid response rather than configured order', async () => {
  const c = new InvidiousCluster({instances:[a,b],fetchImpl:fakeFetch({[a]:70,[b]:5})});
  const result = await c.get('/api/v1/trending', Array.isArray);
  assert.equal(result.instance,b);
  assert.equal(c.nodes[0].apiStatus,'unchecked');
});
test('fails over and records latency and reason for a failed API', async () => {
  const c = new InvidiousCluster({instances:[a,b],fetchImpl:fakeFetch({[a]:1,[b]:10},[a])});
  const result = await c.get('/api/v1/trending',Array.isArray);
  assert.equal(result.instance,b);
  assert.equal(c.nodes[0].apiStatus,'error');
  assert.equal(c.nodes[0].httpStatus,403);
  assert.ok(Number.isFinite(c.nodes[0].latencyMs));
});
test('probes every website and API even if API is disabled', async () => {
  const c = new InvidiousCluster({instances:[a,b],fetchImpl:fakeFetch({[a]:1,[b]:1},[a,b])});
  const statuses = await c.probeAll();
  assert.equal(statuses.length,2);
  for (const s of statuses) {
    assert.equal(s.apiStatus,'error');
    assert.equal(s.websiteStatus,'ok');
    assert.equal(s.httpStatus,403);
    assert.ok(Number.isFinite(s.latencyMs));
    assert.equal(s.available,false);
  }
});
test('does not re-probe immediately by default', async () => {
  let calls=0;
  const f=fakeFetch({[a]:1});
  const c=new InvidiousCluster({instances:[a],fetchImpl:(...args)=>{calls++;return f(...args);}});
  await c.probeAll();
  await c.probeAll();
  assert.equal(calls,2);
});
test('caches successful results', async () => {
  let calls=0;
  const f=fakeFetch({[a]:1});
  const c=new InvidiousCluster({instances:[a],fetchImpl:(...args)=>{calls++;return f(...args);}});
  await c.get('/api/v1/trending',Array.isArray);
  assert.equal((await c.get('/api/v1/trending',Array.isArray)).cached,true);
  assert.equal(calls,1);
});
test('rejects all unavailable APIs and does not falsely report available', async () => {
  const c=new InvidiousCluster({instances:[a],fetchImpl:fakeFetch({[a]:1},[a])});
  await assert.rejects(()=>c.get('/api/v1/trending',Array.isArray),/利用可能な/);
  assert.equal(c.status()[0].available,false);
});
test('normalizes and validates trusted HTTPS origins', () => {
  assert.deepEqual(instanceList([a,a,'file:///tmp','https://user:pw@example.org','https://example.org/hidden']),[a]);
});
