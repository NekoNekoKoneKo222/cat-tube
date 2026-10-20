'use strict';

const cheerio = require('cheerio');

const DEFAULT_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si'
];
const MAX_HTML = 3 * 1024 * 1024;
const MAX_FAILURE_WAIT = 60000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function normalizeInstance(value) {
  try {
    const url = new URL(String(value).trim());
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function instanceList(values) {
  const items = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(items.map(normalizeInstance).filter(Boolean))].slice(0, 12);
}

function videoIdFromHref(href) {
  if (!href || !href.startsWith('/watch?')) return '';
  try {
    const id = new URL(href, 'https://invidious.invalid').searchParams.get('v');
    return VIDEO_ID.test(id || '') ? id : '';
  } catch { return ''; }
}
function channelIdFromHref(href) {
  if (!href) return '';
  const found = href.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  return found ? found[1] : '';
}
function durationSeconds(text) {
  const raw = String(text || '').trim();
  if (!/^\d{1,3}(?::\d{1,2}){1,2}$/.test(raw)) return 0;
  return raw.split(':').reduce((n, part) => n * 60 + Number(part), 0);
}
function parseViews(text) {
  const raw = String(text || '');
  // Avoid fabricating counts when the locale uses an unsupported abbreviation.
  const match = raw.match(/([\d,.\s]+)\s*(?:views?|回視聴)/i);
  if (!match) return null;
  const count = Number(match[1].replace(/[,\s]/g, ''));
  return Number.isSafeInteger(count) ? count : null;
}

function parseListing(html, { allowEmpty = true } = {}) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const errorIndicators = $('.error-message, .error-page, .captcha, .cf-challenge, #challenge-form').length;
  if (errorIndicators || /(?:captcha|access denied|attention required|just a moment|error 5\d\d)/i.test(title)) {
    throw new Error('動画一覧の代わりにエラーページが返されました');
  }
  const cards = [];
  $('.pure-u-1.pure-u-md-1-4').each((_, element) => {
    const root = $(element);
    const links = root.find('a[href^="/watch?"]');
    let id = '';
    links.each((__, a) => { if (!id) id = videoIdFromHref($(a).attr('href')); });
    if (!id) {
      const channelAnchor = root.find('a[href^="/channel/"]').first();
      const channelId = channelIdFromHref(channelAnchor.attr('href'));
      if (channelId) cards.push({ type: 'channel', authorId: channelId, author: root.find('.channel-name').first().text().trim() || channelAnchor.text().trim() });
      return;
    }
    const titleLink = root.find('.video-card-row a[href^="/watch?"]').first();
    const videoTitle = titleLink.find('p').first().text().trim() || titleLink.text().trim() || root.find('img.thumbnail').attr('alt');
    if (!videoTitle) return;
    const authorAnchor = root.find('.video-card-row a[href^="/channel/"]').first();
    const authorId = channelIdFromHref(authorAnchor.attr('href'));
    const author = root.find('.channel-name').first().text().trim() || authorAnchor.text().trim();
    const length = durationSeconds(root.find('.bottom-right-overlay .length').first().text());
    const viewCount = parseViews(root.find('.video-data').last().text());
    cards.push({
      type: 'video', videoId: id, title: videoTitle,
      author: author || '', authorId: authorId || '',
      lengthSeconds: length, viewCount,
      published: null
    });
  });
  const hasListing = $('.pure-g').length && ($('.video-card-row').length || $('.no-results-error').length);
  if (!hasListing && !$('.no-results-error').length) {
    throw new Error('Invidious の動画一覧 HTML を確認できません');
  }
  if (cards.length === 0 && !allowEmpty && !$('.no-results-error').length) {
    throw new Error('検索結果に動画が含まれていません');
  }
  return cards;
}

