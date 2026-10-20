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
  console.error('[Invidious]', error.message);
  res.status(503).json({ error: error.message, instances: cluster.status() });
}

function wrap(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(error => sendError(res, error));
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'cat-tube' }));
app.get('/api/instances', (req, res) => res.json({ instances: cluster.status() }));

app.get('/api/trending', wrap(async (req, res) => {
  const allowed = ['default', 'music', 'gaming', 'movies'];
  const type = allowed.includes(req.query.type) ? req.query.type : 'default';
  const path = '/api/v1/trending?region=JP&type=' + type;
  const result = await cluster.get(path, Array.isArray, 45000);
  res.json(result);
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: '検索語を入力してください' });
  const page = Math.min(20, Math.max(1, parseInt(req.query.page, 10) || 1));
  const path = '/api/v1/search?q=' + encodeURIComponent(q) + '&page=' + page + '&type=all&region=JP&hl=ja';
  const result = await cluster.get(path, Array.isArray, 30000);
  res.json(result);
}));

app.get('/api/videos/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: '不正な動画 ID' });
  const result = await cluster.get('/api/v1/videos/' + id + '?region=JP&hl=ja', data => !!data && data.videoId === id, 30000);
  res.json(result);
}));

app.get('/api/channels/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(id)) return res.status(400).json({ error: '不正なチャンネル ID' });
  const result = await cluster.get('/api/v1/channels/' + id + '?hl=ja', data => !!data && typeof data.author === 'string', 60000);
  res.json(result);
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
