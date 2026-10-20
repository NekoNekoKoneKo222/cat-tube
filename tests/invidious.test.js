'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InvidiousCluster, instanceList, parseListing, parseWatch, parseChannel
} = require('../lib/invidious');

const a = 'https://inv.nadeko.net';
const b = 'https://invidious.nerdvpn.de';
const card = [
  '<div class="pure-g">',
  '<div class="pure-u-1 pure-u-md-1-4"><div class="h-box">',
  '<div class="thumbnail"><a href="/watch?v=abcdefghijk"><img class="thumbnail" src="/vi/abcdefghijk/mqdefault.jpg"></a>',
  '<div class="bottom-right-overlay"><p class="length">12:34</p></div></div>',
  '<div class="video-card-row"><a href="/watch?v=abcdefghijk"><p>猫の動画 &amp; テスト</p></a></div>',
  '<div class="video-card-row flexible"><a href="/channel/UCaaaaaaaaaaaaaaaaaaaaaa"><p class="channel-name">Example Channel</p></a></div>',
  '<div class="video-card-row flexible"><p class="video-data">23,456 views</p></div>',
  '</div></div></div>'
].join('');
const searchHTML = '<html><head><title>Search - Invidious</title></head><body>' + card + '</body></html>';
const watchHTML = [
  '<html><head>',
  '<meta property="og:title" content="動画テスト">',
  '<meta property="og:description" content="説明">',
  '<meta property="og:site_name" content="Example Channel | Invidious">',
  '</head><body><script id="video_data" type="application/json">{"id":"abcdefghijk","length_seconds":93}</script>',
  '<div id="player-container"><video id="player"><source src="/latest_version?id=abcdefghijk&amp;itag=18" type="video/mp4" label="360p" selected="true"></video></div>',
  '<a href="/channel/UCaaaaaaaaaaaaaaaaaaaaaa">Example Channel</a>',
  '</body></html>'
].join('');
const channelHTML = '<html><head><meta property="og:title" content="Example Channel"></head><body>' + card + '</body></html>';
const invalidHTML = '<!doctype html><html><title>Just a moment...</title><body>Cloudflare</body></html>';