function parseWatch(html, id) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content')?.trim() || '';
  let data = null;
  try { data = JSON.parse($('#video_data').first().html() || 'null'); } catch { /* malformed page */ }
  const hasPlayer = $('#player-container').length > 0 || $('video#player').length > 0;
  if (!VIDEO_ID.test(id) || !data || data.id !== id || !title || !hasPlayer) {
    throw new Error('再生可能な動画ページとして確認できません');
  }
  const authorId = channelIdFromHref($('a[href^="/channel/"]').first().attr('href'));
  const ogSite = $('meta[property="og:site_name"]').attr('content') || '';
  const author = $('.channel-name').first().text().trim()
    || ogSite.replace(/\s*\|\s*Invidious\s*$/, '')
    || $('a[href^="/channel/"]').first().text().trim();
  const recommendations = [];
  const used = new Set([id]);
  $('a[href^="/watch?"]').each((_, a) => {
    const suggestedId = videoIdFromHref($(a).attr('href'));
    if (!suggestedId || used.has(suggestedId)) return;
    const tile = $(a).closest('.pure-u-1');
    const suggestedTitle = tile.find('.video-card-row p').first().text().trim()
      || tile.find('p').first().text().trim() || $(a).text().trim();
    if (!suggestedTitle) return;
    used.add(suggestedId);
    recommendations.push({ type: 'video', videoId: suggestedId, title: suggestedTitle.slice(0, 300), author: tile.find('.channel-name').first().text().trim() });
  });
  return {
    videoId: id, title, author, authorId,
    description: $('meta[property="og:description"]').attr('content') || '',
    lengthSeconds: Number(data.length_seconds) || 0,
    viewCount: null, published: null, recommendedVideos: recommendations.slice(0, 24),
    formatStreams: []
  };
}

function parseChannel(html, id) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim();
  if (!CHANNEL_ID.test(id) || !title || !$('.pure-g').length) {
    throw new Error('チャンネルページの HTML を確認できません');
  }
  // Channel pages include a mixture of videos and channel widgets.
  return { author: title, authorId: id, latestVideos: parseListing(html) };
}

function htmlContainsPlayer(html, videoId) {
  const $ = cheerio.load(html);
  const videoData = $('#video_data').first().html();
  let data = {};
  try { data = JSON.parse(videoData || '{}'); } catch { return false; }
  return data.id === videoId && ($('#player').length > 0 || $('.video-js').length > 0);
}

class InvidiousCluster {
  constructor(options = {}) {
    const urls = instanceList(options.instances || process.env.INVIDIOUS_INSTANCES || DEFAULT_INSTANCES);
    if (!urls.length) throw new Error('有効な接続先がありません');
    this.nodes = urls.map(url => ({
      url, searchStatus: 'unchecked', videoStatus: 'unchecked',
      searchLatencyMs: null, videoLatencyMs: null,
      websiteStatus: 'unchecked', websiteLatencyMs: null,
      lastError: '', lastHttpStatus: null, checkedAt: null,
      blockedUntil: 0, failures: 0
    }));
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.min(15000, Math.max(750, Number(options.timeoutMs || process.env.INVIDIOUS_TIMEOUT_MS || 6500)));
    this.cache = new Map();
    this.inFlight = new Map();
    this.probeInFlight = null;
    this.lastProbeAt = 0;
  }

  status() {
    const now = Date.now();
    return this.nodes.map(n => ({
      url: n.url,
      searchStatus: n.searchStatus,
      videoStatus: n.videoStatus,
      searchLatencyMs: n.searchLatencyMs,
      videoLatencyMs: n.videoLatencyMs,
      latencyMs: n.searchLatencyMs,
      available: n.searchStatus === 'ok' && n.blockedUntil <= now,
      websiteStatus: n.websiteStatus,
      websiteLatencyMs: n.websiteLatencyMs,
      lastError: n.lastError,
      lastHttpStatus: n.lastHttpStatus,
      lastCheckedAt: n.checkedAt,
      cooldownSeconds: Math.max(0, Math.ceil((n.blockedUntil - now) / 1000))
    }));
  }

