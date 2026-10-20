'use strict';

const DEFAULT_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com'
];

function normalizeInstance(value) {
  try {
    const url = new URL(String(value).trim());
    const localDev = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(localDev && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function instanceList(source) {
  const input = Array.isArray(source) ? source : String(source || '').split(',');
  return [...new Set(input.map(normalizeInstance).filter(Boolean))].slice(0, 12);
}

class InvidiousCluster {
  constructor(options = {}) {
    const urls = instanceList(options.instances || process.env.INVIDIOUS_INSTANCES || DEFAULT_INSTANCES);
    if (!urls.length) throw new Error('有効な Invidious サーバーが指定されていません。');
    this.nodes = urls.map(url => ({ url, failures: 0, blockedUntil: 0, latencyMs: null }));
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.max(500, Number(options.timeoutMs || process.env.INVIDIOUS_TIMEOUT_MS || 4500));
    this.cache = new Map();
    this.inFlight = new Map();
  }

  status() {
    const now = Date.now();
    return this.nodes.map(n => ({
      url: n.url,
      latencyMs: n.latencyMs,
      available: n.blockedUntil <= now,
      cooldownSeconds: Math.max(0, Math.ceil((n.blockedUntil - now) / 1000))
    }));
  }

  async get(path, validator, cacheMs = 45000) {
    const cached = this.cache.get(path);
    if (cached && cached.expires > Date.now()) {
      return { ...cached.value, cached: true };
    }
    if (this.inFlight.has(path)) return this.inFlight.get(path);
    const pending = this.race(path, validator).then(value => {
      if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value);
      if (cacheMs > 0) this.cache.set(path, { value, expires: Date.now() + cacheMs });
      return value;
    }).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, pending);
    return pending;
  }

  async race(path, validator) {
    if (!/^\/api\/v1\/[a-zA-Z0-9/?&=_%.+-]+$/.test(path)) {
      throw new Error('不正な API パスです');
    }
    const now = Date.now();
    let candidates = this.nodes.filter(n => n.blockedUntil <= now);
    // If all instances are cooling down, still try the one recovering soonest.
    if (!candidates.length) {
      candidates = [this.nodes.slice().sort((a, b) => a.blockedUntil - b.blockedUntil)[0]];
    }
    let winnerFound = false;
    const controllers = [];
    const attempts = candidates.map(async node => {
      const controller = new AbortController();
      controllers.push(controller);
      const started = Date.now();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(node.url + path, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'CatTube/2.0' },
          redirect: 'error'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const size = Number(response.headers?.get?.('content-length') || 0);
        if (size > 2 * 1024 * 1024) throw new Error('応答が大きすぎます');
        const raw = await response.text();
        if (raw.length > 2 * 1024 * 1024) throw new Error('応答が大きすぎます');
        const data = JSON.parse(raw);
        if (!validator(data)) throw new Error('応答形式が不正です');
        const latencyMs = Date.now() - started;
        node.latencyMs = latencyMs;
        node.failures = 0;
        node.blockedUntil = 0;
        return { data, instance: node.url, latencyMs, cached: false };
      } catch (error) {
        if (!(winnerFound && controller.signal.aborted)) {
          node.failures += 1;
          node.blockedUntil = Date.now() + Math.min(60000, 5000 * Math.pow(2, Math.min(node.failures - 1, 4)));
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    try {
      const result = await Promise.any(attempts);
      winnerFound = true;
      controllers.forEach(c => c.abort());
      return result;
    } catch {
      throw new Error('すべての Invidious サーバーが応答しませんでした。少し後に再試行してください。');
    }
  }
}

module.exports = { InvidiousCluster, DEFAULT_INSTANCES, normalizeInstance, instanceList };