function mockFetch({ delays = {}, failures = {}, pageHTML = searchHTML } = {}) {
  return (uri, { signal }) => new Promise((resolve, reject) => {
    const host = new URL(uri).origin;
    const timer = setTimeout(() => {
      const status = failures[host] || 200;
      resolve({
        ok: status === 200, status,
        headers: { get: key => key === 'content-type' ? 'text/html' : null },
        text: async () => typeof pageHTML === 'function' ? pageHTML(uri) : pageHTML
      });
    }, delays[host] ?? 4);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

test('parses Invidious search HTML into actual video cards', () => {
  const result = parseListing(searchHTML);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    type: 'video', videoId: 'abcdefghijk', title: '猫の動画 & テスト',
    author: 'Example Channel', authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    lengthSeconds: 754, viewCount: 23456, published: null
  });
});

test('rejects a challenge page even when HTTP status is 200', () => {
  assert.throws(() => parseListing(invalidHTML), /エラー|HTML/);
});

test('rejects an arbitrary homepage without results', () => {
  assert.throws(() => parseListing('<html><body>hello</body></html>'));
});

test('extracts progressive HTML5 video sources from the normal watch page', () => {
  const data = parseWatch(watchHTML, 'abcdefghijk');
  assert.equal(data.title, '動画テスト');
  assert.equal(data.lengthSeconds, 93);
  assert.equal(data.formatStreams.length, 1);
  assert.equal(data.formatStreams[0].url, '/latest_version?id=abcdefghijk&itag=18');
  assert.equal(data.formatStreams[0].type, 'video/mp4');
  assert.throws(() => parseWatch(watchHTML, 'xxxxxxxxxxx'), /動画ページ/);
  assert.throws(() => parseWatch('<html>fake</html>', 'abcdefghijk'), /動画ページ/);
});

test('rejects HTML watch pages without a playable HTML5 source', () => {
  const unplayable = watchHTML.replace(/<source[^>]+>/, '');
  assert.throws(() => parseWatch(unplayable, 'abcdefghijk'), /再生ソース/);
});

test('prevents an external or unrelated source from being used by the player', () => {
  const foreign = watchHTML.replace(
    '/latest_version?id=abcdefghijk&amp;itag=18',
    'https://untrusted.example/latest_version?id=abcdefghijk&amp;itag=18'
  );
  assert.throws(() => parseWatch(foreign, 'abcdefghijk'), /再生ソース/);
  const mismatched = watchHTML.replace('id=abcdefghijk&amp;itag=18', 'id=different12&amp;itag=18');
  assert.throws(() => parseWatch(mismatched, 'abcdefghijk'), /再生ソース/);
});

test('resolves media URLs against the fastest valid Invidious instance', async () => {
  const cluster = new InvidiousCluster({
    instances: [a,b],
    fetchImpl: mockFetch({
      delays: { [a]: 70, [b]: 3 },
      pageHTML: watchHTML
    })
  });
  const result = await cluster.getVideo('abcdefghijk');
  assert.equal(result.instance, b);
  assert.equal(result.data.formatStreams[0].url, b + '/latest_version?id=abcdefghijk&itag=18');
});

test('refetches the watch HTML when manually switching to another configured instance', async () => {
  const cluster = new InvidiousCluster({
    instances: [a,b],
    fetchImpl: mockFetch({ pageHTML: watchHTML })
  });
  const response = await cluster.getVideo('abcdefghijk', a);
  assert.equal(response.instance, a);
  assert.equal(response.data.formatStreams[0].url.startsWith(a + '/latest_version'), true);
  await assert.rejects(
    () => cluster.getVideo('abcdefghijk', 'https://untrusted.example'),
    /許可されていない/
  );
});

test('parses channel HTML and its videos', () => {
  const data = parseChannel(channelHTML, 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(data.author, 'Example Channel');
  assert.equal(data.latestVideos.length, 1);
});

test('races actual HTML search responses and selects fastest valid page', async () => {
  const cluster = new InvidiousCluster({
    instances: [a, b], fetchImpl: mockFetch({ delays: { [a]: 90, [b]: 5 } })
  });
  const response = await cluster.get('/search?q=cats', parseListing);
  assert.equal(response.instance, b);
  assert.equal(response.data[0].title, '猫の動画 & テスト');
  assert.equal(cluster.nodes[0].searchStatus, 'unchecked');
});

test('falls back when the first server has a blocked HTML page', async () => {
  const cluster = new InvidiousCluster({
    instances: [a, b],
    fetchImpl: mockFetch({
      delays: { [a]: 1, [b]: 12 },
      pageHTML: url => url.startsWith(a) ? invalidHTML : searchHTML
    })
  });
  const response = await cluster.get('/search?q=cats', parseListing);
  assert.equal(response.instance, b);
  const status = cluster.status()[0];
  assert.equal(status.searchStatus, 'error');
  assert.equal(status.lastHttpStatus, 200);
  assert.ok(status.searchLatencyMs != null);
});

test('reports HTML failures and their elapsed time, not unchecked forever', async () => {
  const cluster = new InvidiousCluster({
    instances: [a, b], fetchImpl: mockFetch({ failures: { [a]: 403, [b]: 503 } })
  });
  const statuses = await cluster.probeAll();
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].searchStatus, 'error');
  assert.equal(statuses[0].lastHttpStatus, 403);
  assert.equal(statuses[1].lastHttpStatus, 503);
  assert.ok(Number.isFinite(statuses[0].searchLatencyMs));
  assert.equal(statuses[0].available, false);
});

test('uses cache for duplicate page searches', async () => {
  let calls = 0;
  const fetcher = mockFetch();
  const cluster = new InvidiousCluster({
    instances: [a], fetchImpl: (...args) => { calls++; return fetcher(...args); }
  });
  await cluster.get('/search?q=cats', parseListing);
  assert.equal((await cluster.get('/search?q=cats', parseListing)).cached, true);
  assert.equal(calls, 1);
});

test('does not allow user-supplied origins with paths or credentials', () => {
  assert.deepEqual(instanceList([a, a, 'https://a:b@example.org', 'file:///foo', 'https://example.org/evil']), [a]);
});

test('rejects all failed search pages, without using an Invidious API', async () => {
  let apiRequestMade = false;
  const fetcher = (url, opts) => {
    if (url.includes('/api/v1/')) apiRequestMade = true;
    return mockFetch({ failures: { [a]: 403 } })(url, opts);
  };
  const cluster = new InvidiousCluster({ instances: [a], fetchImpl: fetcher });
  await assert.rejects(() => cluster.get('/search?q=test', parseListing), /通常ページ/);
  assert.equal(apiRequestMade, false);
});
