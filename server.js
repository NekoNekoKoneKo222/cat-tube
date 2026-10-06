'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
  imgSrc: ["'self'", 'https://i.ytimg.com', 'data:'],
  connectSrc: ["'self'"], frameSrc: ['https://www.youtube-nocookie.com'],
  objectSrc: ["'none'"], baseUri: ["'self'"],
} } }));
app.use(express.static(path.join(__dirname, 'public')));

const key = process.env.YOUTUBE_API_KEY;
const apiRoot = 'https://www.googleapis.com/youtube/v3/';
const allowed = new Set(['search', 'videos', 'channels', 'playlists', 'playlistItems']);
function cleanId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(value) ? value : null; }
function cleanQuery(value) { return typeof value === 'string' ? value.trim().slice(0, 120) : ''; }
function cleanPageToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_=-]{1,200}$/.test(value) ? value : ''; }

app.get('/healthz', (_req, res) => res.json({ ok: true, youtubeConfigured: Boolean(key) }));
app.get('/api/config', (_req, res) => res.set('Cache-Control', 'no-store').json({ youtubeConfigured: Boolean(key) }));
app.get('/api/youtube/:resource', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const resource = req.params.resource;
  if (!allowed.has(resource)) return res.status(404).json({ error: 'APIがありません' });
  if (!key) return res.status(503).json({ error: 'YOUTUBE_API_KEYが未設定です' });
  const params = new URLSearchParams({ key, maxResults: '20' });
  const id = cleanId(req.query.id);
  const query = cleanQuery(req.query.q);
  const token = cleanPageToken(req.query.pageToken);
  if (token) params.set('pageToken', token);
  if (resource === 'search') {
    if (!query) return res.status(400).json({ error: '検索語が必要です' });
    params.set('part', 'snippet'); params.set('q', query);
    params.set('type', req.query.type === 'channel' ? 'channel' : req.query.type === 'playlist' ? 'playlist' : 'video');
    params.set('safeSearch', 'moderate');
    if (req.query.channelId && cleanId(req.query.channelId)) params.set('channelId', req.query.channelId);
    if (req.query.duration === 'short') params.set('videoDuration', 'short');
  } else {
    if (!id) return res.status(400).json({ error: '有効なIDが必要です' });
    params.set('part', resource === 'videos' ? 'snippet,contentDetails,statistics' : 'snippet,contentDetails');
    if (resource === 'playlistItems') params.set('playlistId', id);
    else params.set('id', id);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try { response = await fetch(apiRoot + resource + '?' + params, { signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    const data = await response.json();
    if (!response.ok) return res.status(response.status >= 500 ? 502 : response.status).json({ error: data.error?.message || 'YouTube APIエラー' });
    return res.json(data);
  } catch { return res.status(502).json({ error: 'YouTube APIに接続できません' }); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'APIがありません' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Cat Tube ready'));
module.exports = { app, cleanId, cleanQuery, cleanPageToken };