  async retrieve(node, page, parser, kind, shared) {
    const controller = new AbortController();
    if (shared) shared.controllers.push(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const start = Date.now();
    let status = null;
    try {
      const response = await this.fetchImpl(node.url + page, {
        signal: controller.signal, redirect: 'error',
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; CatTube/3.0)' }
      });
      status = response.status;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) throw new Error('HTML ではないレスポンス');
      if (Number(response.headers?.get?.('content-length') || 0) > MAX_HTML) throw new Error('HTML が大きすぎます');
      const html = await response.text();
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML) throw new Error('HTML が大きすぎます');
      const data = parser(html);
      const latencyMs = Date.now() - start;
      node[kind + 'Status'] = 'ok';
      node[kind + 'LatencyMs'] = latencyMs;
      node.websiteStatus = 'ok';
      node.websiteLatencyMs = latencyMs;
      node.lastError = '';
      node.lastHttpStatus = status;
      node.checkedAt = new Date().toISOString();
      node.blockedUntil = 0;
      node.failures = 0;
      return { data, instance: node.url, latencyMs, cached: false };
    } catch (error) {
      if (!(shared && shared.done && controller.signal.aborted)) {
        const latencyMs = Date.now() - start;
        node[kind + 'Status'] = 'error';
        node[kind + 'LatencyMs'] = latencyMs;
        node.lastHttpStatus = status;
        node.lastError = controller.signal.aborted ? '応答時間の上限を超えました' : String(error.message).slice(0, 140);
        node.checkedAt = new Date().toISOString();
        node.failures++;
        node.blockedUntil = Date.now() + Math.min(MAX_FAILURE_WAIT, 3000 * 2 ** Math.min(node.failures - 1, 5));
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async probeAll({ force = false } = {}) {
    if (this.probeInFlight) return this.probeInFlight;
    if (!force && this.lastProbeAt && Date.now() - this.lastProbeAt < 30000) return this.status();
    const work = Promise.allSettled(this.nodes.map(async node => {
      try { await this.retrieve(node, '/search?q=cats', html => parseListing(html), 'search'); }
      catch { /* Status records the failure. */ }
    }));
    this.probeInFlight = work.then(() => {
      this.lastProbeAt = Date.now();
      return this.status();
    }).finally(() => { this.probeInFlight = null; });
    return this.probeInFlight;
  }

  async get(page, parser, kind = 'search', cacheMs = 30000) {
    if (!/^\/(?:search\?|feed\/trending\?|watch\?|channel\/UC[A-Za-z0-9_-]{22}(?:\?|$))/.test(page) || page.includes('#')) {
      throw new Error('取得ページが不正です');
    }
    const key = kind + ':' + page;
    const saved = this.cache.get(key);
    if (saved && saved.expires > Date.now()) return { ...saved.value, cached: true };
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = this.race(page, parser, kind).then(result => {
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      if (cacheMs > 0) this.cache.set(key, { value: result, expires: Date.now() + cacheMs });
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async race(page, parser, kind) {
    let candidates = this.nodes.filter(n => n.blockedUntil <= Date.now());
    // Fail fast on normal failures, then retry the earliest cooling-down backend.
    if (!candidates.length) candidates = [this.nodes.slice().sort((a, b) => a.blockedUntil - b.blockedUntil)[0]];
    const shared = { controllers: [], done: false };
    try {
      const result = await Promise.any(candidates.map(n => this.retrieve(n, page, parser, kind, shared)));
      shared.done = true;
      shared.controllers.forEach(c => c.abort());
      return result;
    } catch {
      throw new Error('Invidious の通常ページから有効な結果を取得できませんでした。サーバーの検索ページまたは動画ページが利用できない可能性があります。');
    }
  }

  async getVideo(id) {
    return this.get('/watch?v=' + id, html => parseWatch(html, id), 'video', 20000);
  }

  videoServers() {
    return this.nodes.slice().sort((a, b) => {
      const aFail = a.videoStatus === 'error' ? 1 : 0, bFail = b.videoStatus === 'error' ? 1 : 0;
      return aFail - bFail || (a.videoLatencyMs ?? Infinity) - (b.videoLatencyMs ?? Infinity);
    }).map(n => n.url);
  }
}

module.exports = {
  DEFAULT_INSTANCES, InvidiousCluster, instanceList, normalizeInstance,
  parseListing, parseWatch, parseChannel, htmlContainsPlayer
};
