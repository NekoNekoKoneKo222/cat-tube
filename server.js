'use strict';

const express = require('express');
const path = require('path');
const { InvidiousCluster } = require('./lib/invidious');

const app = express();
const cluster = new InvidiousCluster();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function sendError(res, error) {
  console.error('[Cat Tube API]', error.message);
  return res.status(503).json({
    error: error.message,
    instances: cluster.status(),
    hint: '公開 Invidious インスタンスの API が無効な場合、各インスタンスの Web サイトから検索してください。'
  });
}
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(error => sendError(res, error));
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'cat-tube' }));
app.get('/api/instances', wrap(async (req, res) => {
  // A real API test, not a static flag or just checking the homepage.
  if (req.query.refresh === '1') await cluster.probeAll();
  const instances = cluster.status();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    instances,
    apiAvailableCount: instances.filter(x => x.available).length,
    websiteAvailableCount: instances.filter(x => x.websiteStatus === 'ok').length,
    lastProbeAt: cluster.lastProbeAt ? new Date(cluster.lastProbeAt).toISOString() : null
  });
}));

app.get('/api/trending', wrap(async (req, res) => {
  const allowed = ['default', 'music', 'gaming', 'movies'];
  const type = allowed.includes(req.query.type) ? req.query.type : 'default';
  const result = await cluster.get('/api/v1/trending?region=JP&type=' + type, Array.isArray, 45000);
  res.json(result);
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: '検索語を入力してください' });
  const page = Math.min(20, Math.max(1, parseInt(req.query.page, 10) || 1));
  const route = '/api/v1/search?q=' + encodeURIComponent(q) + '&page=' + page + '&type=all&region=JP&hl=ja';
  const result = await cluster.get(route, Array.isArray, 30000);
  res.json(result);
}));

app.get('/api/videos/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: '不正な動画 ID' });
  try {
    const result = await cluster.get('/api/v1/videos/' + id + '?region=JP&hl=ja', data => !!data && data.videoId === id, 30000);
    res.json(result);
  } catch (error) {
    // The embedded video can still be attempted if metadata APIs are switched off.
    const instance = cluster.bestWebsite();
    res.json({
      instance, latencyMs: null, fallback: true, cached: false,
      warning: '動画情報 API に接続できません。Invidious 埋め込みまたは YouTube 公式プレイヤーで再生を試してください。',
      data: {
        videoId: id, title: '動画 ' + id, author: '動画情報を取得できません',
        description: '', formatStreams: [], recommendedVideos: []
      }
    });
  }
}));

app.get('/api/channels/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(id)) return res.status(400).json({ error: '不正なチャンネル ID' });
  res.json(await cluster.get('/api/v1/channels/' + id + '?hl=ja', data => !!data && typeof data.author === 'string', 60000));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API が見つかりません' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('Cat Tube listening on port ' + PORT);
    console.log('Invidious instances: ' + cluster.nodes.map(n => n.url).join(', '));
  });
}
module.exports = { app, cluster };
