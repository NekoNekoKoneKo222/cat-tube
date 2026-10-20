'use strict';

const DEFAULT_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si'
];

function normalizeInstance(value) {
  try {
    const url = new URL(String(value).trim());
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function instanceList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map(normalizeInstance).filter(Boolean))].slice(0, 12);
}

class InvidiousCluster {
  constructor(options = {}) {
    const urls = instanceList(options.instances || process.env.INVIDIOUS_INSTANCES || DEFAULT_INSTANCES);
    if (!urls.length) throw new Error('有効な Invidious サーバーが設定されていません');
    this.nodes = urls.map(url => ({
      url, failures: 0, blockedUntil: 0, latencyMs: null,
      apiStatus: 'unchecked', httpStatus: null, lastError: '',
      lastCheckedAt: null, lastSuccessAt: null,
      websiteStatus: 'unchecked', websiteLatencyMs: null, websiteHttpStatus: null
    }));
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.min(12000, Math.max(500, Number(options.timeoutMs || process.env.INVIDIOUS_TIMEOUT_MS || 4500)));
    this.cache = new Map();
    this.inFlight = new Map();
    this.probeInFlight = null;
    this.lastProbeAt = 0;
  }

  status() {
    const now = Date.now();
    return this.nodes.map(n => ({
      url: n.url,
      latencyMs: n.latencyMs,
      apiStatus: n.apiStatus,
      available: n.apiStatus === 'ok' && n.blockedUntil <= now,
      cooldownSeconds: Math.max(0, Math.ceil((n.blockedUntil - now) / 1000)),
      lastCheckedAt: n.lastCheckedAt,
      lastSuccessAt: n.lastSuccessAt,
      lastError: n.lastError,
      httpStatus: n.httpStatus,
      websiteStatus: n.websiteStatus,
      websiteLatencyMs: n.websiteLatencyMs,
      websiteHttpStatus: n.websiteHttpStatus
    }));
  }

  bestWebsite() {
    return this.nodes
      .filter(n => n.websiteStatus === 'ok')
      .sort((a, b) => a.websiteLatencyMs - b.websiteLatencyMs)[0]?.url || this.nodes[0].url;
  }

  async request(node, path, validator, shared = null) {
    const controller = new AbortController();
    if (shared) shared.controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const start = Date.now();
    let status = null;
    try {
      const response = await this.fetchImpl(node.url + path, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'CatTube/2.1' },
        redirect: 'error'
      });
      status = response.status;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (Number(response.headers?.get?.('content-length') || 0) > 2 * 1024 * 1024) throw new Error('応答データが大きすぎます');
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new Error('応答データが大きすぎます');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('JSON API が利用できません'); }
      if (!validator(data)) throw new Error('API の応答形式が不正です');
      const latencyMs = Date.now() - start;
      node.latencyMs = latencyMs;
      node.apiStatus = 'ok';
      node.httpStatus = status;
      node.lastError = '';
      node.lastCheckedAt = new Date().toISOString();
      node.lastSuccessAt = node.lastCheckedAt;
      node.blockedUntil = 0;
      node.failures = 0;
      return { data, instance: node.url, latencyMs, cached: false };
    } catch (e) {
      // Normal race cancellation should not mark an otherwise healthy node as failed.
      if (!(shared && shared.done && controller.signal.aborted)) {
        node.latencyMs = Date.now() - start;
        node.apiStatus = 'error';
        node.httpStatus = status;
        node.lastError = controller.signal.aborted ? 'タイムアウト' : String(e.message).slice(0, 160);
        node.lastCheckedAt = new Date().toISOString();
        node.failures++;
        node.blockedUntil = Date.now() + Math.min(60000, 5000 * (2 ** Math.min(node.failures - 1, 4)));
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  async probeWebsite(node) {
    const controller = new AbortController();
    const start = Date.now();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(node.url + '/', {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'CatTube/2.1' },
        redirect: 'manual'
      });
      node.websiteHttpStatus = response.status;
      node.websiteLatencyMs = Date.now() - start;
      node.websiteStatus = response.ok || (response.status >= 300 && response.status < 400) ? 'ok' : 'error';
    } catch {
      node.websiteStatus = 'error';
      node.websiteLatencyMs = Date.now() - start;
      node.websiteHttpStatus = null;
    } finally { clearTimeout(timer); }
  }

  // Runs the same kind of API request required for the video list.
  // A homepage responding 200 does NOT mean its API works.
  async probeAll({ force = false } = {}) {
    if (this.probeInFlight) return this.probeInFlight;
    if (!force && this.lastProbeAt && Date.now() - this.lastProbeAt < 30000) return this.status();
    const work = Promise.allSettled(this.nodes.map(async node => {
      await Promise.allSettled([
        this.request(node, '/api/v1/trending?region=JP', Array.isArray),
        this.probeWebsite(node)
      ]);
    }));
    this.probeInFlight = work.then(() => {
      this.lastProbeAt = Date.now();
      return this.status();
    }).finally(() => { this.probeInFlight = null; });
    return this.probeInFlight;
  }

  async get(path, validator, cacheMs = 45000) {
    if (!/^\/api\/v1\/[a-zA-Z0-9/?&=_%.+-]+$/.test(path)) throw new Error('不正な API パスです');
    const saved = this.cache.get(path);
    if (saved && saved.expires > Date.now()) return { ...saved.value, cached: true };
    if (this.inFlight.has(path)) return this.inFlight.get(path);
    const work = this.race(path, validator).then(result => {
      if (this.cache.size >= 120) this.cache.delete(this.cache.keys().next().value);
      if (cacheMs) this.cache.set(path, { value: result, expires: Date.now() + cacheMs });
      return result;
    }).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, work);
    return work;
  }

  async race(path, validator) {
    const now = Date.now();
    let candidates = this.nodes.filter(n => n.blockedUntil <= now);
    if (!candidates.length) {
      candidates = [this.nodes.slice().sort((a, b) => a.blockedUntil - b.blockedUntil)[0]];
    }
    const shared = { controllers: [], done: false };
    try {
      const winner = await Promise.any(candidates.map(n => this.request(n, path, validator, shared)));
      shared.done = true;
      shared.controllers.forEach(c => c.abort());
      return winner;
    } catch {
      throw new Error('利用可能な Invidious API がありません。公開サーバーで API が無効になっている可能性があります。');
    }
  }
}

module.exports = { InvidiousCluster, DEFAULT_INSTANCES, instanceList, normalizeInstance };
