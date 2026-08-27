import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import { google } from 'googleapis';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://yt3.ggpht.com'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      connectSrc: ["'self'", 'https:']
    }
  }
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
const oauth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
);
const OAUTH_SCOPES = ['openid', 'email', 'profile'];

async function db() {
  if (!existsSync(DB_FILE)) await writeFile(DB_FILE, JSON.stringify({ users: {}, playlists: {}, sessions: {} }, null, 2));
  return JSON.parse(await readFile(DB_FILE, 'utf8'));
}
async function saveDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'login_required' });
  next();
}
function normalizeVideo(item) {
  return {
    id: item.id?.videoId || item.id,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    channelId: item.snippet?.channelId || '',
    channelTitle: item.snippet?.channelTitle || '',
    publishedAt: item.snippet?.publishedAt || null,
    thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ''
  };
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'cat-tube' }));

app.get('/api/config', (req, res) => res.json({ youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY), oauthEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google OAuth is not configured.');
  const url = oauth.generateAuthUrl({ access_type: 'offline', scope: OAUTH_SCOPES, prompt: 'select_account' });
  res.redirect(url);
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth.getToken(req.query.code);
    oauth.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    const user = { id: data.id, email: data.email || '', name: data.name || 'Cat User', picture: data.picture || '' };
    const store = await db();
    store.users[user.id] = { ...store.users[user.id], ...user, updatedAt: new Date().toISOString() };
    await saveDb(store);
    req.session.user = user;
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('Google login failed. Check OAuth redirect URI and credentials.');
  }
});
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key is not configured.' });
  try {
    const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;
    const r = await youtube.search.list({ part: ['snippet'], q, type: ['video'], maxResults: 24, pageToken });
    res.json({ items: r.data.items.map(normalizeVideo), nextPageToken: r.data.nextPageToken || null });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(502).json({ error: 'YouTube search failed.' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key is not configured.' });
  try {
    const r = await youtube.videos.list({ part: ['snippet', 'contentDetails', 'statistics'], id: [req.params.id] });
    const v = r.data.items?.[0];
    if (!v) return res.status(404).json({ error: 'Video not found.' });
    res.json({
      id: v.id, title: v.snippet?.title, description: v.snippet?.description, channelId: v.snippet?.channelId,
      channelTitle: v.snippet?.channelTitle, publishedAt: v.snippet?.publishedAt, thumbnails: v.snippet?.thumbnails,
      duration: v.contentDetails?.duration || null, statistics: v.statistics || {}, embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?rel=0`
    });
  } catch (e) { res.status(502).json({ error: 'YouTube API request failed.' }); }
});

app.get('/api/channel/:id', async (req, res) => {
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key is not configured.' });
  try {
    const c = await youtube.channels.list({ part: ['snippet', 'statistics', 'brandingSettings'], id: [req.params.id] });
    const ch = c.data.items?.[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    let videos = [];
    if (uploads) {
      const r = await youtube.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId: uploads, maxResults: 24 });
      videos = (r.data.items || []).map(x => normalizeVideo({ id: x.contentDetails?.videoId, snippet: x.snippet }));
    }
    res.json({ id: ch.id, title: ch.snippet?.title, description: ch.snippet?.description, thumbnails: ch.snippet?.thumbnails, statistics: ch.statistics || {}, videos });
  } catch (e) { res.status(502).json({ error: 'YouTube channel request failed.' }); }
});

app.get('/api/yt-playlist/:id', async (req, res) => {
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key is not configured.' });
  try {
    const p = await youtube.playlists.list({ part: ['snippet', 'contentDetails'], id: [req.params.id] });
    const playlist = p.data.items?.[0];
    if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
    const r = await youtube.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId: req.params.id, maxResults: 50 });
    res.json({ id: playlist.id, title: playlist.snippet?.title, description: playlist.snippet?.description, thumbnails: playlist.snippet?.thumbnails, itemCount: playlist.contentDetails?.itemCount || 0, videos: (r.data.items || []).map(x => normalizeVideo({ id: x.contentDetails?.videoId, snippet: x.snippet })) });
  } catch (e) { res.status(502).json({ error: 'YouTube playlist request failed.' }); }
});

async function resolveYtUrl(videoId) {
  return await new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--no-warnings', '-f', 'best[ext=mp4][vcodec!=none][acodec!=none]/best', '-g', `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`];
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => reject(new Error(`yt-dlp could not start: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0 || !out.trim()) return reject(new Error(err.trim() || 'yt-dlp failed'));
      resolve(out.trim().split(/\r?\n/).pop());
    });
  });
}
const streamCache = new Map();
async function getStreamUrl(videoId) {
  const now = Date.now();
  const cached = streamCache.get(videoId);
  if (cached && cached.expires > now) return cached.url;
  const url = await resolveYtUrl(videoId);
  streamCache.set(videoId, { url, expires: now + 90_000 });
  return url;
}

app.get('/api/stream/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return res.status(400).send('Invalid video id.');
  try {
    const url = await getStreamUrl(id);
    const headers = { 'User-Agent': req.get('user-agent') || 'CatTube/1.0', 'Accept': req.get('accept') || '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).send('Upstream stream request failed.');
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(h); if (value) res.setHeader(h, value);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    console.error(e);
    res.status(502).send(`Direct stream unavailable: ${e.message}`);
  }
});

app.get('/api/download/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return res.status(400).send('Invalid video id.');
  // This endpoint is intentionally limited to single-item MP4 remux downloads.
  // Use only for videos you are authorized to download.
  try {
    const url = await getStreamUrl(id);
    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) return res.status(upstream.status).send('Download source unavailable.');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="cat-tube-${id}.mp4"`);
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) { res.status(502).send(`Download unavailable: ${e.message}`); }
});

app.get('/api/playlists', requireLogin, async (req, res) => {
  const store = await db();
  const mine = Object.values(store.playlists).filter(p => p.userId === req.session.user.id).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ playlists: mine });
});
app.post('/api/playlists', requireLogin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Playlist name is required.' });
  const id = crypto.randomUUID();
  const store = await db();
  store.playlists[id] = { id, userId: req.session.user.id, name, videos: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveDb(store); res.json(store.playlists[id]);
});
app.post('/api/playlists/:id/items', requireLogin, async (req, res) => {
  const video = req.body?.video;
  if (!video?.id) return res.status(400).json({ error: 'Video is required.' });
  const store = await db(); const p = store.playlists[req.params.id];
  if (!p || p.userId !== req.session.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  if (!p.videos.some(v => v.id === video.id)) p.videos.push({ id: video.id, title: video.title || '', thumbnail: video.thumbnail || '', channelTitle: video.channelTitle || '' });
  p.updatedAt = new Date().toISOString(); await saveDb(store); res.json(p);
});
app.delete('/api/playlists/:id/items/:videoId', requireLogin, async (req, res) => {
  const store = await db(); const p = store.playlists[req.params.id];
  if (!p || p.userId !== req.session.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  p.videos = p.videos.filter(v => v.id !== req.params.videoId); p.updatedAt = new Date().toISOString(); await saveDb(store); res.json(p);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Cat Tube running at http://localhost:${PORT}`));
