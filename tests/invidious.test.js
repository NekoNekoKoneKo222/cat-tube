'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InvidiousCluster, instanceList } = require('../lib/invidious');

function fakeFetch(delays, failures = []) {
  return (url, { signal }) => new Promise((resolve, reject) => {
    const origin = new URL(url).origin;
    const delay = delays[origin] ?? 10;
    const timer = setTimeout(() => {
      if (failures.includes(origin)) return resolve({
        ok: false, status: 503, headers: { get: () => null }
      });
      resolve({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify([{ videoId: 'abcdefghijk', title: origin }])
      });
    }, delay);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

const a = 'https://inv.nadeko.net';
const b = 'https://invidious.nerdvpn.de';

test('selects the first valid response, not the first configured instance', async () => {
  const cluster = new InvidiousCluster({ instances: [a, b], fetchImpl: fakeFetch({ [a]: 70, [b]: 5 }) });
  const result = await cluster.get('/api/v1/trending?region=JP', Array.isArray);
  assert.equal(result.instance, b);
  assert.equal(result.data[0].title, b);
  assert.equal(cluster.nodes[0].failures, 0); // aborted losers must not be penalized
});

test('fails over to a working instance', async () => {
  const cluster = new InvidiousCluster({ instances: [a, b], fetchImpl: fakeFetch({ [a]: 1, [b]: 9 }, [a]) });
  const result = await cluster.get('/api/v1/trending', Array.isArray);
  assert.equal(result.instance, b);
  assert.ok(cluster.nodes[0].blockedUntil > Date.now());
});

test('returns cached results without another fetch', async () => {
  let calls = 0;
  const cluster = new InvidiousCluster({
    instances: [a],
    fetchImpl: (...args) => { calls += 1; return fakeFetch({ [a]: 2 })(...args); }
  });
  await cluster.get('/api/v1/trending', Array.isArray);
  const result = await cluster.get('/api/v1/trending', Array.isArray);
  assert.equal(calls, 1);
  assert.equal(result.cached, true);
});

test('requires valid origins and blocks paths and credentials', () => {
  assert.deepEqual(instanceList([a, a, 'https://user:pass@example.com', 'https://example.com/private', 'file:///tmp']), [a]);
});

test('rejects when every backend fails', async () => {
  const cluster = new InvidiousCluster({ instances: [a], fetchImpl: fakeFetch({ [a]: 1 }, [a]) });
  await assert.rejects(() => cluster.get('/api/v1/trending', Array.isArray), /すべての/);
});
