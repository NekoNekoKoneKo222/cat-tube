'use strict';

const express = require('express');
const path = require('path');
const { InvidiousCluster, parseListing, parseChannel } = require('./lib/invidious');

const app = express();
const cluster = new InvidiousCluster();
const PORT = Number(process.env.PORT || 3000);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function wrap(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(error => {
    console.error('[Cat Tube HTML]', error.message);
    res.status(503).json({
      error: error.message,
      instances: cluster.status(),
      hint: '各 Invidious サーバーの Web 検索と動画ページに接続しています。YouTube Data API や Invidious API は使用していません。'
    });
  });
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'cat-tube', source: 'invidious-html' }));
app.get('/cat/instances', wrap(async (req, res) => {
  if (req.query.refresh === '1') await cluster.probeAll();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    instances: cluster.status(),
    source: 'html',
    lastProbeAt: cluster.lastProbeAt ? new Date(cluster.lastProbeAt).toISOString() : null
  });
}));

app.get('/cat/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: '検索語を入力してください' });
  const page = Math.min(20, Math.max(1, parseInt(req.query.page, 10) || 1));
  const route = '/search?q=' + encodeURIComponent(q) + '&page=' + page;
  res.json(await cluster.get(route, parseListing, 'search', 25000));
}));

app.get('/cat/trending', wrap(async (req, res) => {
  const kind = ['default','music','gaming','movies'].includes(req.query.type) ? req.query.type : 'default';
  const cat = { default:'Default', music:'Music', gaming:'Gaming', movies:'Movies' }[kind];
  try {
    const result = await cluster.get('/feed/trending?region=JP&type=' + cat, html => parseListing(html, { allowEmpty: false }), 'search', 30000);
    res.json(result);
  } catch (error) {
    // Make fallback explicit: search results are not the official trending ranking.
    const terms = { default:'人気 動画',music:'音楽',gaming:'ゲーム実況',movies:'映画 予告' };
    const result = await cluster.get('/search?q=' + encodeURIComponent(terms[kind]), html => parseListing(html, { allowEmpty: false }), 'search', 25000);
    res.json({ ...result, fallbackKind: 'search', note: '急上昇ページが取得できないため、代わりに検索結果を表示しています。' });
  }
}));

app.get('/cat/videos/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!VIDEO_ID.test(id)) return res.status(400).json({ error: '不正な動画 ID' });
  const requestedInstance = typeof req.query.instance === 'string' ? req.query.instance : null;
  try {
    // Omitted instance races all backends. With an instance, fetch fresh HTML
    // from that one only, then extract *its own* HTML5 <video> source URLs.
    const result = await cluster.getVideo(id, requestedInstance);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...result, player: 'html5', videoServers: [result.instance, ...cluster.videoServers().filter(x => x !== result.instance)] });
  } catch (error) {
    // Explicit server switches must fail so the client can try another instance.
    if (requestedInstance) throw error;
    const servers = cluster.videoServers();
    res.json({
      instance: servers[0],
      videoServers: servers,
      latencyMs: null,
      cached: false,
      fallback: true,
      player: 'html5',
      warning: '動画ページから HTML5 再生ソースを取得できません。接続先サーバーを変更して再試行してください。',
      data: {
        videoId: id, title: '動画 ' + id, author: '情報を取得できません',
        description: '', lengthSeconds: 0, formatStreams: [], recommendedVideos: []
      }
    });
  }
}));

app.get('/cat/channels/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!CHANNEL_ID.test(id)) return res.status(400).json({ error: '不正なチャンネル ID' });
  const route = '/channel/' + id;
  res.json(await cluster.get(route, html => parseChannel(html, id), 'search', 30000));
}));

app.use('/cat', (req, res) => res.status(404).json({ error: 'ページが見つかりません' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('Cat Tube listening on port ' + PORT);
    console.log('HTML sources: ' + cluster.nodes.map(n => n.url).join(', '));
  });
}
module.exports = { app, cluster };
